#!/usr/bin/env node
// The `clankie` command exposes non-interactive captain controls or attaches
// the fullscreen face to one healthy shared captain service.
import { resolve } from "node:path";
import { ensureCaptainService } from "./captain-service.ts";
import { isHeadlessCaptainCommand, runHeadlessCaptainCommand } from "./headless-captain.ts";
import { parseDirectConversation } from "../src/session/operator-conversations.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
let direct;
try {
  direct = parseDirectConversation(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`clankie: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
// `--chat` is validated here and stripped from the headless-command args; the
// operator console (src/index.ts) re-parses argv and resolves/persists the
// selection against the server, so no process-global env couples the lane.
const args = direct.remaining;

if (isHeadlessCaptainCommand(args[0])) {
  process.exitCode = await runHeadlessCaptainCommand(args, { repoRoot });
} else {
  await runOperatorConsole();
}

async function runOperatorConsole(): Promise<void> {
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
    process.exitCode = 1;
    return;
  }
  stopStatus();
  process.env.CLANKIE_CAPTAIN_URL = captain.host;
  if (captain.generation !== undefined) process.env.CLANKIE_CAPTAIN_GENERATION = captain.generation;
  await import("../src/index.ts");
}
