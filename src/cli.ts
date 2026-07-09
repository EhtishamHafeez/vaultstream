import { Command } from "commander";
import { backupCommand } from "./commands/backup.js";
import { initCommand } from "./commands/init.js";
import { listCommand } from "./commands/list.js";
import { restoreCommand } from "./commands/restore.js";
import { isVaultstreamError } from "./lib/errors.js";
import { redactSecrets } from "./lib/redact.js";
import { getCliVersion } from "./lib/version.js";

const program = new Command();

program
  .name("vaultstream")
  .description("Back up your entire Supabase project — database AND storage files — to storage you control.")
  .version(getCliVersion());

program
  .command("init")
  .description("Interactively configure vaultstream for this project")
  .action(async () => {
    await run(() => initCommand());
  });

program
  .command("backup")
  .description("Back up the database and/or storage files")
  .option("--db-only", "Only back up the database")
  .option("--storage-only", "Only back up storage files")
  .option("--dest <path|s3>", 'Destination: a local directory path, or "s3" (configured via env vars)')
  .option("--dry-run", "Show what would happen without writing or uploading anything")
  .option("--json", "Print machine-readable JSON output instead of pretty text")
  .option("--no-version-check", "Skip the pg_dump/server version compatibility check")
  .action(async (options: BackupCliOptions) => {
    await run(() =>
      backupCommand({
        dbOnly: options.dbOnly,
        storageOnly: options.storageOnly,
        dest: options.dest,
        dryRun: options.dryRun,
        json: options.json,
        noVersionCheck: options.versionCheck === false,
      })
    );
  });

program
  .command("restore")
  .description("Restore a backup into a target database and/or a local directory")
  .argument("<backup-id>", 'Backup id from "vaultstream list", or "latest"')
  .requiredOption("--target <postgres-url>", "Database to restore INTO (never the source)")
  .option("--storage-to <dir>", "Local directory to restore storage files into")
  .option("--force", "Allow restoring even if --target matches SUPABASE_DB_URL")
  .option("--yes", "Skip the confirmation prompt (for scripted restore-testing)")
  .option("--dest <path|s3>", "Destination backups were written to (overrides vaultstream.json)")
  .option("--json", "Print machine-readable JSON output instead of pretty text")
  .action(async (backupId: string, options: RestoreCliOptions) => {
    await run(() => restoreCommand(backupId, options));
  });

program
  .command("list")
  .description("List available backups, newest first")
  .option("--dest <path|s3>", "Destination to list (overrides vaultstream.json)")
  .option("--json", "Print machine-readable JSON output instead of a table")
  .action(async (options: ListCliOptions) => {
    await run(() => listCommand(options));
  });

interface BackupCliOptions {
  dbOnly?: boolean;
  storageOnly?: boolean;
  dest?: string;
  dryRun?: boolean;
  json?: boolean;
  versionCheck?: boolean;
}

interface RestoreCliOptions {
  target?: string;
  storageTo?: string;
  force?: boolean;
  yes?: boolean;
  dest?: string;
  json?: boolean;
}

interface ListCliOptions {
  dest?: string;
  json?: boolean;
}

async function run(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    handleFatalError(error);
  }
}

function handleFatalError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n✗ ${redactSecrets(message)}`);

  if (isVaultstreamError(error) && error.hint) {
    console.error(`\n${redactSecrets(error.hint)}`);
  } else if (error instanceof Error && error.stack && process.env.VAULTSTREAM_DEBUG) {
    console.error(`\n${redactSecrets(error.stack)}`);
  }

  process.exitCode = 1;
}

process.on("uncaughtException", (error) => {
  handleFatalError(error);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  handleFatalError(reason);
  process.exit(1);
});

await program.parseAsync();
