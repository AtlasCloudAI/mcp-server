#!/usr/bin/env node
// Writes telemetry-key.json (the PostHog project key the published package
// sends usage events with) from ATLASCLOUD_TELEMETRY_BUILD_KEY at build time,
// the way the Atlas CLI injects its key with -ldflags. The key is a PostHog
// project token (write-only, "phc_..."), kept out of the repository so forks
// and source builds send nothing. Without it the build still succeeds and the
// package simply ships with telemetry off.
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "telemetry-key.json");
const key = process.env.ATLASCLOUD_TELEMETRY_BUILD_KEY?.trim();

if (key) {
  if (!key.startsWith("phc_")) {
    console.error("ATLASCLOUD_TELEMETRY_BUILD_KEY must be a PostHog project token (phc_...)");
    process.exit(1);
  }
  writeFileSync(target, JSON.stringify({ key }) + "\n");
  console.error("telemetry-key.json written");
} else if (existsSync(target)) {
  console.error("telemetry-key.json kept from an earlier build");
} else {
  console.error("ATLASCLOUD_TELEMETRY_BUILD_KEY not set: this build ships with telemetry off");
}
