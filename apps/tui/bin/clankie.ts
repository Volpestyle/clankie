#!/usr/bin/env node
// The `clankie` command exposes non-interactive controls or attaches the
// fullscreen face to the one healthy clankie service.
import { resolve } from "node:path";
import { ensureCaptainCredential, ensureOperatorCredential } from "@clankie/credential-broker";
import { discordSettingsToEnvironment, SettingsStore } from "@clankie/settings";
import { isHeadlessCaptainCommand, runHeadlessCaptainCommand } from "./headless-captain.ts";
import { startOne } from "./services.ts";
import { parseDirectConversation } from "../src/session/operator-conversations.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");

// Every child fills its own env from settings. The launcher consumes only the
// active-body switches and activity tunnel, so project just those; copying the
// whole settings tree into child env would turn stored per-turn authorization
// into an immutable environment override until restart.
const launcherDiscordEnvironment = discordSettingsToEnvironment((await new SettingsStore().load()).discord);
for (const name of [
  "DISCORD_ACTIVE_BODY",
  "DISCORD_USER_SESSION_ENABLED",
  "CLANKIE_ACTIVITY_TUNNEL_NAME",
  "CLANKIE_ACTIVITY_TUNNEL_HOSTNAME",
] as const) {
  const configured = launcherDiscordEnvironment[name];
  if ((process.env[name]?.length ?? 0) === 0 && configured !== undefined) process.env[name] = configured;
}
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
