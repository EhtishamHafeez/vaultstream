import * as clack from "@clack/prompts";
import zlib from "node:zlib";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { loadFileConfig, resolveConfig } from "../lib/config.js";
import { createDestinationDriver } from "../lib/destination/index.js";
import { checkBinaryAvailable, runPgRestore } from "../lib/database.js";
import { createDecryptStream } from "../lib/encryption.js";
import { ConfigError, DestinationExistsGuardError, VaultstreamError } from "../lib/errors.js";
import { HashPassThrough } from "../lib/hash-stream.js";
import { formatBytes, formatDuration, Logger } from "../lib/logger.js";
import { listManifests, manifestKey, readManifest, type BackupManifest } from "../lib/manifest.js";
import { redactSecrets } from "../lib/redact.js";
import { runWithConcurrency } from "../lib/storage.js";
import { chainStreams } from "../lib/stream-utils.js";

export interface RestoreCommandOptions {
  target?: string;
  storageTo?: string;
  force?: boolean;
  yes?: boolean;
  dest?: string;
  json?: boolean;
}

export async function restoreCommand(backupId: string, opts: RestoreCommandOptions): Promise<void> {
  const logger = new Logger(Boolean(opts.json));
  const startedAt = Date.now();

  if (!opts.target) {
    throw new ConfigError("--target <postgres-url> is required.", "This is the database you want to restore INTO.");
  }

  const fileConfig = await loadFileConfig(process.cwd());
  const config = resolveConfig({ fileConfig, destFlag: opts.dest });
  const destination = createDestinationDriver(config.destination);

  if (config.dbUrl && normalizeUrl(config.dbUrl) === normalizeUrl(opts.target) && !opts.force) {
    throw new DestinationExistsGuardError();
  }

  const manifest = await loadManifestForBackupId(destination, backupId);

  clack.intro("vaultstream restore");
  clack.log.warn(
    `This will DESTROY and REPLACE data in the target database:\n` +
      `  ${redactSecrets(opts.target)}\n\n` +
      `pg_restore runs with --clean --if-exists — existing objects with the same\n` +
      `names will be dropped first.`
  );

  if (!opts.yes) {
    const confirmed = await clack.confirm({
      message: "Type-confirm: continue with this destructive restore?",
      initialValue: false,
    });
    if (clack.isCancel(confirmed) || !confirmed) {
      clack.cancel("Restore cancelled.");
      process.exitCode = 1;
      return;
    }
  }

  if (manifest.database) {
    await restoreDatabase({ manifest, destination, targetUrl: opts.target, encryptionKey: config.encryptionKey, logger });
  } else {
    logger.info("No database backup in this manifest — skipping.");
  }

  if (opts.storageTo && manifest.storage) {
    await restoreStorageFiles({ manifest, destination, storageTo: opts.storageTo, logger });
  } else if (manifest.storage && !opts.storageTo) {
    logger.info("Manifest includes storage files — pass --storage-to <dir> to restore them.");
  }

  clack.outro(`Restore complete in ${formatDuration(Date.now() - startedAt)}.`);
  logger.flushJson({ ok: true, durationMs: Date.now() - startedAt });
}

async function loadManifestForBackupId(
  destination: ReturnType<typeof createDestinationDriver>,
  backupId: string
): Promise<BackupManifest> {
  if (backupId === "latest") {
    const manifests = await listManifests(destination);
    const latest = manifests[0];
    if (!latest) {
      throw new VaultstreamError("No backups found at this destination.");
    }
    return readManifest(destination, latest.key);
  }

  const key = manifestKey(backupId);
  const exists = await destination.exists(key);
  if (!exists) {
    throw new VaultstreamError(
      `No backup found with id "${backupId}".`,
      `Run "vaultstream list" to see available backup ids, or pass "latest".`
    );
  }
  return readManifest(destination, key);
}

interface RestoreDatabaseParams {
  manifest: BackupManifest;
  destination: ReturnType<typeof createDestinationDriver>;
  targetUrl: string;
  encryptionKey: Buffer | undefined;
  logger: Logger;
}

async function restoreDatabase({ manifest, destination, targetUrl, encryptionKey, logger }: RestoreDatabaseParams): Promise<void> {
  const db = manifest.database;
  if (!db) return;

  if (db.encrypted && !encryptionKey) {
    throw new ConfigError(
      "This backup is encrypted but VAULTSTREAM_ENCRYPTION_KEY is not set.",
      "Set the same key that was used when the backup was created."
    );
  }

  await checkBinaryAvailable("pg_restore");

  const start = Date.now();
  const rawStream = await destination.readStream(db.key);
  const hasher = new HashPassThrough();

  const dumpStream = db.encrypted && encryptionKey
    ? chainStreams(rawStream, hasher, createDecryptStream(encryptionKey), zlib.createGunzip())
    : chainStreams(rawStream, hasher, zlib.createGunzip());

  await runPgRestore({ targetUrl, dumpStream });

  if (db.sha256 && hasher.digest !== db.sha256) {
    logger.error(
      "Checksum mismatch — the restored dump did not match the manifest's recorded sha256. " +
        "The stored backup file may be corrupted or was tampered with."
    );
    process.exitCode = 1;
    return;
  }

  logger.success(
    `restored database from ${destination.describe}/${db.key} (${formatBytes(db.sizeBytes)}, ${formatDuration(Date.now() - start)}) — checksum verified`
  );
}

interface RestoreStorageParams {
  manifest: BackupManifest;
  destination: ReturnType<typeof createDestinationDriver>;
  storageTo: string;
  logger: Logger;
}

async function restoreStorageFiles({ manifest, destination, storageTo, logger }: RestoreStorageParams): Promise<void> {
  const files = manifest.storage?.files ?? [];
  const start = Date.now();

  await runWithConcurrency(files, 5, async (file) => {
    const sourceKey = `storage/${file.bucket}/${file.path}`;
    const targetPath = path.join(storageTo, file.bucket, file.path);
    await mkdir(path.dirname(targetPath), { recursive: true });
    const readable = await destination.readStream(sourceKey);
    await pipeline(readable, createWriteStream(targetPath));
  });

  logger.success(`${files.length.toLocaleString()} storage files restored to ${storageTo} (${formatDuration(Date.now() - start)})`);
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}
