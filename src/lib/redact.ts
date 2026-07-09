const SECRET_ENV_VARS = [
  "SUPABASE_DB_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "VAULTSTREAM_S3_ACCESS_KEY",
  "VAULTSTREAM_S3_SECRET_KEY",
  "VAULTSTREAM_ENCRYPTION_KEY",
] as const;

const REDACTED = "[REDACTED]";

// postgres://user:PASSWORD@host:5432/db -> postgres://user:[REDACTED]@host:5432/db
const CONNECTION_STRING_PASSWORD = /(postgres(?:ql)?:\/\/[^:/\s@]+:)([^@\s]+)(@)/gi;

// Supabase / JWT-style tokens: eyJ....eyJ....signature
const JWT_PATTERN = /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g;

// AWS-style access key IDs (AKIA/ASIA + 16 alphanumeric chars)
const AWS_ACCESS_KEY_PATTERN = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;

/**
 * Strips known secrets (env var values, connection string passwords, JWTs,
 * AWS access key IDs) out of arbitrary text. Used on every error path so
 * credentials never reach logs, terminal output, or crash reports.
 */
export function redactSecrets(input: string): string {
  if (!input) return input;

  let out = input;

  for (const name of SECRET_ENV_VARS) {
    const value = process.env[name];
    if (value && value.length >= 6) {
      out = out.split(value).join(REDACTED);
    }
  }

  out = out.replace(CONNECTION_STRING_PASSWORD, `$1${REDACTED}$3`);
  out = out.replace(JWT_PATTERN, REDACTED);
  out = out.replace(AWS_ACCESS_KEY_PATTERN, REDACTED);

  return out;
}

/**
 * Recursively redacts secrets from string values in an object, without
 * mutating the input. Non-string values pass through unchanged.
 */
export function redactObject<T>(value: T): T {
  if (typeof value === "string") {
    return redactSecrets(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactObject(item)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactObject(val);
    }
    return out as T;
  }
  return value;
}
