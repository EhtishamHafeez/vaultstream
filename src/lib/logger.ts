import { redactSecrets } from "./redact.js";

const colors = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

export interface LogEvent {
  level: "success" | "info" | "warn" | "error";
  message: string;
  data?: Record<string, unknown>;
}

/**
 * All human-facing output goes through here so we get one place that
 * (a) redacts secrets and (b) can switch between pretty and --json output.
 */
export class Logger {
  readonly json: boolean;
  private events: LogEvent[] = [];

  constructor(json = false) {
    this.json = json;
  }

  success(message: string, data?: Record<string, unknown>): void {
    this.emit("success", message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.emit("info", message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.emit("warn", message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.emit("error", message, data);
  }

  private emit(level: LogEvent["level"], rawMessage: string, data?: Record<string, unknown>): void {
    const message = redactSecrets(rawMessage);
    this.events.push({ level, message, data });

    if (this.json) return;

    switch (level) {
      case "success":
        console.log(`${colors.green("✓")} ${message}`);
        break;
      case "info":
        console.log(`${colors.dim("·")} ${message}`);
        break;
      case "warn":
        console.log(`${colors.yellow("⚠")} ${message}`);
        break;
      case "error":
        console.error(`${colors.red("✗")} ${message}`);
        break;
    }
  }

  /** Emits the collected --json payload. No-op in pretty mode. */
  flushJson(result: Record<string, unknown>): void {
    if (!this.json) return;
    console.log(JSON.stringify({ events: this.events, ...result }, null, 2));
  }

  getEvents(): readonly LogEvent[] {
    return this.events;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m${remainingSeconds}s`;
}
