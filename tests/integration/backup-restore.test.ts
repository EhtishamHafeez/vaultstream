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

const TABLES = ["customers", "orders", "notes"] as const;

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

async function getTableCount(url: string): Promise<number> {
  const count = await runSql(
    url,
    "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')"
  );
  return parseInt(count, 10);
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
