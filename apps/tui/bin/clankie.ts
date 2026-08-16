#!/usr/bin/env node
// The `clankie` command exposes non-interactive controls or attaches the
// fullscreen face to the one healthy clankie service.
import { resolve } from "node:path";
import { ensureCaptainCredential, ensureOperatorCredential } from "@clankie/credential-broker";
import { applyDiscordSettingsToEnvironment, SettingsStore } from "@clankie/settings";
import { isHeadlessCaptainCommand, runHeadlessCaptainCommand } from "./headless-captain.ts";
import { startOne } from "./services.ts";
import { parseDirectConversation } from "../src/session/operator-conversations.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");

// Every spawned service fills its own env from the settings store at startup,
// which is enough for settings a *child* consumes. The activity tunnel is the
// exception: the launcher itself decides whether to run it, what to name it,
// and which hostname to probe, so an unfilled env here means a configured
// tunnel silently reports "not configured; activity stays local" and no tunnel
// is ever started. That is exactly what happened on 2026-08-02 — the settings
// were correct, the README described this path, and the launcher could not see
// either value. Fill before any service registry read.
applyDiscordSettingsToEnvironment((await new SettingsStore().load()).discord);
let direct;
try {
  direct = parseDirectConversation(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`clankie: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
// `--chat` is validated here and stripped from the headless-command args; the
// operator console (src/index.ts) re-parses argv and confirms the explicit
// resume against the server, so no process-global env couples the lane.
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
  try {
    await ensureOperatorCredential({ env: process.env });
    // Half of the shared captain secret; the service's dispatch route
    // authenticates it. A brokering failure degrades rather than blocks.
    let captainToken: string | undefined;
    try {
      captainToken = (await ensureCaptainCredential({ env: process.env })).token;
    } catch {
      captainToken = undefined;
    }
    await startOne("clankie", {
      repoRoot,
      env: process.env,
      captainToken,
      onStatus: updateStatus,
    });
  } catch (error) {
    stopStatus();
    process.stderr.write(`clankie: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }
  stopStatus();
  await import("../src/index.ts");
}
