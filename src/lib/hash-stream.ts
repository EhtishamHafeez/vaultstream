import { createHash } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";

/**
 * Pass-through stream that computes a running sha256 + byte count without
 * buffering anything — used to checksum the exact bytes written to the
 * destination (post-gzip, post-encryption) so the manifest's checksum can
 * be independently verified against the stored file.
 */
export class HashPassThrough extends Transform {
  private readonly hash = createHash("sha256");
  private finalDigest: string | null = null;
  private byteCount = 0;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.hash.update(chunk);
    this.byteCount += chunk.length;
    callback(null, chunk);
  }

  override _flush(callback: TransformCallback): void {
    this.finalDigest = this.hash.digest("hex");
    callback();
  }

  /** Only valid after the stream has finished (i.e. after the consuming pipeline resolves). */
  get digest(): string {
    if (this.finalDigest === null) {
      throw new Error("HashPassThrough.digest read before the stream finished.");
    }
    return this.finalDigest;
  }

  get bytes(): number {
    return this.byteCount;
  }
}
