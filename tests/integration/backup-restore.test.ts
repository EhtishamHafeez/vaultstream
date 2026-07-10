import { execa } from "execa";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI_PATH = path.join(REPO_ROOT, "dist", "cli.js");
const COMPOSE_FILE = path.join(REPO_ROOT, "docker-compose.test.yml");
const SEED_FILE = path.join(REPO_ROOT, "tests", "integration", "fixtures", "seed.sql");

const SOURCE_URL = "postgresql://postgres:postgres@localhost:55432/postgres";
const TARGET_URL = "postgresql://postgres:postgres@localhost:55433/postgres";
// The role vaultstream would actually use against a real Supabase project —
// granted only on public/auth/storage (see fixtures/seed.sql), NOT realtime.
const RESTRICTED_ROLE_URL = "postgresql://vaultstream_backup_test:test_password_only@localhost:55432/postgres";

const DEFAULT_SCHEMAS = ["public", "auth", "storage"];
const DEFAULT_EXCLUDE_TABLES = [
  "storage.migrations",
  "storage.s3_multipart_uploads",
  "storage.s3_multipart_uploads_parts",
];
const TABLES = ["customers", "orders", "notes", "auth.users", "storage.objects"] as const;

async function waitForPostgres(url: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const result = await execa("psql", [url, "-tAc", "SELECT 1"], { reject: false });
    if (!result.failed) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Postgres at ${url} did not become ready within ${timeoutMs}ms.\n${result.stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function runSql(url: string, query: string): Promise<string> {
  const result = await execa("psql", [url, "-tAc", query]);
  return result.stdout.trim();
}

async function runSqlFile(url: string, file: string): Promise<void> {
  await execa("psql", [url, "-f", file]);
}

async function getRowCounts(url: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    const count = await runSql(url, `SELECT count(*) FROM ${table}`);
    counts[table] = parseInt(count, 10);
  }
  return counts;
}

async function getTableCount(
  url: string,
  schemas: readonly string[] = DEFAULT_SCHEMAS,
  excludeTables: readonly string[] = DEFAULT_EXCLUDE_TABLES
): Promise<number> {
  const schemaList = schemas.map((s) => `'${s}'`).join(",");
  const excludeList = excludeTables
    .map((t) => {
      const [schema, table] = t.split(".");
      return `('${schema}','${table}')`;
    })
    .join(",");
  const query =
    `SELECT count(*) FROM information_schema.tables WHERE table_schema IN (${schemaList})` +
    (excludeList ? ` AND (table_schema, table_name) NOT IN (${excludeList})` : "");
  const count = await runSql(url, query);
  return parseInt(count, 10);
}

async function schemaExists(url: string, schema: string): Promise<boolean> {
  const count = await runSql(url, `SELECT count(*) FROM information_schema.schemata WHERE schema_name = '${schema}'`);
  return parseInt(count, 10) > 0;
}

async function tableExists(url: string, schema: string, table: string): Promise<boolean> {
  const count = await runSql(
    url,
    `SELECT count(*) FROM information_schema.tables WHERE table_schema = '${schema}' AND table_name = '${table}'`
  );
  return parseInt(count, 10) > 0;
}

describe("backup -> restore round trip (requires Docker)", () => {
  let tmpDir: string;

  beforeAll(async () => {
    await execa("docker", ["compose", "-f", COMPOSE_FILE, "up", "-d"]);
    await waitForPostgres(SOURCE_URL);
    await waitForPostgres(TARGET_URL);
    await runSqlFile(SOURCE_URL, SEED_FILE);
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "vaultstream-integration-"));
  }, 120_000);

  afterAll(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
    await execa("docker", ["compose", "-f", COMPOSE_FILE, "down", "-v"], { reject: false });
  }, 60_000);

  it("backs up the source database and restores it into a second database with matching tables/rows", async () => {
    const sourceCounts = await getRowCounts(SOURCE_URL);
    const sourceTableCount = await getTableCount(SOURCE_URL);
    expect(sourceCounts.customers).toBe(3);
    expect(sourceCounts.orders).toBe(4);
    expect(sourceCounts.notes).toBe(5);
    expect(sourceCounts["auth.users"]).toBe(2);
    expect(sourceCounts["storage.objects"]).toBe(3);
    // customers, orders, notes, auth.users, storage.objects — never realtime.messages,
    // which isn't in the default schema list.
    expect(sourceTableCount).toBe(5);

    const backupResult = await execa(
      "node",
      [CLI_PATH, "backup", "--db-only", "--dest", tmpDir, "--json"],
      { env: { ...process.env, SUPABASE_DB_URL: SOURCE_URL } }
    );
    expect(backupResult.exitCode).toBe(0);
    const backupJson = JSON.parse(backupResult.stdout) as { ok: boolean; database?: { tableCount: number } };
    expect(backupJson.ok).toBe(true);
    expect(backupJson.database?.tableCount).toBe(sourceTableCount);

    const restoreResult = await execa(
      "node",
      [CLI_PATH, "restore", "latest", "--target", TARGET_URL, "--yes", "--dest", tmpDir, "--json"],
      { env: { ...process.env, SUPABASE_DB_URL: SOURCE_URL } }
    );
    expect(restoreResult.exitCode).toBe(0);

    const targetCounts = await getRowCounts(TARGET_URL);
    const targetTableCount = await getTableCount(TARGET_URL);

    expect(targetCounts).toEqual(sourceCounts);
    expect(targetTableCount).toBe(sourceTableCount);
  });

  it("a restricted read-only role backs up public/auth/storage without touching realtime", async () => {
    // This is the regression test for the real bug: pg_dump used to dump the
    // whole database and fail with "permission denied for schema realtime"
    // because the read-only role has no grant there. Scoping to explicit
    // schemas (the default here) means it's never even requested.
    const restrictedTmpDir = await mkdtemp(path.join(os.tmpdir(), "vaultstream-integration-restricted-"));

    try {
      const backupResult = await execa(
        "node",
        [CLI_PATH, "backup", "--db-only", "--dest", restrictedTmpDir, "--json"],
        { env: { ...process.env, SUPABASE_DB_URL: RESTRICTED_ROLE_URL } }
      );
      expect(backupResult.exitCode).toBe(0);
      const backupJson = JSON.parse(backupResult.stdout) as { ok: boolean; database?: { tableCount: number } };
      expect(backupJson.ok).toBe(true);
      expect(backupJson.database?.tableCount).toBe(5);

      const restoreResult = await execa(
        "node",
        [CLI_PATH, "restore", "latest", "--target", TARGET_URL, "--yes", "--dest", restrictedTmpDir, "--json"],
        { env: { ...process.env, SUPABASE_DB_URL: RESTRICTED_ROLE_URL } }
      );
      expect(restoreResult.exitCode).toBe(0);

      expect(await getTableCount(TARGET_URL)).toBe(5);
      expect(await schemaExists(TARGET_URL, "realtime")).toBe(false);
      // storage.migrations exists in the source (see fixtures/seed.sql) and the
      // restricted role has no SELECT on it — proving the default excludeTables
      // let the backup succeed anyway, and that it was never restored.
      expect(await tableExists(TARGET_URL, "storage", "migrations")).toBe(false);
    } finally {
      await rm(restrictedTmpDir, { recursive: true, force: true });
    }
  });

  it("surfaces pg_dump's real permission error when --schemas includes one the role can't read", async () => {
    const failTmpDir = await mkdtemp(path.join(os.tmpdir(), "vaultstream-integration-permfail-"));

    try {
      const result = await execa(
        "node",
        [
          CLI_PATH,
          "backup",
          "--db-only",
          "--dest",
          failTmpDir,
          "--schemas",
          "public,auth,storage,realtime",
          "--json",
        ],
        { env: { ...process.env, SUPABASE_DB_URL: RESTRICTED_ROLE_URL }, reject: false }
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/permission denied/i);
    } finally {
      await rm(failTmpDir, { recursive: true, force: true });
    }
  });

  it("refuses to restore onto the source URL without --force", async () => {
    const result = await execa(
      "node",
      [CLI_PATH, "restore", "latest", "--target", SOURCE_URL, "--yes", "--dest", tmpDir, "--json"],
      { env: { ...process.env, SUPABASE_DB_URL: SOURCE_URL }, reject: false }
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/source database/i);
  });
});
