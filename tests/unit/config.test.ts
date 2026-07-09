import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/lib/config.js";
import { ConfigError } from "../../src/lib/errors.js";

describe("resolveConfig", () => {
  it("resolves a local destination from --dest when there is no config file", () => {
    const config = resolveConfig({ fileConfig: null, destFlag: "./backups", env: {} });
    expect(config.destination).toEqual({ type: "local", path: "./backups" });
  });

  it("resolves a local destination from vaultstream.json", () => {
    const config = resolveConfig({
      fileConfig: { destination: { type: "local", path: "/var/backups" } },
      env: {},
    });
    expect(config.destination).toEqual({ type: "local", path: "/var/backups" });
  });

  it("throws a ConfigError when there is no destination at all", () => {
    expect(() => resolveConfig({ fileConfig: null, env: {} })).toThrow(ConfigError);
  });

  it("resolves an s3 destination purely from env vars (CI/cron use, no config file)", () => {
    const config = resolveConfig({
      fileConfig: null,
      destFlag: "s3",
      env: {
        VAULTSTREAM_S3_BUCKET: "my-bucket",
        VAULTSTREAM_S3_REGION: "auto",
        VAULTSTREAM_S3_ENDPOINT: "https://example.r2.cloudflarestorage.com",
        VAULTSTREAM_S3_ACCESS_KEY: "AKIAFAKEACCESSKEY",
        VAULTSTREAM_S3_SECRET_KEY: "fake-secret",
      },
    });

    expect(config.destination).toEqual({
      type: "s3",
      endpoint: "https://example.r2.cloudflarestorage.com",
      region: "auto",
      bucket: "my-bucket",
      forcePathStyle: undefined,
      accessKeyId: "AKIAFAKEACCESSKEY",
      secretAccessKey: "fake-secret",
    });
  });

  it("merges s3 bucket/region from vaultstream.json with secrets from env", () => {
    const config = resolveConfig({
      fileConfig: {
        destination: { type: "s3", region: "us-east-1", bucket: "prod-backups" },
      },
      env: { VAULTSTREAM_S3_ACCESS_KEY: "key", VAULTSTREAM_S3_SECRET_KEY: "secret" },
    });

    expect(config.destination).toMatchObject({ type: "s3", region: "us-east-1", bucket: "prod-backups" });
  });

  it("throws a ConfigError when s3 secrets are missing", () => {
    expect(() =>
      resolveConfig({
        fileConfig: { destination: { type: "s3", region: "us-east-1", bucket: "prod-backups" } },
        env: {},
      })
    ).toThrow(ConfigError);
  });

  it("rejects an encryption key that is not 32 bytes", () => {
    expect(() =>
      resolveConfig({
        fileConfig: null,
        destFlag: "./backups",
        env: { VAULTSTREAM_ENCRYPTION_KEY: "deadbeef" },
      })
    ).toThrow(ConfigError);
  });

  it("accepts a valid 32-byte hex encryption key", () => {
    const key = "a".repeat(64);
    const config = resolveConfig({ fileConfig: null, destFlag: "./backups", env: { VAULTSTREAM_ENCRYPTION_KEY: key } });
    expect(config.encryptionKey?.toString("hex")).toBe(key);
  });

  it("infers storageEnabled from SUPABASE_URL + SERVICE_ROLE_KEY when the config file doesn't say", () => {
    const config = resolveConfig({
      fileConfig: null,
      destFlag: "./backups",
      env: { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "key" },
    });
    expect(config.storageEnabled).toBe(true);
  });
});
