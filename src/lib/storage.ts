import type { SupabaseClient } from "@supabase/supabase-js";
import { Readable } from "node:stream";
import type { DestinationDriver } from "./destination/index.js";
import { VaultstreamError } from "./errors.js";

export interface StorageObjectEntry {
  bucket: string;
  path: string;
  size: number;
  updatedAt: string | null;
}

export interface PreviousManifestEntry {
  size: number;
  updatedAt: string | null;
}

export type PreviousManifestIndex = Map<string, PreviousManifestEntry>;

export function objectKey(bucket: string, path: string): string {
  return `${bucket}/${path}`;
}

export async function listBuckets(supabase: SupabaseClient): Promise<string[]> {
  const { data, error } = await supabase.storage.listBuckets();
  if (error) throw new VaultstreamError("Failed to list storage buckets.", error.message);
  return (data ?? []).map((bucket) => bucket.name);
}

const LIST_PAGE_SIZE = 1000;

export async function listBucketObjects(supabase: SupabaseClient, bucket: string): Promise<StorageObjectEntry[]> {
  const results: StorageObjectEntry[] = [];

  async function walk(prefix: string): Promise<void> {
    let offset = 0;
    for (;;) {
      const { data, error } = await supabase.storage.from(bucket).list(prefix, {
        limit: LIST_PAGE_SIZE,
        offset,
        sortBy: { column: "name", order: "asc" },
      });

      if (error) {
        throw new VaultstreamError(
          `Failed to list objects in bucket "${bucket}"${prefix ? ` at "${prefix}"` : ""}.`,
          error.message
        );
      }

      const entries = data ?? [];
      for (const entry of entries) {
        const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        // Supabase Storage's list() API represents folders as entries with id: null.
        const isFolder = entry.id === null;
        if (isFolder) {
          await walk(fullPath);
        } else {
          results.push({
            bucket,
            path: fullPath,
            size: (entry.metadata as { size?: number } | null)?.size ?? 0,
            updatedAt: entry.updated_at ?? null,
          });
        }
      }

      if (entries.length < LIST_PAGE_SIZE) break;
      offset += LIST_PAGE_SIZE;
    }
  }

  await walk("");
  return results;
}

/** Small self-invoking worker pool — no external dependency needed for concurrency=5. */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  let cursor = 0;

  async function runNext(): Promise<void> {
    const current = cursor++;
    if (current >= items.length) return;
    await worker(items[current] as T, current);
    await runNext();
  }

  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => runNext());
  await Promise.all(runners);
}

export interface StorageBackupParams {
  supabase: SupabaseClient;
  destination: DestinationDriver;
  buckets: string[];
  previousManifest: PreviousManifestIndex;
  concurrency?: number;
  signal?: AbortSignal;
  onFileDone?: (entry: StorageObjectEntry, status: "new" | "updated" | "skipped") => void;
}

export interface StorageBackupResult {
  totalFiles: number;
  newFiles: number;
  updatedFiles: number;
  skippedFiles: number;
  totalBytes: number;
  perBucket: Record<string, { fileCount: number; totalBytes: number }>;
  /** Every file entry seen this run — persisted in the manifest to power the next run's incremental skip. */
  files: StorageObjectEntry[];
}

export async function backupStorage({
  supabase,
  destination,
  buckets,
  previousManifest,
  concurrency = 5,
  signal,
  onFileDone,
}: StorageBackupParams): Promise<StorageBackupResult> {
  const result: StorageBackupResult = {
    totalFiles: 0,
    newFiles: 0,
    updatedFiles: 0,
    skippedFiles: 0,
    totalBytes: 0,
    perBucket: {},
    files: [],
  };

  for (const bucket of buckets) {
    const entries = await listBucketObjects(supabase, bucket);
    result.perBucket[bucket] = { fileCount: 0, totalBytes: 0 };
    result.files.push(...entries);

    await runWithConcurrency(entries, concurrency, async (entry) => {
      if (signal?.aborted) return;

      // Every file currently in the bucket counts toward the "synced"
      // totals, whether or not it needed re-downloading this run.
      result.totalFiles++;
      result.totalBytes += entry.size;
      const bucketStats = result.perBucket[entry.bucket];
      if (bucketStats) {
        bucketStats.fileCount++;
        bucketStats.totalBytes += entry.size;
      }

      const previous = previousManifest.get(objectKey(entry.bucket, entry.path));
      const unchanged = previous && previous.size === entry.size && previous.updatedAt === entry.updatedAt;

      if (unchanged) {
        result.skippedFiles++;
        onFileDone?.(entry, "skipped");
        return;
      }

      const { data, error } = await supabase.storage.from(entry.bucket).download(entry.path);
      if (error || !data) {
        throw new VaultstreamError(
          `Failed to download "${entry.bucket}/${entry.path}".`,
          error?.message
        );
      }

      const nodeStream = Readable.fromWeb(
        data.stream() as unknown as import("node:stream/web").ReadableStream<Uint8Array>
      );
      await destination.writeStream(`storage/${entry.bucket}/${entry.path}`, nodeStream, { signal });

      if (previous) {
        result.updatedFiles++;
        onFileDone?.(entry, "updated");
      } else {
        result.newFiles++;
        onFileDone?.(entry, "new");
      }
    });
  }

  return result;
}
