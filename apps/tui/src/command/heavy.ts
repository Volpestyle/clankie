import {
  createResourceGovernor,
  heavyJobLane,
  resourceHolderIdentity,
  type FleetResourceGovernor,
} from "@clankie/fleet-resources";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { Writable } from "./io.ts";
import { seatIdentity } from "./seat-identity.ts";

/** Executes locally even when this CLI is configured as a hosted client. */
export async function runHeavyCommand(
  args: readonly string[],
  options: { governor?: FleetResourceGovernor; stderr?: Writable; env?: NodeJS.ProcessEnv } = {},
): Promise<number> {
  const env = options.env ?? process.env;
  let separator = 0;
  // A Herdr pane, else the desktop-app terminal this command runs in (ADR 0319).
  let seatId = seatIdentity(env).pane;
  let holderId = resourceHolderIdentity(env);
  let server = false;
  while (["--seat", "--holder", "--server"].includes(args[separator] ?? "")) {
    const flag = args[separator++];
    if (flag === "--server") {
      server = true;
      continue;
    }
    const value = args[separator++];
    if (!value || value.length > 256 || /\p{Cc}/u.test(value))
      throw new Error("Invalid fleet resource label");
    if (flag === "--seat") seatId = value;
    else holderId = value;
  }
  if (args[separator] !== "--" || !args[separator + 1])
    throw new Error("Usage: clankie heavy [--server] [--seat LABEL] [--holder ID] -- <command> [args...]");
  const command = args[separator + 1]!;
  const problem = commandProblem(command, env, process.cwd());
  if (problem !== undefined) {
    // Checked before asking for a slot: a missing command never waits or looks like a governor fault (#380).
    (options.stderr ?? process.stderr).write(
      `clankie heavy: ${problem === "missing" ? "command not found" : "cannot run command (not executable)"}: ${command}\n`,
    );
    return problem === "missing" ? 127 : 126;
  }
  const governor = options.governor ?? createResourceGovernor();
  let waiting = false;
  const shownAlerts = new Set<string>();
  const lane = server ? "server" : heavyJobLane(command, args.slice(separator + 2));
  try {
    return await governor.runHeavy(command, args.slice(separator + 2), {
      ...(seatId === undefined ? {} : { seatId }),
      ...(holderId === undefined ? {} : { holderId }),
      ...(server ? { server: true } : {}),
      onWait: (snapshot) => {
        if (!waiting) {
          waiting = true;
          (options.stderr ?? process.stderr).write(
            lane === "server"
              ? `clankie heavy: server lane waiting (${snapshot.capacity.serverUsed}/${snapshot.capacity.serverSlots} held, ${snapshot.serverQueue?.length ?? 0} queued, ${snapshot.capacity.serverCpuCores} CPU cores shared)\n`
              : lane === "light"
                ? `clankie heavy: light lane waiting (${snapshot.capacity.lightUsed}/${snapshot.capacity.lightSlots} held, ${snapshot.lightQueue.length} queued)\n`
                : `clankie heavy: waiting for a heavy slot (${snapshot.capacity.used}/${snapshot.capacity.heavySlots} held, ${snapshot.queue.length} queued)\n`,
          );
        }
        for (const alert of snapshot.holderAlerts ?? []) {
          const key = `${alert.id}:${alert.reason}`;
          if (shownAlerts.has(key)) continue;
          shownAlerts.add(key);
          (options.stderr ?? process.stderr).write(
            `  ${alert.reason}: ${[alert.seatId, alert.holderId, alert.executable]
              .filter(Boolean)
              .join(" / ")
              .replace(
                /\p{Cc}/gu,
                "",
              )} · ${alert.lane} · held ${Math.floor((Date.now() - alert.createdAtMs) / 60_000)}m\n`,
          );
        }
      },
    });
  } finally {
    if (options.governor === undefined) await governor.close();
  }
}

/**
 * Whether the command can be started as the runner will start it: a path is
 * taken relative to the working directory, a bare name is looked up on PATH.
 * Windows resolution (PATHEXT) is left to the runner.
 */
function commandProblem(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): "missing" | "denied" | undefined {
  if (process.platform === "win32") return undefined;
  const candidates = command.includes("/")
    ? [isAbsolute(command) ? command : resolve(cwd, command)]
    : (env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => join(directory, command));
  let found = false;
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate, { throwIfNoEntry: false })?.isFile()) continue;
      found = true;
      accessSync(candidate, constants.X_OK);
      return undefined;
    } catch {
      // Unreadable, or present but not executable; a later PATH entry may still be.
    }
  }
  return found ? "denied" : "missing";
}
