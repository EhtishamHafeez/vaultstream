import { createHash } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import { HashPassThrough } from "../../src/lib/hash-stream.js";

describe("HashPassThrough", () => {
  it("computes the same sha256 as hashing the buffer directly, and passes data through unchanged", async () => {
    const original = Buffer.from("stream me through the hasher ".repeat(200));
    const expected = createHash("sha256").update(original).digest("hex");

    const hasher = new HashPassThrough();
    const chunks: Buffer[] = [];
    for await (const chunk of Readable.from(original).pipe(hasher)) {
      chunks.push(chunk as Buffer);
    }

    expect(Buffer.concat(chunks).equals(original)).toBe(true);
    expect(hasher.digest).toBe(expected);
    expect(hasher.bytes).toBe(original.length);
  });

  it("throws if digest is read before the stream has finished", () => {
    const hasher = new HashPassThrough();
    expect(() => hasher.digest).toThrow(/before the stream finished/);
  });

  it("works as a middle stage in a pipeline", async () => {
    const original = Buffer.from("pipeline stage test");
    const hasher = new HashPassThrough();
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on("data", (c: Buffer) => chunks.push(c));

    await pipeline(Readable.from(original), hasher, sink);

    expect(Buffer.concat(chunks).equals(original)).toBe(true);
    expect(hasher.digest).toBe(createHash("sha256").update(original).digest("hex"));
  });
});
