import * as clack from "@clack/prompts";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { CONFIG_FILENAME, type VaultstreamFileConfig } from "../lib/config.js";
import { readOnlyRoleSql } from "../lib/sql-snippets.js";
import { writeFile } from "node:fs/promises";

const S3_PRESETS = {
  aws: { label: "AWS S3", endpointHint: undefined, endpointRequired: false },
  r2: {
    label: "Cloudflare R2",
    endpointHint: "https://<ACCOUNT_ID>.r2.cloudflarestorage.com",
    endpointRequired: true,
  },
  b2: {
    label: "Backblaze B2",
    endpointHint: "https://s3.<region>.backblazeb2.com",
    endpointRequired: true,
  },
  custom: { label: "Custom / other S3-compatible", endpointHint: undefined, endpointRequired: true },
} as const;

function bail(): never {
  clack.cancel("Setup cancelled — nothing was written.");
  process.exit(1);
}

export async function initCommand(): Promise<void> {
  clack.intro("vaultstream init");

  clack.note(
    "vaultstream never wants your admin database credentials.\n" +
      "Create a read-only role instead — it can only ever SELECT.",
    "Step 1 — read-only database role"
  );
  console.log("\n" + readOnlyRoleSql() + "\n");

  const wantsStorage = await clack.confirm({
    message: "Also back up Supabase Storage files (bucket contents), not just the database?",
    initialValue: true,
  });
  if (clack.isCancel(wantsStorage)) bail();

  const destinationType = await clack.select({
    message: "Where should backups be stored?",
    options: [
      { value: "local" as const, label: "Local directory", hint: "zero-friction, good for a first test" },
      { value: "s3" as const, label: "S3-compatible bucket", hint: "AWS S3, Cloudflare R2, Backblaze B2, ..." },
    ],
  });
  if (clack.isCancel(destinationType)) bail();

  let destination: VaultstreamFileConfig["destination"];

  if (destinationType === "local") {
    const localPath = await clack.text({
      message: "Local directory path",
      placeholder: "./vaultstream-backups",
      defaultValue: "./vaultstream-backups",
    });
    if (clack.isCancel(localPath)) bail();
    destination = { type: "local", path: String(localPath || "./vaultstream-backups") };
  } else {
    const presetOptions = Object.entries(S3_PRESETS).map(([value, cfg]) => ({ value, label: cfg.label }));
    const presetResult = await clack.select({ message: "S3 provider", options: presetOptions });
    if (clack.isCancel(presetResult)) bail();
    const preset = presetResult as keyof typeof S3_PRESETS;
    const presetConfig = S3_PRESETS[preset];

    let endpoint: string | undefined;
    if (presetConfig.endpointRequired) {
      const endpointInput = await clack.text({
        message: `Endpoint URL${presetConfig.endpointHint ? ` (e.g. ${presetConfig.endpointHint})` : ""}`,
        placeholder: presetConfig.endpointHint,
        validate: (value) => (value ? undefined : "An endpoint is required for this provider."),
      });
      if (clack.isCancel(endpointInput)) bail();
      endpoint = String(endpointInput);
    }

    const region = await clack.text({
      message: "Region",
      placeholder: preset === "aws" ? "us-east-1" : "auto",
      defaultValue: preset === "aws" ? "us-east-1" : "auto",
    });
    if (clack.isCancel(region)) bail();

    const bucket = await clack.text({
      message: "Bucket name",
      validate: (value) => (value ? undefined : "A bucket name is required."),
    });
    if (clack.isCancel(bucket)) bail();

    destination = {
      type: "s3",
      endpoint,
      region: String(region || "auto"),
      bucket: String(bucket),
      forcePathStyle: preset !== "aws",
    };
  }

  const wantsEncryption = await clack.confirm({
    message: "Encrypt the database dump with AES-256-GCM?",
    initialValue: true,
  });
  if (clack.isCancel(wantsEncryption)) bail();

  const config: VaultstreamFileConfig = {
    destination,
    storage: { enabled: Boolean(wantsStorage) },
    encryption: { enabled: Boolean(wantsEncryption) },
  };

  const configPath = path.join(process.cwd(), CONFIG_FILENAME);
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");

  clack.log.success(`Wrote ${CONFIG_FILENAME}`);

  const envLines: string[] = [];
  envLines.push("SUPABASE_DB_URL=postgresql://vaultstream_backup:<password>@<db-host>:5432/postgres");
  if (wantsStorage) {
    envLines.push("SUPABASE_URL=https://<project-ref>.supabase.co");
    envLines.push("SUPABASE_SERVICE_ROLE_KEY=<service-role-key, from Project Settings > API>");
  }
  if (destination.type === "s3") {
    envLines.push("VAULTSTREAM_S3_ACCESS_KEY=<access-key-id>");
    envLines.push("VAULTSTREAM_S3_SECRET_KEY=<secret-access-key>");
  }
  if (wantsEncryption) {
    const generatedKey = randomBytes(32).toString("hex");
    envLines.push(`VAULTSTREAM_ENCRYPTION_KEY=${generatedKey}`);
  }

  clack.note(
    envLines.join("\n") +
      "\n\nNever commit these. Put them in your shell profile, a .env file " +
      "(gitignored), or your CI/cron secrets store.",
    "Step 2 — set these environment variables"
  );

  if (wantsEncryption) {
    clack.log.warn(
      "Save VAULTSTREAM_ENCRYPTION_KEY somewhere durable (password manager, secrets vault). " +
        "If you lose it, encrypted backups cannot be decrypted — not by you, not by anyone."
    );
  }

  clack.outro("Run `vaultstream backup` when your env vars are set.");
}
