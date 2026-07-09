import { readFile } from "node:fs/promises";
import path from "node:path";
import { ConfigError } from "./errors.js";

export interface LocalDestinationFileConfig {
  type: "local";
  path: string;
}

export interface S3DestinationFileConfig {
  type: "s3";
  endpoint?: string;
  region: string;
  bucket: string;
  forcePathStyle?: boolean;
}

export type DestinationFileConfig = LocalDestinationFileConfig | S3DestinationFileConfig;

export interface VaultstreamFileConfig {
  destination: DestinationFileConfig;
  storage?: { enabled: boolean };
  encryption?: { enabled: boolean };
  /** Schemas to pass to pg_dump via -n. Defaults to DEFAULT_SCHEMAS. */
  schemas?: string[];
}

/**
 * Supabase's internal schemas (notably "realtime", with its daily message
 * partition tables) aren't readable by the read-only backup role and don't
 * contain user data — so we never dump the whole database by default, only
 * these three.
 */
export const DEFAULT_SCHEMAS = ["public", "auth", "storage"];

export const CONFIG_FILENAME = "vaultstream.json";

export async function loadFileConfig(cwd: string): Promise<VaultstreamFileConfig | null> {
  const configPath = path.join(cwd, CONFIG_FILENAME);
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }

  try {
    return JSON.parse(raw) as VaultstreamFileConfig;
  } catch {
    throw new ConfigError(
      `Could not parse ${CONFIG_FILENAME} — it isn't valid JSON.`,
      `Run "vaultstream init" to regenerate it, or fix the syntax error by hand.`
    );
  }
}

export interface LocalDestination {
  type: "local";
  path: string;
}

export interface S3Destination {
  type: "s3";
  endpoint?: string;
  region: string;
  bucket: string;
  forcePathStyle?: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

export type Destination = LocalDestination | S3Destination;

export interface ResolvedConfig {
  dbUrl?: string;
  supabaseUrl?: string;
  supabaseServiceRoleKey?: string;
  destination: Destination;
  encryptionKey?: Buffer;
  storageEnabled: boolean;
  schemas: string[];
}

export interface ResolveConfigOptions {
  fileConfig: VaultstreamFileConfig | null;
  destFlag?: string;
  schemasFlag?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Merges vaultstream.json (non-secret) with environment variables (secrets)
 * into a single resolved config. A config file is never required — every
 * command must work from env vars + flags alone for CI/cron use.
 */
export function resolveConfig({ fileConfig, destFlag, schemasFlag, env = process.env }: ResolveConfigOptions): ResolvedConfig {
  const destination = resolveDestination({ fileConfig, destFlag, env });

  const schemas = schemasFlag
    ? schemasFlag.split(",").map((s) => s.trim()).filter(Boolean)
    : (fileConfig?.schemas?.length ? fileConfig.schemas : DEFAULT_SCHEMAS);

  const encryptionKeyHex = env.VAULTSTREAM_ENCRYPTION_KEY;
  let encryptionKey: Buffer | undefined;
  if (encryptionKeyHex) {
    const buf = Buffer.from(encryptionKeyHex, "hex");
    if (buf.length !== 32) {
      throw new ConfigError(
        `VAULTSTREAM_ENCRYPTION_KEY must be a 32-byte hex string (64 hex characters), got ${buf.length} bytes.`,
        `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
      );
    }
    encryptionKey = buf;
  }

  return {
    dbUrl: env.SUPABASE_DB_URL,
    supabaseUrl: env.SUPABASE_URL,
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    destination,
    encryptionKey,
    storageEnabled: fileConfig?.storage?.enabled ?? Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY),
    schemas,
  };
}

function resolveDestination({ fileConfig, destFlag, env }: ResolveConfigOptions): Destination {
  if (destFlag) {
    if (destFlag === "s3") return resolveS3FromEnv(fileConfig, env);
    return { type: "local", path: destFlag };
  }

  if (fileConfig?.destination.type === "local") {
    return { type: "local", path: fileConfig.destination.path };
  }

  if (fileConfig?.destination.type === "s3") {
    return resolveS3FromEnv(fileConfig, env);
  }

  throw new ConfigError(
    "No destination configured.",
    `Run "vaultstream init" to create ${CONFIG_FILENAME}, or pass --dest <path|s3> explicitly ` +
      `(with VAULTSTREAM_S3_* env vars set if using s3).`
  );
}

function resolveS3FromEnv(fileConfig: VaultstreamFileConfig | null, env?: NodeJS.ProcessEnv): S3Destination {
  const e = env ?? process.env;
  const s3File = fileConfig?.destination.type === "s3" ? fileConfig.destination : undefined;

  const bucket = s3File?.bucket ?? e.VAULTSTREAM_S3_BUCKET;
  const region = s3File?.region ?? e.VAULTSTREAM_S3_REGION;
  const endpoint = s3File?.endpoint ?? e.VAULTSTREAM_S3_ENDPOINT;
  const accessKeyId = e.VAULTSTREAM_S3_ACCESS_KEY;
  const secretAccessKey = e.VAULTSTREAM_S3_SECRET_KEY;

  const missing: string[] = [];
  if (!bucket) missing.push("bucket (vaultstream.json destination.bucket or VAULTSTREAM_S3_BUCKET)");
  if (!region) missing.push("region (vaultstream.json destination.region or VAULTSTREAM_S3_REGION)");
  if (!accessKeyId) missing.push("VAULTSTREAM_S3_ACCESS_KEY");
  if (!secretAccessKey) missing.push("VAULTSTREAM_S3_SECRET_KEY");

  if (missing.length > 0) {
    throw new ConfigError(
      `S3 destination is missing: ${missing.join(", ")}.`,
      `Run "vaultstream init" to configure S3, or set the missing environment variables directly.`
    );
  }

  return {
    type: "s3",
    endpoint,
    region: region as string,
    bucket: bucket as string,
    forcePathStyle: s3File?.forcePathStyle,
    accessKeyId: accessKeyId as string,
    secretAccessKey: secretAccessKey as string,
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
