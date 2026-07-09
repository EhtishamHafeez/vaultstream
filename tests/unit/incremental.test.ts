import type { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DestinationDriver, WriteResult } from "../../src/lib/destination/index.js";
import { buildPreviousManifestIndex } from "../../src/lib/manifest.js";
import { backupStorage } from "../../src/lib/storage.js";

interface FakeFile {
  name: string;
  content: string;
  updatedAt: string;
}

function createFakeSupabase(bucketFiles: Record<string, FakeFile[]>): SupabaseClient {
  return {
    storage: {
      from(bucket: string) {
        return {
          async list(prefix: string, opts: { limit: number; offset: number }) {
            if (prefix !== "") return { data: [], error: null };
            const entries = bucketFiles[bucket] ?? [];
            const page = entries.slice(opts.offset, opts.offset + opts.limit).map((f) => ({
              name: f.name,
              id: "fake-id", // non-null => file, not a folder
              updated_at: f.updatedAt,
              metadata: { size: Buffer.byteLength(f.content) },
            }));
            return { data: page, error: null };
          },
          async download(filePath: string) {
            const entry = (bucketFiles[bucket] ?? []).find((f) => f.name === filePath);
            if (!entry) return { data: null, error: { message: "not found" } };
            return { data: new Blob([entry.content]), error: null };
          },
        };
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as SupabaseClient;
}

class MemoryDestination implements DestinationDriver {
  readonly describe = "memory://test";
  readonly written = new Map<string, Buffer>();

  async writeStream(key: string, stream: Readable): Promise<WriteResult> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    const buf = Buffer.concat(chunks);
    this.written.set(key, buf);
    return { bytes: buf.length };
  }

  readStream(): Promise<Readable> {
    throw new Error("not implemented in test double");
  }

  async writeText(key: string, content: string): Promise<void> {
    this.written.set(key, Buffer.from(content));
  }

  async readText(key: string): Promise<string> {
    const buf = this.written.get(key);
    if (!buf) throw new Error(`missing key: ${key}`);
    return buf.toString("utf8");
  }

  async list(): Promise<string[]> {
    return [...this.written.keys()];
  }

  async exists(key: string): Promise<boolean> {
    return this.written.has(key);
  }

  async delete(key: string): Promise<void> {
    this.written.delete(key);
  }
}

describe("incremental storage backup skip logic", () => {
  it("downloads new files, re-downloads changed files, and skips files matching the previous manifest", async () => {
    const supabase = createFakeSupabase({
      avatars: [
        { name: "a.png", content: "AAAA", updatedAt: "2026-01-01T00:00:00Z" }, // unchanged from previous
        { name: "b.png", content: "BBBBBB", updatedAt: "2026-01-01T00:00:00Z" }, // size changed vs previous
        { name: "c.png", content: "CCC", updatedAt: "2026-01-01T00:00:00Z" }, // new file
      ],
    });

    const previousManifest = buildPreviousManifestIndex({
      version: "0.1.0",
      createdAt: "2025-12-31T00:00:00Z",
      durationMs: 0,
      storage: {
        buckets: {},
        totalFiles: 2,
        totalBytes: 0,
        newFiles: 0,
        updatedFiles: 0,
        skippedFiles: 0,
        files: [
          { bucket: "avatars", path: "a.png", size: 4, updatedAt: "2026-01-01T00:00:00Z" },
          { bucket: "avatars", path: "b.png", size: 3, updatedAt: "2026-01-01T00:00:00Z" }, // was 3 bytes, now 6
        ],
      },
    });

    const destination = new MemoryDestination();
    const result = await backupStorage({
      supabase,
      destination,
      buckets: ["avatars"],
      previousManifest,
      concurrency: 2,
    });

    expect(result.totalFiles).toBe(3);
    expect(result.newFiles).toBe(1);
    expect(result.updatedFiles).toBe(1);
    expect(result.skippedFiles).toBe(1);

    expect(destination.written.has("storage/avatars/a.png")).toBe(false); // skipped — never downloaded
    expect(destination.written.get("storage/avatars/b.png")?.toString("utf8")).toBe("BBBBBB");
    expect(destination.written.get("storage/avatars/c.png")?.toString("utf8")).toBe("CCC");
  });

  it("treats a changed updatedAt (same size) as changed too", async () => {
    const supabase = createFakeSupabase({
      docs: [{ name: "readme.txt", content: "hello", updatedAt: "2026-02-01T00:00:00Z" }],
    });

    const previousManifest = buildPreviousManifestIndex({
      version: "0.1.0",
      createdAt: "2026-01-01T00:00:00Z",
      durationMs: 0,
      storage: {
        buckets: {},
        totalFiles: 1,
        totalBytes: 0,
        newFiles: 0,
        updatedFiles: 0,
        skippedFiles: 0,
        files: [{ bucket: "docs", path: "readme.txt", size: 5, updatedAt: "2026-01-01T00:00:00Z" }],
      },
    });

    const destination = new MemoryDestination();
    const result = await backupStorage({ supabase, destination, buckets: ["docs"], previousManifest });

    expect(result.updatedFiles).toBe(1);
    expect(result.skippedFiles).toBe(0);
  });

  it("downloads everything on a first run with no previous manifest", async () => {
    const supabase = createFakeSupabase({
      avatars: [
        { name: "a.png", content: "AAAA", updatedAt: "2026-01-01T00:00:00Z" },
        { name: "b.png", content: "BBBBBB", updatedAt: "2026-01-01T00:00:00Z" },
      ],
    });

    const destination = new MemoryDestination();
    const result = await backupStorage({
      supabase,
      destination,
      buckets: ["avatars"],
      previousManifest: buildPreviousManifestIndex(null),
    });

    expect(result.newFiles).toBe(2);
    expect(result.skippedFiles).toBe(0);
  });
});
