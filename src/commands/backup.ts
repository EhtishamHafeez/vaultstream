import zlib from "node:zlib";
import { loadFileConfig, resolveConfig } from "../lib/config.js";
import { createDestinationDriver, type DestinationDriver } from "../lib/destination/index.js";
import { assertVersionCompatibility, checkBinaryAvailable, getTableCount, runPgDump } from "../lib/database.js";
import { createEncryptStream } from "../lib/encryption.js";
import { ConfigError } from "../lib/errors.js";
import { HashPassThrough } from "../lib/hash-stream.js";
import { formatBytes, formatDuration, Logger } from "../lib/logger.js";
import {
  buildPreviousManifestIndex,
  getLatestManifest,
  toStorageFileRecords,
  writeManifest,
  type BackupManifest,
  type DatabaseManifestEntry,
} from "../lib/manifest.js";
import { createSupabaseAdminClient } from "../lib/supabase-client.js";
import { backupStorage, listBuckets, listBucketObjects, objectKey, type StorageBackupResult } from "../lib/storage.js";
import { backupTimestamp } from "../lib/timestamp.js";
import { chainStreams } from "../lib/stream-utils.js";
import { getCliVersion } from "../lib/version.js";

export interface BackupCommandOptions {
  dbOnly?: boolean;
  storageOnly?: boolean;
  dest?: string;
  schemas?: string;
  dryRun?: boolean;
  json?: boolean;
  noVersionCheck?: boolean;
}

