import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createDecryptStream,
  createEncryptStream,
  generateEncryptionKey,
  parseEncryptionKeyHex,
} from "../../src/lib/encryption.js";

async function streamToBuffer(readable: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe("AES-256-GCM stream encryption round-trip", () => {
  it("encrypts then decrypts back to the exact original bytes", async () => {
    const key = generateEncryptionKey();
    const original = Buffer.from("the quick brown fox jumps over the lazy dog ".repeat(1000));

    const encrypted = await streamToBuffer(Readable.from(original).pipe(createEncryptStream(key)));
    expect(encrypted.length).toBeGreaterThan(original.length); // IV + auth tag overhead
    expect(encrypted.equals(original)).toBe(false);

    const decrypted = await streamToBuffer(Readable.from(encrypted).pipe(createDecryptStream(key)));
    expect(decrypted.equals(original)).toBe(true);
  });

  it("round-trips correctly across many small chunks", async () => {
    const key = generateEncryptionKey();
    const chunks = Array.from({ length: 500 }, (_, i) => Buffer.from(`chunk-${i}-`));
    const original = Buffer.concat(chunks);

    const encrypted = await streamToBuffer(Readable.from(chunks).pipe(createEncryptStream(key)));
    const decrypted = await streamToBuffer(Readable.from(encrypted).pipe(createDecryptStream(key)));

    expect(decrypted.equals(original)).toBe(true);
  });

  it("round-trips an empty payload", async () => {
    const key = generateEncryptionKey();
    const encrypted = await streamToBuffer(Readable.from(Buffer.alloc(0)).pipe(createEncryptStream(key)));
    const decrypted = await streamToBuffer(Readable.from(encrypted).pipe(createDecryptStream(key)));
    expect(decrypted.length).toBe(0);
  });

  it("produces a different IV (and ciphertext) on every call, even for identical plaintext", async () => {
    const key = generateEncryptionKey();
    const original = Buffer.from("same plaintext every time");

    const a = await streamToBuffer(Readable.from(original).pipe(createEncryptStream(key)));
    const b = await streamToBuffer(Readable.from(original).pipe(createEncryptStream(key)));

    expect(a.equals(b)).toBe(false);
  });

  it("rejects decryption with the wrong key", async () => {
    const key = generateEncryptionKey();
    const wrongKey = generateEncryptionKey();
    const encrypted = await streamToBuffer(Readable.from(Buffer.from("secret payload")).pipe(createEncryptStream(key)));

    await expect(streamToBuffer(Readable.from(encrypted).pipe(createDecryptStream(wrongKey)))).rejects.toThrow();
  });

  it("rejects tampered ciphertext (auth tag mismatch)", async () => {
    const key = generateEncryptionKey();
    const original = Buffer.from("secret payload that is long enough to tamper with safely");
    const encrypted = await streamToBuffer(Readable.from(original).pipe(createEncryptStream(key)));

    const tampered = Buffer.from(encrypted);
    tampered[20] = (tampered[20] ?? 0) ^ 0xff;

    await expect(streamToBuffer(Readable.from(tampered).pipe(createDecryptStream(key)))).rejects.toThrow();
  });

  it("rejects a truncated ciphertext missing the auth tag", async () => {
    const key = generateEncryptionKey();
    const encrypted = await streamToBuffer(
      Readable.from(Buffer.from("some payload")).pipe(createEncryptStream(key))
    );
    const truncated = encrypted.subarray(0, encrypted.length - 20);

    await expect(streamToBuffer(Readable.from(truncated).pipe(createDecryptStream(key)))).rejects.toThrow();
  });
});

describe("parseEncryptionKeyHex", () => {
  it("parses a valid 32-byte hex key", () => {
    const key = generateEncryptionKey();
    expect(parseEncryptionKeyHex(key.toString("hex")).equals(key)).toBe(true);
  });

  it("throws on the wrong length", () => {
    expect(() => parseEncryptionKeyHex("deadbeef")).toThrow(/32 bytes/);
  });
});
