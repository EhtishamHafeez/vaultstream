import { execa } from "execa";
import type { Readable, Writable } from "node:stream";
import { MissingBinaryError, VaultstreamError, VersionMismatchError } from "./errors.js";
import { redactSecrets } from "./redact.js";

type PgBinary = "pg_dump" | "pg_restore" | "psql";

export async function checkBinaryAvailable(binary: PgBinary): Promise<string> {
  try {
    const result = await execa(binary, ["--version"]);
    return result.stdout.trim();
  } catch (error) {
    if (isEnoent(error)) throw new MissingBinaryError(binary);
    throw wrapExecaError(error, `Failed to run ${binary} --version.`);
  }
}

export async function getPgDumpVersionMajor(): Promise<number> {
  const result = await execa("pg_dump", ["--version"]);
  const match = /(\d+)(?:\.\d+)?/.exec(result.stdout);
  if (!match) {
    throw new VaultstreamError(`Could not parse pg_dump version from: "${result.stdout.trim()}"`);
  }
  return parseInt(match[1] as string, 10);
}

export async function getServerVersionMajor(dbUrl: string): Promise<number> {
  const result = await execa("psql", [dbUrl, "-tAc", "SHOW server_version_num"], { reject: false });
  if (result.failed) {
    throw new VaultstreamError(
      "Could not connect to the database to check its version.",
      redactSecrets(String(result.stderr ?? "")).trim() ||
        "Check that SUPABASE_DB_URL is correct and reachable."
    );
  }
  const versionNum = parseInt(result.stdout.trim(), 10);
  if (Number.isNaN(versionNum)) {
    throw new VaultstreamError(`Could not parse server_version_num from: "${result.stdout.trim()}"`);
  }
  return Math.floor(versionNum / 10000);
}

export async function assertVersionCompatibility(dbUrl: string, skip: boolean): Promise<void> {
  if (skip) return;
  const [clientMajor, serverMajor] = await Promise.all([getPgDumpVersionMajor(), getServerVersionMajor(dbUrl)]);
  if (clientMajor !== serverMajor) {
    throw new VersionMismatchError(String(clientMajor), String(serverMajor));
  }
}

export async function getTableCount(dbUrl: string, schemas: string[], excludeTables: string[] = []): Promise<number> {
  const schemaList = schemas.map((s) => `'${s.replace(/'/g, "''")}'`).join(",");
  const excludeList = excludeTables
    .map((t) => {
      const [schema, table] = t.split(".");
      return `('${(schema ?? "").replace(/'/g, "''")}', '${(table ?? "").replace(/'/g, "''")}')`;
    })
    .join(",");
  const query =
    `SELECT count(*) FROM information_schema.tables WHERE table_schema IN (${schemaList})` +
    (excludeList ? ` AND (table_schema, table_name) NOT IN (${excludeList})` : "");
  const result = await execa("psql", [dbUrl, "-tAc", query], { reject: false });
  if (result.failed) {
    throw new VaultstreamError(
      "Could not query table count.",
      redactSecrets(String(result.stderr ?? "")).trim()
    );
  }
  const count = parseInt(result.stdout.trim(), 10);
  return Number.isNaN(count) ? 0 : count;
}

export interface PgDumpHandle {
  stream: Readable;
  /** Resolves once pg_dump exits; rejects (with a redacted error) on non-zero exit. */
  done: Promise<void>;
  /** Kills the pg_dump process — call this if the write side fails or the run is aborted. */
  cancel: () => void;
}

export function runPgDump(dbUrl: string, schemas: string[], excludeTables: string[] = []): PgDumpHandle {
  // Explicit -n per schema — never dump the whole database. Supabase's
  // internal schemas (e.g. "realtime", with its daily partition tables)
  // aren't SELECT-able by the read-only backup role and aren't user data
  // anyway, so an unscoped pg_dump fails with "permission denied for schema".
  const schemaFlags = schemas.flatMap((schema) => ["-n", schema]);

  // Explicit -T per excluded table — even within a granted schema, a few
  // tables are the extension's own internal bookkeeping (not user data) and
  // on some projects aren't grantable to a restricted role at all, the same
  // way "realtime" isn't grantable at the schema level.
  const excludeTableFlags = excludeTables.flatMap((table) => ["-T", table]);

  const child = execa(
    "pg_dump",
    [dbUrl, "--format=custom", "--no-owner", "--no-privileges", ...schemaFlags, ...excludeTableFlags],
    {
      stdout: "pipe",
      stderr: "pipe",
      reject: false,
      // Never buffer stdout in memory — that's the multi-GB dump. stderr is
      // small (just error text) so it's fine to keep for error messages.
      buffer: { stdout: false, stderr: true },
    }
  );

  const stream = child.stdout as unknown as Readable;

  const done = (async () => {
    const result = await child;
    if (result.failed || result.exitCode !== 0) {
      if (result.isTerminated || result.signal) return; // killed on purpose via cancel()/abort
      throw new VaultstreamError(
        `pg_dump exited with code ${String(result.exitCode)}.`,
        redactSecrets(String(result.stderr ?? "")).trim() ||
          "Check that SUPABASE_DB_URL is correct and the role has SELECT privileges on the schemas you expect."
      );
    }
  })();

  return {
    stream,
    done,
    cancel: () => {
      child.kill();
    },
  };
}

export interface PgRestoreOptions {
  targetUrl: string;
  dumpStream: Readable;
}

export async function runPgRestore({ targetUrl, dumpStream }: PgRestoreOptions): Promise<void> {
  const child = execa("pg_restore", ["--no-owner", "--clean", "--if-exists", "-d", targetUrl], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    reject: false,
    buffer: { stdout: false, stderr: true },
  });

  const stdin = child.stdin as unknown as Writable;
  dumpStream.pipe(stdin);

  const result = await child;
  if (result.failed || result.exitCode !== 0) {
    throw new VaultstreamError(
      `pg_restore exited with code ${String(result.exitCode)}.`,
      redactSecrets(String(result.stderr ?? "")).trim()
    );
  }
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}

function wrapExecaError(error: unknown, message: string): VaultstreamError {
  const stderr = error && typeof error === "object" && "stderr" in error ? String((error as { stderr?: string }).stderr ?? "") : "";
  return new VaultstreamError(message, redactSecrets(stderr).trim() || undefined);
}
