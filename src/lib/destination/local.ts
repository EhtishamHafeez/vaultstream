import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { LocalDestination } from "../config.js";
import type { DestinationDriver, WriteOptions, WriteResult } from "./types.js";

export class LocalDestinationDriver implements DestinationDriver {
  readonly describe: string;
  private readonly root: string;

  constructor(config: LocalDestination) {
    this.root = path.resolve(config.path);
    this.describe = this.root;
  }

  private resolve(key: string): string {
    return path.join(this.root, key);
  }

  async writeStream(key: string, stream: Readable, opts?: WriteOptions): Promise<WriteResult> {
    const filePath = this.resolve(key);
    await mkdir(path.dirname(filePath), { recursive: true });

    let bytes = 0;
    stream.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
    });

    const writeStream = createWriteStream(filePath);
    const onAbort = () => writeStream.destroy(new Error("aborted"));
    opts?.signal?.addEventListener("abort", onAbort);

    try {
      await pipeline(stream, writeStream);
    } catch (error) {
      await rm(filePath, { force: true });
      throw error;
    } finally {
      opts?.signal?.removeEventListener("abort", onAbort);
    }

    return { bytes };
  }

  async readStream(key: string): Promise<Readable> {
    return createReadStream(this.resolve(key));
  }

  async writeText(key: string, content: string): Promise<void> {
    const filePath = this.resolve(key);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
  }

  async readText(key: string): Promise<string> {
    return readFile(this.resolve(key), "utf8");
  }

  async list(prefix: string): Promise<string[]> {
    const dir = this.resolve(prefix);
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.filter((e) => e.isFile()).map((e) => path.posix.join(prefix, e.name));
    } catch (error) {
      if (isEnoent(error)) return [];
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }
}

function isEnoent(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
