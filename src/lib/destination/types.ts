import type { Readable } from "node:stream";

export interface WriteResult {
  bytes: number;
}

export interface WriteOptions {
  signal?: AbortSignal;
}

/**
 * Storage-agnostic interface implemented by the local filesystem and S3
 * drivers. Everything is stream-in/stream-out so a multi-GB dump never has
 * to fit in memory.
 */
export interface DestinationDriver {
  readonly describe: string;
  writeStream(key: string, stream: Readable, opts?: WriteOptions): Promise<WriteResult>;
  readStream(key: string): Promise<Readable>;
  writeText(key: string, content: string): Promise<void>;
  readText(key: string): Promise<string>;
  list(prefix: string): Promise<string[]>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}