export async function backupCommand(opts: BackupCommandOptions): Promise<void> {
  const startedAt = Date.now();
  const logger = new Logger(Boolean(opts.json));

  if (opts.dbOnly && opts.storageOnly) {
    throw new ConfigError("--db-only and --storage-only cannot be used together.");
  }

  const fileConfig = await loadFileConfig(process.cwd());
  const config = resolveConfig({ fileConfig, destFlag: opts.dest, schemasFlag: opts.schemas });
  const destination = createDestinationDriver(config.destination);

  const doDb = !opts.storageOnly;
  const doStorage = !opts.dbOnly;

  if (doDb && !config.dbUrl) {
    throw new ConfigError(
      "SUPABASE_DB_URL is not set.",
      "Set it as an environment variable, or run with --storage-only to skip the database backup."
    );
  }

  if (opts.storageOnly && !(config.supabaseUrl && config.supabaseServiceRoleKey)) {
    throw new ConfigError(
      "--storage-only requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to be set."
    );
  }

  const timestamp = backupTimestamp();
  const controller = new AbortController();
  const onSigint = () => {
    logger.warn("Interrupted — aborting cleanly (no orphaned uploads left behind)...");
    controller.abort();
  };
  process.once("SIGINT", onSigint);

  try {
    let databaseEntry: DatabaseManifestEntry | undefined;
    let storageResult: StorageBackupResult | undefined;

    if (doDb && config.dbUrl) {
      databaseEntry = await runDatabaseBackupStep({
        dbUrl: config.dbUrl,
        schemas: config.schemas,
        destination,
        timestamp,
        encryptionKey: config.encryptionKey,
        dryRun: Boolean(opts.dryRun),
        skipVersionCheck: Boolean(opts.noVersionCheck),
        logger,
        signal: controller.signal,
      });
    }

    const wantsStorage = doStorage && Boolean(config.supabaseUrl && config.supabaseServiceRoleKey);
    if (wantsStorage && config.supabaseUrl && config.supabaseServiceRoleKey) {
      storageResult = await runStorageBackupStep({
        supabaseUrl: config.supabaseUrl,
        serviceRoleKey: config.supabaseServiceRoleKey,
        destination,
        dryRun: Boolean(opts.dryRun),
        logger,
        signal: controller.signal,
      });
    } else if (doStorage) {
      logger.info("Skipping storage backup — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.");
    }

    if (!opts.dryRun) {
      const manifest: BackupManifest = {
        version: getCliVersion(),
        createdAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        database: databaseEntry,
        storage: storageResult
          ? {
              buckets: storageResult.perBucket,
              totalFiles: storageResult.totalFiles,
              totalBytes: storageResult.totalBytes,
              newFiles: storageResult.newFiles,
              updatedFiles: storageResult.updatedFiles,
              skippedFiles: storageResult.skippedFiles,
              files: toStorageFileRecords(storageResult.files),
            }
          : undefined,
      };

      await writeManifest(destination, timestamp, manifest);
      logger.success(`manifest written — ${databaseEntry?.tableCount ?? 0} tables, sha256 verified`);
    } else {
      logger.info("[dry-run] no manifest written, no files uploaded.");
    }

    logger.flushJson({
      ok: true,
      durationMs: Date.now() - startedAt,
      database: databaseEntry,
      storage: storageResult,
    });
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

interface DatabaseStepParams {
  dbUrl: string;
  schemas: string[];
  destination: DestinationDriver;
  timestamp: string;
  encryptionKey: Buffer | undefined;
  dryRun: boolean;
  skipVersionCheck: boolean;
  logger: Logger;
  signal: AbortSignal;
}

async function runDatabaseBackupStep(params: DatabaseStepParams): Promise<DatabaseManifestEntry> {
  const { dbUrl, schemas, destination, timestamp, encryptionKey, dryRun, skipVersionCheck, logger, signal } = params;

  await checkBinaryAvailable("pg_dump");
  await assertVersionCompatibility(dbUrl, skipVersionCheck);

  const tableCountPromise = getTableCount(dbUrl, schemas);
  const key = `db/backup-${timestamp}.dump.gz${encryptionKey ? ".enc" : ""}`;

  if (dryRun) {
    const tableCount = await tableCountPromise;
    logger.info(`[dry-run] would stream pg_dump (schemas: ${schemas.join(", ")}) to ${destination.describe}/${key}`);
    return { key, sizeBytes: 0, sha256: "", tableCount, encrypted: Boolean(encryptionKey) };
  }

  const dumpStart = Date.now();
  const { stream: dumpStream, done: dumpDone, cancel } = runPgDump(dbUrl, schemas);

  const gzip = zlib.createGzip();
  const hasher = new HashPassThrough();
  const chain = encryptionKey
    ? chainStreams(dumpStream, gzip, createEncryptStream(encryptionKey), hasher)
    : chainStreams(dumpStream, gzip, hasher);

  const [writeSettled, tableCountSettled, dumpSettled] = await Promise.allSettled([
    destination.writeStream(key, chain, { signal }),
    tableCountPromise,
    dumpDone,
  ]);

  if (dumpSettled.status === "rejected") {
    cancel();
    await destination.delete(key).catch(() => undefined);
    throw dumpSettled.reason;
  }
  if (writeSettled.status === "rejected") {
    cancel();
    throw writeSettled.reason;
  }
  if (tableCountSettled.status === "rejected") {
    throw tableCountSettled.reason;
  }

  const durationMs = Date.now() - dumpStart;
  logger.success(
    `pg_dump streamed to ${destination.describe}/${key} (${formatBytes(hasher.bytes)}, ${formatDuration(durationMs)}, schemas: ${schemas.join(", ")})`
  );

  return {
    key,
    sizeBytes: hasher.bytes,
    sha256: hasher.digest,
    tableCount: tableCountSettled.value,
    encrypted: Boolean(encryptionKey),
  };
}

interface StorageStepParams {
  supabaseUrl: string;
  serviceRoleKey: string;
  destination: DestinationDriver;
  dryRun: boolean;
  logger: Logger;
  signal: AbortSignal;
}

async function runStorageBackupStep(params: StorageStepParams): Promise<StorageBackupResult> {
  const { supabaseUrl, serviceRoleKey, destination, dryRun, logger, signal } = params;

  const supabase = createSupabaseAdminClient(supabaseUrl, serviceRoleKey);
  const buckets = await listBuckets(supabase);
  const previousManifest = await getLatestManifest(destination);
  const previousIndex = buildPreviousManifestIndex(previousManifest);

  if (dryRun) {
    let totalFiles = 0;
    let wouldTransfer = 0;
    for (const bucket of buckets) {
      const entries = await listBucketObjects(supabase, bucket);
      totalFiles += entries.length;
      for (const entry of entries) {
        const previous = previousIndex.get(objectKey(entry.bucket, entry.path));
        const unchanged = previous && previous.size === entry.size && previous.updatedAt === entry.updatedAt;
        if (!unchanged) wouldTransfer++;
      }
    }
    logger.info(
      `[dry-run] ${totalFiles} storage files found across ${buckets.length} bucket(s) — ${wouldTransfer} would be transferred`
    );
    return {
      totalFiles,
      newFiles: 0,
      updatedFiles: 0,
      skippedFiles: totalFiles,
      totalBytes: 0,
      perBucket: {},
      files: [],
    };
  }

  const start = Date.now();
  const result = await backupStorage({
    supabase,
    destination,
    buckets,
    previousManifest: previousIndex,
    concurrency: 5,
    signal,
  });

  logger.success(
    `${result.totalFiles.toLocaleString()} storage files synced (${result.newFiles} new, ${result.updatedFiles} updated) in ${formatDuration(Date.now() - start)}`
  );

  return result;
}
