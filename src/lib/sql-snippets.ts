export function readOnlyRoleSql(roleName = "vaultstream_backup"): string {
  return `-- Run this once in the Supabase SQL editor (as an admin).
-- Creates a LOGIN role that can only ever SELECT — it cannot INSERT,
-- UPDATE, DELETE, or modify schema, no matter what happens to its
-- credentials.

CREATE ROLE ${roleName} WITH LOGIN PASSWORD 'REPLACE_WITH_A_STRONG_PASSWORD';

GRANT USAGE ON SCHEMA public TO ${roleName};
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${roleName};
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO ${roleName};

-- Repeat the three GRANT/ALTER lines above for any other schema you use
-- (e.g. "auth", "storage") if you want them included in the backup.

-- Your SUPABASE_DB_URL then becomes:
--   postgresql://${roleName}:REPLACE_WITH_A_STRONG_PASSWORD@<db-host>:5432/postgres`;
}
