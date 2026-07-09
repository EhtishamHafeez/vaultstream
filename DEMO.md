# Recording the demo GIF

Exact commands to record a terminal demo for the launch / Reddit post. Two options
below: [VHS](#option-a-vhs-recommended) (scripted, reproducible, no flaky timing) or
a plain manual recording.

## Prerequisites

- A throwaway Supabase project (free tier is fine) with a couple of tables and a
  Storage bucket with a handful of files in it — don't use a real/production project.
- The read-only role from the README's [Security](./README.md#security) section
  created on that project.
- `vaultstream` built locally (`npm run build`) or installed globally.

Set up env vars for the demo project (a throwaway one — see above):

```bash
export SUPABASE_DB_URL="postgresql://vaultstream_backup:***@db.xxxx.supabase.co:5432/postgres"
export SUPABASE_URL="https://xxxx.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="***"
```

## Option A: VHS (recommended)

[VHS](https://github.com/charmbracelet/vhs) scripts a terminal session into a GIF —
no flaky manual timing, and it's re-recordable whenever the CLI's output changes.

```bash
brew install vhs   # or: go install github.com/charmbracelet/vhs@latest
```

Save as `demo.tape`:

```tape
Output demo.gif

Set FontSize 16
Set Width 1000
Set Height 600
Set Theme "Dracula"
Set TypingSpeed 40ms

Type "npx vaultstream init"
Enter
Sleep 1s
# Walk through the prompts manually if recording interactively, or Ctrl+C
# and re-record this section once vaultstream.json already exists.

Type "npx vaultstream backup"
Enter
Sleep 5s

Type "npx vaultstream list"
Enter
Sleep 2s
```

Then:

```bash
vhs demo.tape
```

This produces `demo.gif`, ready to attach to the Reddit post / README.

## Option B: Manual recording

Using `asciinema` + [`agg`](https://github.com/asciinema/agg) (asciinema-to-gif):

```bash
brew install asciinema agg

asciinema rec demo.cast
# --- inside the recording ---
npx vaultstream init          # walk through the prompts once, live
npx vaultstream backup        # the money shot — pretty ✓ lines streaming in
npx vaultstream list
exit
# --- recording stops ---

agg demo.cast demo.gif
```

## What the demo should show, in order

1. `vaultstream init` — a couple of prompts (destination: local dir, storage: yes,
   encryption: yes), ending with the printed env var list. Trims well if you cut
   after 2-3 prompts and jump-cut to the result.
2. `vaultstream backup` — the full pretty output:
   ```
   ✓ pg_dump streamed to ./vaultstream-backups/db/backup-2026-07-09T14-00-00.000Z.dump.gz.enc (2.1 MB, 3s)
   ✓ 14 storage files synced (14 new, 0 updated) in 2s
   ✓ manifest written — 6 tables, sha256 verified
   ```
3. `vaultstream list` — showing the backup that was just taken, proving it's real
   and queryable, not just log output.

Keep it under ~20 seconds total — that's the sweet spot for a GIF that autoplays in
a Reddit/Twitter feed.
