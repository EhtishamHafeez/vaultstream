# vaultstream

[![npm version](https://img.shields.io/npm/v/vaultstream.svg)](https://www.npmjs.com/package/vaultstream)
[![CI](https://github.com/EhtishamHafeez/vaultstream/actions/workflows/ci.yml/badge.svg)](https://github.com/EhtishamHafeez/vaultstream/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

**Back up your entire Supabase project — database AND storage files — to storage you control.**

Supabase's free tier ships with no backups at all. Paid tiers back up your Postgres
database daily — but **never** the actual bytes sitting in Storage buckets, even on
the Team and Enterprise plans. `vaultstream` fixes both problems: hourly-capable,
streaming, restore-tested backups of your database *and* your storage files, written
straight to a destination you own. Nothing is ever stored on someone else's server
without your consent.

## 30-second quickstart

No cloud account, no config, no credit card. Back up to a local directory first,
switch to S3/R2/B2 whenever you're ready:

```bash
npx vaultstream init      # interactive setup — writes vaultstream.json, prints env vars to set
npx vaultstream backup    # streams your DB + storage files to the destination you chose
```

That's it. `vaultstream list` shows you what you've got; `vaultstream restore` puts it back.

## Why this exists

| | Supabase free tier | Supabase paid tiers | `vaultstream` |
|---|---|---|---|
| Database backups | ❌ None | ✅ Daily | ✅ As often as you run it (hourly via cron) |
| Storage file bytes | ❌ Never | ❌ **Never** — even on paid plans | ✅ Every run, incremental |
| Off-site custody | — | ❌ Backups stay on Supabase's infrastructure | ✅ Your S3 / R2 / Backblaze bucket, your keys |
| Restore-tested | — | ❌ Not verified | ⏳ Manual today, automated in the [hosted version](#roadmap) |
| Credentials required | — | Admin only | ✅ Read-only role (see [Security](#security)) |

The gap that matters most: **Supabase's built-in backups have never covered Storage
file bytes, on any plan.** If your app stores user uploads, avatars, generated PDFs,
or anything else in a Storage bucket, none of it is in Supabase's backups today.
`vaultstream` backs up both halves of your project.

## Installation

```bash
npm install -g vaultstream
# or just use npx, no install needed:
npx vaultstream init
```

Requires Node.js 20+ and the PostgreSQL client tools (`pg_dump`, `pg_restore`, `psql`)
on your PATH:

```bash
# macOS
brew install postgresql@16

# Debian / Ubuntu
sudo apt-get install postgresql-client-16

# Fedora / RHEL
sudo dnf install postgresql16
```

`vaultstream` will tell you exactly this if the binaries are missing — it won't fail silently.

## Commands

### `vaultstream init`

Interactive setup. Asks non-secret questions (destination, whether to back up storage
files, whether to encrypt) and writes them to `vaultstream.json`. **It never asks for
or stores credentials** — instead it prints exactly which environment variables to
set, including a copy-paste SQL snippet for a read-only database role.

### `vaultstream backup`

The core command. Cron-safe: exits `0` on success, `1` on any failure.

```bash
vaultstream backup                      # database + storage, per vaultstream.json
vaultstream backup --db-only            # skip storage files
vaultstream backup --storage-only       # skip the database
vaultstream backup --dest ./backups     # override the destination for this run
vaultstream backup --dest s3            # use the S3-compatible destination from env vars
vaultstream backup --schemas public,auth,storage,custom_schema  # override which schemas pg_dump covers
vaultstream backup --exclude-tables storage.migrations,public.debug_logs  # override which tables pg_dump skips
vaultstream backup --dry-run            # show what would happen, write nothing
vaultstream backup --json               # machine-readable output for scripts/monitoring
```

Sample output:

```
✓ pg_dump streamed to s3://my-bucket/db/backup-2026-07-09T14-00-00.000Z.dump.gz.enc (48 MB, 38s, schemas: public, auth, storage)
✓ 1,204 storage files synced (12 new, 3 updated) in 22s
✓ manifest written — 42 tables, sha256 verified
```

By default, `pg_dump` only covers the `public`, `auth`, and `storage` schemas —
**never the whole database.** Supabase's other internal schemas (notably `realtime`,
which has its own daily message-partition tables) aren't readable by the read-only
backup role and hold no application data anyway. See
[Troubleshooting](#troubleshooting) if you hit a permission error, or the `schemas`
option below if you need to include an additional schema of your own.

### `vaultstream restore <backup-id>`

```bash
vaultstream restore latest --target postgresql://postgres:pw@localhost:5432/postgres
vaultstream restore 2026-07-09T14-00-00.000Z --target <url> --storage-to ./restored-files
```

Always prints a loud warning and asks for confirmation before touching a database
(`pg_restore --clean --if-exists` drops existing objects first). Refuses to restore
onto whatever `SUPABASE_DB_URL` points at unless you pass `--force` — the last thing
you want during a disaster-recovery drill is to accidentally wipe your source database.

### `vaultstream list`

```bash
vaultstream list
vaultstream list --json
```

Lists every backup at the configured destination — id, timestamp, database size, table
count, storage file count — newest first.

## Configuration

`vaultstream.json` (written by `init`, safe to commit — **contains no secrets**):

```json
{
  "destination": { "type": "local", "path": "./vaultstream-backups" },
  "storage": { "enabled": true },
  "encryption": { "enabled": true },
  "schemas": ["public", "auth", "storage"],
  "excludeTables": [
    "storage.migrations",
    "storage.s3_multipart_uploads",
    "storage.s3_multipart_uploads_parts"
  ]
}
```

`schemas` controls which schemas `pg_dump` covers (`-n <schema>` per entry) and
defaults to `["public", "auth", "storage"]` if omitted. The `--schemas` flag
overrides both the config file and the default for a single run.

`excludeTables` controls which individual tables `pg_dump` skips (`-T <schema.table>`
per entry) even within a dumped schema, and defaults to the three tables shown above
if omitted — they're the storage extension's own internal bookkeeping (schema-version
tracking, in-progress multipart upload state), not your data, and on some projects
aren't grantable to a restricted role at all. The `--exclude-tables` flag overrides
both the config file and the default for a single run.

Everything else comes from environment variables, so every command also works with
**no config file at all** — just env vars — for CI and cron use:

| Variable | Required for | Notes |
|---|---|---|
| `SUPABASE_DB_URL` | Database backup/restore | Use the read-only role below, not the admin connection string |
| `SUPABASE_URL` | Storage backup | `https://<project-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Storage backup | From Project Settings → API |
| `VAULTSTREAM_S3_ACCESS_KEY` / `VAULTSTREAM_S3_SECRET_KEY` | S3 destination | Never written to `vaultstream.json` |
| `VAULTSTREAM_S3_BUCKET` / `VAULTSTREAM_S3_REGION` / `VAULTSTREAM_S3_ENDPOINT` | S3 destination (if not using a config file) | `ENDPOINT` needed for R2/B2, not AWS |
| `VAULTSTREAM_ENCRYPTION_KEY` | Encrypted backups | 32-byte hex string; generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

### S3-compatible destinations

Works with AWS S3, [Cloudflare R2](https://developers.cloudflare.com/r2/), and
[Backblaze B2](https://www.backblaze.com/b2/) — anything speaking the S3 API.
`vaultstream init` has presets with endpoint hints for R2 and B2. Uploads stream via
multipart upload ([`@aws-sdk/lib-storage`](https://www.npmjs.com/package/@aws-sdk/lib-storage))
— a multi-GB database dump is never buffered in memory or written to a temp file.

## Scheduling

### cron

```cron
# Hourly backup, logged, alerting on failure via your MTA/monitoring of choice
0 * * * * cd /path/to/project && \
  SUPABASE_DB_URL="postgresql://vaultstream_backup:***@db.xxxx.supabase.co:5432/postgres" \
  SUPABASE_URL="https://xxxx.supabase.co" \
  SUPABASE_SERVICE_ROLE_KEY="***" \
  VAULTSTREAM_S3_ACCESS_KEY="***" \
  VAULTSTREAM_S3_SECRET_KEY="***" \
  VAULTSTREAM_ENCRYPTION_KEY="***" \
  npx vaultstream backup --dest s3 --json >> /var/log/vaultstream.log 2>&1 || \
  echo "vaultstream backup failed" | mail -s "Backup failure" you@example.com
```

### GitHub Actions

```yaml
# .github/workflows/backup.yml
name: Hourly Supabase backup

on:
  schedule:
    - cron: "0 * * * *"
  workflow_dispatch:

jobs:
  backup:
    runs-on: ubuntu-latest
    steps:
      - name: Install PostgreSQL client
        run: sudo apt-get update && sudo apt-get install -y postgresql-client-16

      - name: Run vaultstream backup
        env:
          SUPABASE_DB_URL: ${{ secrets.SUPABASE_DB_URL }}
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
          VAULTSTREAM_S3_ACCESS_KEY: ${{ secrets.VAULTSTREAM_S3_ACCESS_KEY }}
          VAULTSTREAM_S3_SECRET_KEY: ${{ secrets.VAULTSTREAM_S3_SECRET_KEY }}
          VAULTSTREAM_S3_BUCKET: ${{ secrets.VAULTSTREAM_S3_BUCKET }}
          VAULTSTREAM_S3_REGION: auto
          VAULTSTREAM_S3_ENDPOINT: ${{ secrets.VAULTSTREAM_S3_ENDPOINT }}
          VAULTSTREAM_ENCRYPTION_KEY: ${{ secrets.VAULTSTREAM_ENCRYPTION_KEY }}
        run: npx vaultstream backup --dest s3 --json
```

Why not just a bare `pg_dump` cron job or GitHub Action? Cron jobs fail silently — you
find out during a real restore, when it's too late. They also don't touch Supabase
Storage files, and nobody's checking whether the dump actually restores.
`vaultstream` alerts on failure via its exit code and is built around the assumption
that an untested backup isn't a backup.

## Security

**`vaultstream` never wants your admin database credentials.** Create a read-only
role and use that instead:

```sql
-- Run this once in the Supabase SQL editor (as an admin).
-- Creates a LOGIN role that can only ever SELECT — it cannot INSERT,
-- UPDATE, DELETE, or modify schema, no matter what happens to its
-- credentials.

CREATE ROLE vaultstream_backup WITH LOGIN PASSWORD 'REPLACE_WITH_A_STRONG_PASSWORD';

GRANT USAGE ON SCHEMA public TO vaultstream_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO vaultstream_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO vaultstream_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO vaultstream_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO vaultstream_backup;

GRANT USAGE ON SCHEMA auth TO vaultstream_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA auth TO vaultstream_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA auth TO vaultstream_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA auth
  GRANT SELECT ON TABLES TO vaultstream_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA auth
  GRANT SELECT ON SEQUENCES TO vaultstream_backup;

GRANT USAGE ON SCHEMA storage TO vaultstream_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA storage TO vaultstream_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA storage TO vaultstream_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA storage
  GRANT SELECT ON TABLES TO vaultstream_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA storage
  GRANT SELECT ON SEQUENCES TO vaultstream_backup;

-- pg_dump reads sequence state (last_value/is_called) for every serial /
-- identity column, so SELECT ON SEQUENCES is required alongside SELECT ON
-- TABLES — omitting it fails with "permission denied for sequence ...".

-- vaultstream dumps only public, auth, and storage by default (see the
-- "schemas" config option to add more). Don't bother granting access to
-- Supabase's other internal schemas like "realtime" — their tables belong to
-- extensions that stay locked down regardless of GRANT, and they hold no
-- application data anyway.
```

What `vaultstream` can and cannot do with these credentials:

- ✅ **Can** read every row in every table the role is granted `SELECT` on.
- ✅ **Can** read every object in every Storage bucket (via the service role key, used
  only for the Storage API, never for direct database access).
- ❌ **Cannot** write, update, or delete anything — the database role is read-only at
  the Postgres privilege level, not just "by convention."
- ❌ **Cannot** modify your project settings, auth config, or anything outside the
  data it's backing up.

**Credential handling:**
- Credentials are read once from environment variables and used in-memory; they are
  never written to `vaultstream.json`, logs, or disk.
- Every error path runs through a single `redactSecrets()` utility that strips
  connection-string passwords, JWTs, and access keys before anything is printed —
  this is unit-tested (`tests/unit/redact.test.ts`).
- Revoke the role (`DROP ROLE vaultstream_backup`) at any time and `vaultstream`
  instantly loses all access.

**Encryption:** if `VAULTSTREAM_ENCRYPTION_KEY` is set, the database dump is encrypted
with AES-256-GCM (authenticated encryption — tampering is detected, not just
theoretically prevented) before it ever leaves your machine, streamed through Node's
native `crypto` module. The key never leaves your environment; `vaultstream` does not
transmit it anywhere. **Losing the key means losing the ability to decrypt that
backup — there is no recovery mechanism, by design.**

## Troubleshooting

### `permission denied for schema auth` / `... for schema realtime` / etc.

`pg_dump` only requests the schemas listed in `schemas` (default `public`, `auth`,
`storage`) — but the read-only role still needs an explicit `GRANT` on each one. Two
possible fixes:

- **You added a schema to `schemas`/`--schemas` that the role hasn't been granted on
  yet.** Run the three `GRANT`/`ALTER DEFAULT PRIVILEGES` lines for that schema (see
  [Security](#security) above) with your role name.
- **The error mentions `realtime` (or another schema you didn't ask for).** You're
  likely running a pre-0.1.3 version, or have `schemas` configured to include it
  explicitly. `realtime`'s tables belong to an extension and aren't SELECT-able by a
  restricted role no matter what you grant — remove it from `schemas` and let the
  default (`public,auth,storage`) apply instead.

### `permission denied for sequence ..._id_seq`

`pg_dump` reads sequence state (`last_value`/`is_called`) for every `serial` or
`identity` column — granting `SELECT` on tables isn't enough on its own. Run the
`GRANT SELECT ON ALL SEQUENCES IN SCHEMA ...` and matching `ALTER DEFAULT
PRIVILEGES ... GRANT SELECT ON SEQUENCES` lines from the [Security](#security)
section for the schema the error names.

### `permission denied for table migrations` (or `s3_multipart_uploads`, etc.)

Two different causes, same symptom:

- **Most likely: your blanket `GRANT SELECT ON ALL TABLES IN SCHEMA storage` ran
  before Supabase added this table to your project.** `GRANT ... ALL TABLES` is a
  snapshot at the moment you run it — it doesn't retroactively cover tables
  Supabase's own migrations add later. Re-run it now to pick up everything current:
  ```sql
  GRANT SELECT ON ALL TABLES IN SCHEMA storage TO vaultstream_backup;
  GRANT SELECT ON ALL SEQUENCES IN SCHEMA storage TO vaultstream_backup;
  ```
  You may need to do this again in the future if Supabase adds more tables.
- **If re-granting doesn't help**, the table is likely extension-internal
  bookkeeping that isn't grantable at all on your project (the same class of
  restriction as `auth`, just at a single-table level instead of a whole schema).
  `vaultstream` already excludes the three tables known to hit this
  (`storage.migrations`, `storage.s3_multipart_uploads`,
  `storage.s3_multipart_uploads_parts`) via `excludeTables` by default — none of
  them hold data worth backing up anyway. If a *different* table hits this, add it:
  ```bash
  vaultstream backup --exclude-tables storage.migrations,storage.s3_multipart_uploads,storage.s3_multipart_uploads_parts,storage.the_new_one
  ```
  or add it to `vaultstream.json`'s `excludeTables` array so you don't have to pass
  the flag every time.

### `GRANT USAGE ON SCHEMA auth` "succeeds" but `auth` still fails / never appears in `nspacl`

On hosted Supabase projects, the `auth` schema is owned by Supabase's internal
`supabase_admin` role — which customers cannot assume, not even via `postgres`
(despite Supabase's dashboard labeling `postgres` as "Superuser"). You can confirm
this yourself:

```sql
-- Check the raw ACL — your role won't be in this list even after a
-- "successful" GRANT, if you're hitting this platform restriction.
SELECT nspacl FROM pg_namespace WHERE nspname = 'auth';

-- Confirm postgres has no path to supabase_admin's authority.
SELECT r.rolname FROM pg_auth_members m
  JOIN pg_roles r ON r.oid = m.roleid
  JOIN pg_roles u ON u.oid = m.member
  WHERE u.rolname = 'postgres';
```

If `auth`'s ACL never includes your role no matter how many times you `GRANT`, and
`postgres` isn't a member of `supabase_admin`, this is a platform-level restriction,
not a mistake in your SQL. There's no self-service SQL workaround. Practically:

- Drop `auth` from `schemas` and back up `public` + `storage` only:
  ```json
  { "schemas": ["public", "storage"] }
  ```
- If you specifically need `auth.users` data, contact Supabase support and ask them
  to grant your role access, or export it separately via the Auth Admin API
  (`GET /auth/v1/admin/users`, authenticated with the service role key) —
  `vaultstream` doesn't do this automatically today.

This doesn't affect everyone — it depends on your project's specific ACL setup — so
`auth` stays in the default `schemas` list. If your project *can* grant `auth`
access, nothing above applies to you.

### `pg_dump version (X) does not match the server version (Y)`

Supabase upgrades its Postgres version over time; your local `pg_dump` needs to be
the same major version to guarantee a clean dump/restore. Install the matching
client tools for your OS (see [Installation](#installation)), pointing at the major
version the error message reports for the server. If you understand the risk and
want to proceed anyway (minor mismatches are often fine), re-run with
`--no-version-check`.

## How backups are structured

```
<destination>/
  db/
    backup-2026-07-09T14-00-00.000Z.dump.gz.enc   # pg_dump --format=custom, gzipped, optionally encrypted
  storage/
    <bucket>/<path>                                # mirrors your Supabase Storage layout exactly
  manifests/
    2026-07-09T14-00-00.000Z.json                  # sizes, sha256, table/file counts, duration
```

Everything is streamed end-to-end — a database dump is piped through gzip
(and encryption, if enabled) directly into the destination via constant-memory
streams. A 50 GB database and a 500 MB one use the same amount of RAM.

## Development

```bash
git clone https://github.com/EhtishamHafeez/vaultstream.git
cd vaultstream
npm install
npm run build
node dist/cli.js backup --help
```

```bash
npm test                 # unit tests (fast, no external dependencies)
npm run test:integration # spins up postgres:16 in Docker, backs up, restores, asserts row counts match
npm run lint
npm run typecheck
```

## Roadmap

The CLI is the whole product today, and it's **MIT-licensed and will stay free
forever.** A hosted version is planned at **[vaultstream.dev](https://vaultstream.dev)**
for people who'd rather not run their own cron job:

- Managed hourly scheduling (no cron/CI to babysit)
- Automated restore verification — every backup auto-restored into a throwaway
  database and checked, not just checksummed
- Email/Slack alerts on backup or restore-verification failure
- A dashboard across multiple Supabase projects

If you don't need any of that, the CLI you have right now is the complete, permanent,
free way to back up a Supabase project properly.

## License

MIT © Vaultstream — see [LICENSE](./LICENSE).
