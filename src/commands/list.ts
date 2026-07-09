import { loadFileConfig, resolveConfig } from "../lib/config.js";
import { createDestinationDriver } from "../lib/destination/index.js";
import { formatBytes, Logger } from "../lib/logger.js";
import { listManifests, readManifest } from "../lib/manifest.js";

export interface ListCommandOptions {
  dest?: string;
  json?: boolean;
}

interface BackupRow {
  id: string;
  createdAt: string;
  sizeBytes: number;
  tableCount: number;
  storageFiles: number;
}

const COLUMN_WIDTHS = [28, 24, 10, 8, 14] as const;

export async function listCommand(opts: ListCommandOptions): Promise<void> {
  const logger = new Logger(Boolean(opts.json));
  const fileConfig = await loadFileConfig(process.cwd());
  const config = resolveConfig({ fileConfig, destFlag: opts.dest });
  const destination = createDestinationDriver(config.destination);

  const manifests = await listManifests(destination);

  if (manifests.length === 0) {
    logger.info(`No backups found at ${destination.describe}.`);
    logger.flushJson({ backups: [] });
    return;
  }

  const rows: BackupRow[] = await Promise.all(
    manifests.map(async ({ key, timestamp }): Promise<BackupRow> => {
      const manifest = await readManifest(destination, key);
      return {
        id: timestamp,
        createdAt: manifest.createdAt,
        sizeBytes: manifest.database?.sizeBytes ?? 0,
        tableCount: manifest.database?.tableCount ?? 0,
        storageFiles: manifest.storage?.totalFiles ?? 0,
      };
    })
  );

  if (opts.json) {
    logger.flushJson({ backups: rows });
    return;
  }

  console.log(`\nBackups at ${destination.describe}:\n`);
  printRow(["ID", "CREATED", "DB SIZE", "TABLES", "STORAGE FILES"]);
  for (const row of rows) {
    printRow([
      row.id,
      new Date(row.createdAt).toLocaleString(),
      formatBytes(row.sizeBytes),
      String(row.tableCount),
      String(row.storageFiles),
    ]);
  }
  console.log();
}

function printRow(cells: readonly string[]): void {
  console.log(cells.map((cell, i) => cell.padEnd(COLUMN_WIDTHS[i] ?? 12)).join(""));
}
