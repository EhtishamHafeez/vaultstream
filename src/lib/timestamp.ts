/** Filesystem/S3-key-safe ISO timestamp, e.g. 2026-07-09T14-30-00.123Z */
export function backupTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/:/g, "-");
}
