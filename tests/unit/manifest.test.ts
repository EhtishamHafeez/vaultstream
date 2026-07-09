import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalDestinationDriver } from "../../src/lib/destination/local.js";
import {
  buildPreviousManifestIndex,
  listManifests,
  readManifest,
  toStorageFileRecords,
  writeManifest,
  type BackupManifest,
} from "../../src/lib/manifest.js";

function sampleManifest(overrides: Partial<BackupManifest> = {}): BackupManifest {
  return {
    version: "0.1.0",
    createdAt: new Date().toISOString(),
    durationMs: 1234,
    database: { key: "db/backup-x.dump.gz", sizeBytes: 100, sha256: "abc123", tableCount: 3, encrypted: false },
    ...overrides,
  };
}

describe("manifest", () => {
  let tmpDir: string;
  let destination: LocalDestinationDriver;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "vaultstream-manifest-"));
    destination = new LocalDestinationDriver({ type: "local", path: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes and reads a manifest round-trip", async () => {
    const manifest = sampleManifest();
    const key = await writeManifest(destination, "2026-01-01T00-00-00.000Z", manifest);

    expect(key).toBe("manifests/2026-01-01T00-00-00.000Z.json");
    const readBack = await readManifest(destination, key);
    expect(readBack).toEqual(manifest);
  });

  it("lists manifests newest first", async () => {
    await writeManifest(destination, "2026-01-01T00-00-00.000Z", sampleManifest());
    await writeManifest(destination, "2026-01-03T00-00-00.000Z", sampleManifest());
    await writeManifest(destination, "2026-01-02T00-00-00.000Z", sampleManifest());

    const listed = await listManifests(destination);
    expect(listed.map((m) => m.timestamp)).toEqual([
      "2026-01-03T00-00-00.000Z",
      "2026-01-02T00-00-00.000Z",
      "2026-01-01T00-00-00.000Z",
    ]);
  });

  it("returns an empty list when there are no backups yet", async () => {
    expect(await listManifests(destination)).toEqual([]);
  });

  it("builds a previous-manifest index keyed by bucket/path", () => {
    const manifest = sampleManifest({
      storage: {
        buckets: { avatars: { fileCount: 2, totalBytes: 300 } },
        totalFiles: 2,
        totalBytes: 300,
        newFiles: 2,
        updatedFiles: 0,
        skippedFiles: 0,
        files: [
          { bucket: "avatars", path: "a.png", size: 100, updatedAt: "2026-01-01T00:00:00Z" },
          { bucket: "avatars", path: "b.png", size: 200, updatedAt: "2026-01-01T00:00:00Z" },
        ],
      },
    });

    const index = buildPreviousManifestIndex(manifest);
    expect(index.size).toBe(2);
    expect(index.get("avatars/a.png")).toEqual({ size: 100, updatedAt: "2026-01-01T00:00:00Z" });
    expect(index.get("avatars/b.png")).toEqual({ size: 200, updatedAt: "2026-01-01T00:00:00Z" });
    expect(index.get("avatars/missing.png")).toBeUndefined();
  });

  it("returns an empty index when there is no prior manifest or no storage section", () => {
    expect(buildPreviousManifestIndex(null).size).toBe(0);
    expect(buildPreviousManifestIndex(sampleManifest()).size).toBe(0);
  });

  it("maps StorageObjectEntry[] to manifest file records 1:1", () => {
    const records = toStorageFileRecords([
      { bucket: "avatars", path: "a.png", size: 10, updatedAt: null },
      { bucket: "avatars", path: "b.png", size: 20, updatedAt: "2026-01-01T00:00:00Z" },
    ]);
    expect(records).toEqual([
      { bucket: "avatars", path: "a.png", size: 10, updatedAt: null },
      { bucket: "avatars", path: "b.png", size: 20, updatedAt: "2026-01-01T00:00:00Z" },
    ]);
  });
});
