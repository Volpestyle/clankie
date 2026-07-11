#!/usr/bin/env node
// The `clankie` command attaches to one healthy shared captain service or
// starts it before booting this operator-console face.
import { resolve } from "node:path";
import { ensureCaptainService } from "./captain-service.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
let status = "Starting Clankie…";
let frame = 0;
const renderStatus = (): void => {
  if (process.stderr.isTTY) {
    process.stderr.write(`\r\u001B[2K${frames[frame++ % frames.length]} Clankie · ${status}`);
  }
};
const timer = process.stderr.isTTY ? setInterval(renderStatus, 80) : undefined;
renderStatus();
const updateStatus = (next: string): void => {
  status = next;
  if (!process.stderr.isTTY) process.stderr.write(`clankie: ${next}\n`);
  else renderStatus();
};
const stopStatus = (): void => {
  if (timer !== undefined) clearInterval(timer);
  if (process.stderr.isTTY) process.stderr.write("\r\u001B[2K");
};
let captain;
try {
  captain = await ensureCaptainService({ repoRoot, env: process.env, onStatus: updateStatus });
} catch (error) {
  stopStatus();
  process.stderr.write(`clankie: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
stopStatus();
process.env.SAPLING_CAPTAIN_URL = captain.host;
if (captain.generation !== undefined) process.env.SAPLING_CAPTAIN_GENERATION = captain.generation;
await import("../src/index.ts");
