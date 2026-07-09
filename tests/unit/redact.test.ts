import { afterEach, describe, expect, it } from "vitest";
import { redactObject, redactSecrets } from "../../src/lib/redact.js";

describe("redactSecrets", () => {
  afterEach(() => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.VAULTSTREAM_S3_SECRET_KEY;
  });

  it("redacts the password portion of a postgres connection string", () => {
    const input = "connect failed: postgresql://vaultstream_backup:hunter2@db.example.supabase.co:5432/postgres";
    const output = redactSecrets(input);
    expect(output).not.toContain("hunter2");
    expect(output).toContain("postgresql://vaultstream_backup:[REDACTED]@db.example.supabase.co:5432/postgres");
  });

  it("redacts a known secret env var value wherever it appears verbatim", () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "super-secret-service-key-value";
    const output = redactSecrets("failed using key super-secret-service-key-value in request");
    expect(output).not.toContain("super-secret-service-key-value");
    expect(output).toContain("[REDACTED]");
  });

  it("redacts JWT-shaped tokens even when not set as an env var", () => {
    const fakeJwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const output = redactSecrets(`token=${fakeJwt}`);
    expect(output).not.toContain(fakeJwt);
    expect(output).toContain("[REDACTED]");
  });

  it("redacts AWS-style access key ids", () => {
    const output = redactSecrets("using AKIAIOSFODNN7EXAMPLE for auth");
    expect(output).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("leaves unrelated text (e.g. a sha256 checksum) untouched", () => {
    const checksum = "a".repeat(64);
    const output = redactSecrets(`sha256=${checksum}`);
    expect(output).toContain(checksum);
  });

  it("passes through empty input", () => {
    expect(redactSecrets("")).toBe("");
  });

  it("does not redact short/common substrings just because an env var happens to be short", () => {
    process.env.VAULTSTREAM_S3_SECRET_KEY = "ab"; // shorter than the 6-char minimum
    const output = redactSecrets("this is a normal sentence with ab in it");
    expect(output).toContain("normal sentence with ab in it");
  });
});

describe("redactObject", () => {
  afterEach(() => {
    delete process.env.VAULTSTREAM_S3_SECRET_KEY;
  });

  it("recursively redacts secret strings inside nested objects and arrays", () => {
    process.env.VAULTSTREAM_S3_SECRET_KEY = "top-secret-value";
    const input = {
      a: "contains top-secret-value here",
      b: ["also top-secret-value", { c: "fine", d: 42 }],
    };

    const output = redactObject(input);

    expect(JSON.stringify(output)).not.toContain("top-secret-value");
    expect(output.b[1]).toEqual({ c: "fine", d: 42 });
  });

  it("passes non-string primitives through unchanged", () => {
    expect(redactObject(42)).toBe(42);
    expect(redactObject(true)).toBe(true);
    expect(redactObject(null)).toBe(null);
  });
});
