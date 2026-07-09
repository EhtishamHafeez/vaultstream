/**
 * Base class for all errors that should be presented to the user with a
 * friendly message + actionable hint, rather than a raw stack trace.
 */
export class VaultstreamError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "VaultstreamError";
    this.hint = hint;
  }
}

export class ConfigError extends VaultstreamError {
  constructor(message: string, hint?: string) {
    super(message, hint);
    this.name = "ConfigError";
  }
}

const INSTALL_INSTRUCTIONS: Record<string, string> = {
  darwin: "brew install postgresql@16",
  linux: "sudo apt-get install postgresql-client-16   (Debian/Ubuntu)\n  sudo dnf install postgresql16          (Fedora/RHEL)",
  win32: "choco install postgresql16   OR download from https://www.postgresql.org/download/windows/",
};

export class MissingBinaryError extends VaultstreamError {
  constructor(binary: "pg_dump" | "pg_restore" | "psql") {
    const platform = process.platform;
    const install = INSTALL_INSTRUCTIONS[platform] ?? INSTALL_INSTRUCTIONS.linux;
    super(
      `\`${binary}\` was not found on your PATH.`,
      `Install the PostgreSQL client tools for your OS:\n  ${install}\n\n` +
        `Then make sure "${binary}" is on your PATH (try running "${binary} --version").`
    );
    this.name = "MissingBinaryError";
  }
}

export class VersionMismatchError extends VaultstreamError {
  constructor(clientVersion: string, serverVersion: string) {
    super(
      `pg_dump version (${clientVersion}) does not match the server version (${serverVersion}).`,
      `Backups taken with a mismatched pg_dump can be subtly incomplete or fail to restore.\n` +
        `  Install a matching major version of the PostgreSQL client tools, or re-run with\n` +
        `  --no-version-check if you understand the risk and want to proceed anyway.`
    );
    this.name = "VersionMismatchError";
  }
}

export class DestinationExistsGuardError extends VaultstreamError {
  constructor() {
    super(
      "Refusing to restore into what looks like the source database.",
      "Pass --force if you really want to restore on top of the source database, " +
        "or point --target at a different (e.g. throwaway) Postgres instance."
    );
    this.name = "DestinationExistsGuardError";
  }
}

export function isVaultstreamError(error: unknown): error is VaultstreamError {
  return error instanceof VaultstreamError;
}
