import path from "node:path";
import type { DestinationDriver } from "./destination/index.js";
import type { PreviousManifestIndex, StorageObjectEntry } from "./storage.js";
import { objectKey } from "./storage.js";

export interface DatabaseManifestEntry {
  key: string;
  sizeBytes: number;
  sha256: string;
  tableCount: number;
  encrypted: boolean;
}

export interface StorageManifestSummary {
  buckets: Record<string, { fileCount: number; totalBytes: number }>;
  totalFiles: number;
  totalBytes: number;
  newFiles: number;
  updatedFiles: number;
  skippedFiles: number;
  /** Per-file size + updatedAt, used to compute incremental skips on the next run. */
  files: StorageFileRecord[];
}

export interface StorageFileRecord {
  bucket: string;
  path: string;
  size: number;
  updatedAt: string | null;
}

export interface BackupManifest {
  version: string;
  createdAt: string;
  durationMs: number;
  database?: DatabaseManifestEntry;
  storage?: StorageManifestSummary;
}

export const MANIFEST_PREFIX = "manifests";

export function manifestKey(timestamp: string): string {
  return `${MANIFEST_PREFIX}/${timestamp}.json`;
}

export async function writeManifest(
  destination: DestinationDriver,
  timestamp: string,
  manifest: BackupManifest
): Promise<string> {
  const key = manifestKey(timestamp);
  await destination.writeText(key, JSON.stringify(manifest, null, 2));
  return key;
}

export async function readManifest(destination: DestinationDriver, key: string): Promise<BackupManifest> {
  const text = await destination.readText(key);
  return JSON.parse(text) as BackupManifest;
}

export interface ManifestListing {
  key: string;
  timestamp: string;
}

/** Newest first — ISO-8601 timestamps sort lexicographically. */
export async function listManifests(destination: DestinationDriver): Promise<ManifestListing[]> {
  const keys = await destination.list(MANIFEST_PREFIX);
  return keys
    .filter((key) => key.endsWith(".json"))
    .map((key) => ({ key, timestamp: path.basename(key, ".json") }))
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
}

export async function getLatestManifest(destination: DestinationDriver): Promise<BackupManifest | null> {
  const manifests = await listManifests(destination);
  const latest = manifests[0];
  if (!latest) return null;
  return readManifest(destination, latest.key);
}

export function buildPreviousManifestIndex(manifest: BackupManifest | null): PreviousManifestIndex {
  const index: PreviousManifestIndex = new Map();
  if (!manifest?.storage) return index;
  for (const file of manifest.storage.files) {
    index.set(objectKey(file.bucket, file.path), { size: file.size, updatedAt: file.updatedAt });
  }
  return index;
}

export function toStorageFileRecords(entries: readonly StorageObjectEntry[]): StorageFileRecord[] {
  return entries.map((entry) => ({
    bucket: entry.bucket,
    path: entry.path,
    size: entry.size,
    updatedAt: entry.updatedAt,
  }));
}
