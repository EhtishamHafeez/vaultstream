import type { Destination } from "../config.js";
import { LocalDestinationDriver } from "./local.js";
import { S3DestinationDriver } from "./s3.js";
import type { DestinationDriver } from "./types.js";

export type { DestinationDriver, WriteOptions, WriteResult } from "./types.js";

export function createDestinationDriver(config: Destination): DestinationDriver {
  switch (config.type) {
    case "local":
      return new LocalDestinationDriver(config);
    case "s3":
      return new S3DestinationDriver(config);
  }
}
