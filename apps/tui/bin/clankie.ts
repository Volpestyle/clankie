#!/usr/bin/env node
// The `clankie` command attaches to one healthy shared captain service or
// starts it before booting this operator-console face.
import { resolve } from "node:path";
import { ensureCaptainService } from "./captain-service.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
let captain;
try {
  captain = await ensureCaptainService({ repoRoot, env: process.env });
} catch (error) {
  process.stderr.write(`clankie: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
process.env.SAPLING_CAPTAIN_URL = captain.host;
await import("../src/index.ts");
