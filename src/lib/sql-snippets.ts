import { DEFAULT_SCHEMAS } from "./config.js";

export function readOnlyRoleSql(roleName = "vaultstream_backup", schemas: string[] = DEFAULT_SCHEMAS): string {
  const grants = schemas
    .map(
      (schema) =>
        `GRANT USAGE ON SCHEMA ${schema} TO ${roleName};\n` +
        `GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${roleName};\n` +
        // pg_dump also reads sequence state (last_value/is_called) for any
        // serial/identity column — SELECT ON TABLES alone isn't enough and
        // dumping fails with "permission denied for sequence ..._id_seq".
        `GRANT SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${roleName};\n` +
        `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema}\n` +
        `  GRANT SELECT ON TABLES TO ${roleName};\n` +
        `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema}\n` +
        `  GRANT SELECT ON SEQUENCES TO ${roleName};`
    )
    .join("\n\n");

  return `-- Run this once in the Supabase SQL editor (as an admin).
-- Creates a LOGIN role that can only ever SELECT — it cannot INSERT,
-- UPDATE, DELETE, or modify schema, no matter what happens to its
-- credentials.

CREATE ROLE ${roleName} WITH LOGIN PASSWORD 'REPLACE_WITH_A_STRONG_PASSWORD';

${grants}

-- vaultstream dumps only these schemas (${schemas.join(", ")}) by default — see
-- the "schemas" option in vaultstream.json / --schemas flag to change that.
-- Supabase's other internal schemas (e.g. "realtime") are intentionally left
-- out: they aren't readable by a role this restricted, and they hold no
-- application data, just internal plumbing (realtime's partitioned message
-- tables in particular). Granting SELECT on them anyway won't help — the
-- underlying tables are owned by extensions that lock out non-superusers
-- regardless of GRANT.

-- Your SUPABASE_DB_URL then becomes:
--   postgresql://${roleName}:REPLACE_WITH_A_STRONG_PASSWORD@<db-host>:5432/postgres`;
}
