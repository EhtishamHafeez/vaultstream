import { createCipheriv, createDecipheriv, randomBytes, type CipherGCM, type DecipherGCM } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";

const ALGORITHM = "aes-256-gcm" as const;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

/**
 * Wire format: [12-byte IV][ciphertext...][16-byte auth tag]
 *
 * GCM's auth tag is only known once the whole plaintext has been consumed,
 * so the decrypt side has to hold back the last 16 bytes it has seen at all
 * times (a sliding tail buffer) until the stream ends — at which point
 * whatever is left in the tail buffer *is* the tag.
 */
export class EncryptStream extends Transform {
  private readonly iv: Buffer;
  private readonly cipher: CipherGCM;
  private ivPushed = false;

  constructor(key: Buffer) {
    assertKeyLength(key);
    super();
    this.iv = randomBytes(IV_LENGTH);
    this.cipher = createCipheriv(ALGORITHM, key, this.iv);
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.pushIvOnce();
    const out = this.cipher.update(chunk);
    if (out.length > 0) this.push(out);
    callback();
  }

  override _flush(callback: TransformCallback): void {
    this.pushIvOnce();
    const final = this.cipher.final();
    if (final.length > 0) this.push(final);
    this.push(this.cipher.getAuthTag());
    callback();
  }

  private pushIvOnce(): void {
    if (this.ivPushed) return;
    this.push(this.iv);
    this.ivPushed = true;
  }
}

export class DecryptStream extends Transform {
  private readonly key: Buffer;
  private headerBuffer = Buffer.alloc(0);
  private decipher: DecipherGCM | null = null;
  private tailBuffer = Buffer.alloc(0);

  constructor(key: Buffer) {
    assertKeyLength(key);
    super();
    this.key = key;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      let data = chunk;

      if (!this.decipher) {
        this.headerBuffer = Buffer.concat([this.headerBuffer, data]);
        if (this.headerBuffer.length < IV_LENGTH) {
          callback();
          return;
        }
        const iv = this.headerBuffer.subarray(0, IV_LENGTH);
        this.decipher = createDecipheriv(ALGORITHM, this.key, iv);
        data = this.headerBuffer.subarray(IV_LENGTH);
        this.headerBuffer = Buffer.alloc(0);
      }

      const combined = Buffer.concat([this.tailBuffer, data]);
      if (combined.length <= AUTH_TAG_LENGTH) {
        this.tailBuffer = combined;
        callback();
        return;
      }

      const releasable = combined.subarray(0, combined.length - AUTH_TAG_LENGTH);
      this.tailBuffer = Buffer.from(combined.subarray(combined.length - AUTH_TAG_LENGTH));

      const out = this.decipher.update(releasable);
      if (out.length > 0) this.push(out);
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      if (!this.decipher) {
        callback(new Error("Encrypted stream is truncated (missing IV)."));
        return;
      }
      if (this.tailBuffer.length !== AUTH_TAG_LENGTH) {
        callback(new Error("Encrypted stream is truncated (missing auth tag)."));
        return;
      }
      this.decipher.setAuthTag(this.tailBuffer);
      const final = this.decipher.final();
      if (final.length > 0) this.push(final);
      callback();
    } catch (error) {
      callback(
        error instanceof Error
          ? new Error(`Decryption failed — wrong key, or the file was corrupted/tampered with. (${error.message})`)
          : (error as Error)
      );
    }
  }
}

export function createEncryptStream(key: Buffer): EncryptStream {
  return new EncryptStream(key);
}

export function createDecryptStream(key: Buffer): DecryptStream {
  return new DecryptStream(key);
}

export function generateEncryptionKey(): Buffer {
  return randomBytes(KEY_LENGTH);
}

export function parseEncryptionKeyHex(hex: string): Buffer {
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== KEY_LENGTH) {
    throw new Error(`Encryption key must be ${KEY_LENGTH} bytes (${KEY_LENGTH * 2} hex chars), got ${buf.length} bytes.`);
  }
  return buf;
}

function assertKeyLength(key: Buffer): void {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`Encryption key must be ${KEY_LENGTH} bytes, got ${key.length}.`);
  }
}
