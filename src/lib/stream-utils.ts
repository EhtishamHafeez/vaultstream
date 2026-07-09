import { PassThrough, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Chains a Readable through one or more Transform stages and returns a
 * single Readable producing the final stage's output. Built on
 * node:stream/promises pipeline so errors/destroys propagate correctly
 * through the whole chain (unlike manual .pipe() chaining).
 */
export function chainStreams(source: Readable, ...stages: NodeJS.ReadWriteStream[]): Readable {
  const output = new PassThrough();

  pipeline([source, ...stages, output]).catch((error: unknown) => {
    output.destroy(error instanceof Error ? error : new Error(String(error)));
  });

  return output;
}
