import { access } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { connectHostedCli } from "../src/command/hosted.ts";
// The `clankie` command exposes non-interactive controls or attaches the
// fullscreen face to the one healthy clankie service.
import { resolve } from "node:path";
import { ensureCaptainCredential, ensureOperatorCredential } from "@clankie/credential-broker";
import { discordSettingsToEnvironment, SettingsStore } from "@clankie/settings";
import packageMetadata from "../../../package.json" with { type: "json" };
import {
  isHeadlessCaptainCommand,
  runHeadlessCaptainCommand,
  unknownLauncherCommand,
} from "./headless-captain.ts";
import { KEEP_AWAKE_ENV, startOne } from "./services.ts";
import { parseDirectConversation } from "../src/session/operator-conversations.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");

if (process.argv[2] === "--version" || process.argv[2] === "-V") {
  process.stdout.write(`clankie ${packageMetadata.version}\n`);
  process.exit(0);
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
const unknown = unknownLauncherCommand(args[0]);
if (unknown !== undefined) {
  process.stderr.write(`clankie: ${unknown}\n`);
  process.exit(1);
}

if (
  args[0] === undefined ||
  args[0] === "health" ||
  args[0] === "status" ||
  args[0] === "restart" ||
  args[0] === "start" ||
  args[0] === "stop" ||
  args[0] === "down"
) {
  await applyLauncherDiscordEnvironment();
}

if (isHeadlessCaptainCommand(args[0])) {
  process.exitCode = await runHeadlessCaptainCommand(args, { repoRoot });
} else {
  await runOperatorConsole();
}

async function applyLauncherDiscordEnvironment(): Promise<void> {
  // Every child fills its own env from settings. The launcher consumes only the
  // active-body switches and activity tunnel, so project just those for commands
  // that inspect or change the process graph. Config commands read the store
  // directly; projecting first would falsely report stored values as env overrides.
  const stored = await new SettingsStore().load();
  const configured = discordSettingsToEnvironment(stored.discord);
  for (const name of [
    "DISCORD_ACTIVE_BODY",
    "DISCORD_USER_SESSION_ENABLED",
    "CLANKIE_ACTIVITY_TUNNEL_NAME",
    "CLANKIE_ACTIVITY_TUNNEL_HOSTNAME",
  ] as const) {
    const value = configured[name];
    if ((process.env[name]?.length ?? 0) === 0 && value !== undefined) process.env[name] = value;
  }
  // The owner's always-on opt-in decides whether the launcher runs `caffeinate`.
  if ((process.env[KEEP_AWAKE_ENV]?.length ?? 0) === 0 && stored.host.keepAwake) {
    process.env[KEEP_AWAKE_ENV] = "1";
  }
}

async function runOperatorConsole(): Promise<void> {
  const settings = new SettingsStore();
  let current = await settings.load();
  if (
    !current.client &&
    !(await access(settings.path).then(
      () => true,
      () => false,
    ))
  ) {
    if (!process.stdin.isTTY)
      throw new Error(
        "First run needs a TTY to choose local or hosted; use clankie connect hosted for headless sign-in",
      );
    const input = createInterface({ input: process.stdin, output: process.stderr });
    let choice;
    try {
      choice = await input.question(
        "1. Run Clankie on this Mac\n2. Connect to my hosted Clankie\nChoose 1 or 2: ",
      );
    } finally {
      input.close();
    }
    if (choice.trim() === "2") await connectHostedCli(["hosted"]);
    else if (choice.trim() === "1")
      await settings.update((value) => ({ ...value, client: { mode: "local" } }));
    else throw new Error("No connection mode selected");
    current = await settings.load();
  }
  if (current.client?.mode === "hosted") {
    const { runHostedConsole } = await import("../src/hosted-console.ts");
    await runHostedConsole();
    return;
  }

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
