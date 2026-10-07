import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createServiceOptions,
  parseServiceTarget,
  resolveRestartTargets,
  resolveTargets,
  restartTarget,
  startTarget,
  stopTarget,
  type CreateServiceOptionsInput,
  type ServiceOutcome,
  type ServiceTarget,
} from "../../bin/services.ts";
import { updateHoldingServices } from "../../bin/runtime-updater.ts";
import { clearRecoveryIntent } from "../../bin/service-recovery.ts";
import { commandHost, outputJson } from "./io.ts";
import { clankieStateHome } from "../state-home.ts";

const RESTART_TURN_POLL_MS = 100;
const RESTART_AFTER_TURN_FLAG = "--after-operator-turn";
const RESTART_AFTER_PI_FLAG = "--after-pi-turn";
const RESTART_TURN_TIMEOUT_MS = 10 * 60 * 1_000;

export interface RestartCommandOptions extends CreateServiceOptionsInput {
  readonly host?: string;
  readonly sleepImpl?: (ms: number) => Promise<void>;
  readonly cliEntryPath?: string;
  readonly stdout?: { write(chunk: string): unknown };
}

function describeOutcomes(outcomes: readonly ServiceOutcome[]): string {
  return outcomes
    .map((outcome) =>
      outcome.ok
        ? `✓ ${outcome.label}${outcome.detail === undefined ? "" : ` (${outcome.detail})`}`
        : `✗ ${outcome.label}: ${outcome.error ?? outcome.state ?? "failed"}`,
    )
    .join("\n");
}

interface RestartTurnHandoff {
  readonly eventsPath: string;
  readonly runId: string;
  readonly kind?: "pi";
}

function turnPhases(eventsPath: string): Map<string, string> {
  const phases = new Map<string, string>();
  for (const line of readFileSync(eventsPath, "utf8").split("\n")) {
    if (line.length === 0) continue;
    try {
      const event = JSON.parse(line) as { type?: unknown; runId?: unknown; phase?: unknown };
      if (event.type === "turn" && typeof event.runId === "string" && typeof event.phase === "string") {
        phases.set(event.runId, event.phase);
      }
    } catch {
      // A trailing partial append is not a durable event yet; the next poll sees it.
    }
  }
  return phases;
}

function activeTurn(env: NodeJS.ProcessEnv): RestartTurnHandoff | undefined {
  const sessionFile = env.PI_SESSION_FILE?.trim();
  if (sessionFile === undefined || sessionFile.length === 0) return undefined;
  const piDirectory = dirname(sessionFile);
  // Discord's durable rooms and one-shot machine grants use native Pi trees,
  // not the operator conversation's adjacent events.jsonl. Watch only records
  // appended after this request, so an earlier final answer cannot release it.
  if (basename(piDirectory) !== "pi") {
    return { eventsPath: sessionFile, runId: String(statSync(sessionFile).size), kind: "pi" };
  }
  const eventsPath = join(dirname(piDirectory), "events.jsonl");
  try {
    const active = [...turnPhases(eventsPath)].find(([, phase]) => phase === "accepted");
    return active === undefined ? undefined : { eventsPath, runId: active[0] };
  } catch {
    return undefined;
  }
}

function refuseDuringUpdate(options: RestartCommandOptions): void {
  const held = updateHoldingServices(options.env ?? process.env);
  if (held !== undefined)
    throw new Error(
      `An update is ${held.phase} and restarts services itself; wait for it to finish (clankie update status), then retry.`,
    );
}

function restartIncludesClankie(target: ServiceTarget): boolean {
  return target === "all" || target === "clankie";
}

async function waitForTurn(
  handoff: RestartTurnHandoff,
  sleepImpl: (ms: number) => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + RESTART_TURN_TIMEOUT_MS;
  let offset = Number(handoff.runId);
  let pending = "";
  const decoder = new StringDecoder("utf8");
  for (;;) {
    let finished = false;
    if (handoff.kind === "pi") {
      const fd = openSync(handoff.eventsPath, "r");
      const buffer = Buffer.alloc(64 * 1024);
      try {
        const count = readSync(fd, buffer, 0, buffer.length, offset);
        offset += count;
        pending += decoder.write(buffer.subarray(0, count));
      } finally {
        closeSync(fd);
      }
      const records = pending.split("\n");
      pending = records.pop() ?? "";
      finished = records.some((line) => {
        try {
          const event = JSON.parse(line);
          return (
            event.type === "message" &&
            event.message?.role === "assistant" &&
            ["stop", "error", "aborted"].includes(event.message.stopReason)
          );
        } catch {
          return false;
        }
      });
    } else {
      const phase = turnPhases(handoff.eventsPath).get(handoff.runId);
      finished = phase === "completed" || phase === "failed" || phase === "cancelled";
    }
    if (finished) {
      // Give the caller's final result a chance to reach its transport. Discord
      // also retains unfinished deliveries in its durable inbox across restart.
      await sleepImpl(1_000);
      return;
    }
    if (Date.now() >= deadline)
      throw new Error("Restart cancelled: conversation turn did not settle within 10 minutes.");
    await sleepImpl(RESTART_TURN_POLL_MS);
  }
}

function scheduleRestartAfterTurn(
  target: ServiceTarget,
  handoff: RestartTurnHandoff,
  options: RestartCommandOptions,
): string {
  const cliEntryPath =
    options.cliEntryPath ??
    options.env?.CLANKIE_LAUNCHER_PATH ??
    process.env.CLANKIE_LAUNCHER_PATH ??
    process.argv[1];
  if (cliEntryPath === undefined || cliEntryPath.length === 0) {
    throw new Error("Cannot locate the clankie launcher for a deferred restart.");
  }
  const env = { ...(options.env ?? process.env) };
  delete env.PI_SESSION_FILE;
  delete env.PI_SESSION_ID;
  const logPath = join(clankieStateHome(env), "clankie", "restart.log");
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  const logFd = openSync(logPath, "a", 0o600);
  try {
    const child = (options.spawnImpl ?? spawn)(
      cliEntryPath,
      [
        "restart",
        target,
        handoff.kind === "pi" ? RESTART_AFTER_PI_FLAG : RESTART_AFTER_TURN_FLAG,
        handoff.eventsPath,
        handoff.runId,
      ],
      { detached: true, cwd: options.repoRoot, env, stdio: ["ignore", logFd, logFd] },
    );
    if (child.pid === undefined) throw new Error("Deferred restart helper did not start.");
    child.unref();
  } finally {
    closeSync(logFd);
  }
  return logPath;
}

export async function runRestartCommand(
  args: readonly string[],
  options: RestartCommandOptions,
): Promise<number> {
  const target = parseServiceTarget(args[0]);
  const afterTurn =
    args.length === 4 &&
    (args[1] === RESTART_AFTER_TURN_FLAG || args[1] === RESTART_AFTER_PI_FLAG) &&
    args[2] !== undefined &&
    args[3] !== undefined
      ? {
          eventsPath: args[2],
          runId: args[3],
          ...(args[1] === RESTART_AFTER_PI_FLAG ? { kind: "pi" as const } : {}),
        }
      : undefined;
  if (args.length > 1 && afterTurn === undefined) {
    throw new Error("Usage: clankie restart [service]");
  }
  if (
    afterTurn?.kind === "pi" &&
    (!/^\d+$/.test(afterTurn.runId) || !Number.isSafeInteger(Number(afterTurn.runId)))
  )
    throw new Error("Invalid Pi restart cursor");
  const stderr = options.stderr ?? process.stderr;
  const out = options.stdout ?? process.stdout;
  if (afterTurn !== undefined) {
    await waitForTurn(afterTurn, options.sleepImpl ?? sleep);
  } else if (restartIncludesClankie(target)) {
    const handoff = activeTurn(options.env ?? process.env);
    if (handoff !== undefined) {
      const logPath = scheduleRestartAfterTurn(target, handoff, options);
      stderr.write("Restart scheduled after this conversation turn completes.\n");
      outputJson(out, {
        ok: true,
        status: "scheduled",
        target,
        host: commandHost(options),
        ...(handoff.kind === "pi" ? { afterSession: handoff.eventsPath } : { afterRun: handoff.runId }),
        logPath,
      });
      return 0;
    }
  }
  refuseDuringUpdate(options);
  const registryOptions = await createServiceOptions(options);
  // The owner's restart ends any crash backoff or give-up for these services.
  clearRecoveryIntent(resolveRestartTargets(target), options.env ?? process.env);
  const outcomes = await restartTarget(target, registryOptions);
  const clankie = outcomes.find((outcome) => outcome.id === "clankie");
  const ok = outcomes.length > 0 && outcomes.every((outcome) => outcome.ok);
  stderr.write(`${describeOutcomes(outcomes)}\n`);
  outputJson(out, {
    ok,
    status: ok ? "ready" : "failed",
    target,
    host: commandHost(options),
    ...(clankie === undefined ? {} : { owned: clankie.ok }),
    services: outcomes,
  });
  return ok ? 0 : 1;
}

export async function runStartCommand(
  args: readonly string[],
  options: RestartCommandOptions,
): Promise<number> {
  if (args.length > 1) throw new Error("Usage: clankie start [service]");
  const target = parseServiceTarget(args[0]);
  refuseDuringUpdate(options);
  clearRecoveryIntent(resolveTargets(target), options.env ?? process.env);
  const outcomes = await startTarget(target, await createServiceOptions(options));
  const ok = outcomes.length > 0 && outcomes.every((outcome) => outcome.ok);
  const stderr = options.stderr ?? process.stderr;
  const out = options.stdout ?? process.stdout;
  stderr.write(`${describeOutcomes(outcomes)}\n`);
  outputJson(out, {
    ok,
    status: ok ? "ready" : "failed",
    target,
    host: commandHost(options),
    services: outcomes,
  });
  return ok ? 0 : 1;
}

/** `clankie stop`; `down` remains its alias because older update helpers call it. */
export async function runDownCommand(
  args: readonly string[],
  options: RestartCommandOptions,
): Promise<number> {
  const target = parseServiceTarget(args[0]);
  refuseDuringUpdate(options);
  clearRecoveryIntent(resolveTargets(target), options.env ?? process.env);
  const outcomes = await stopTarget(target, await createServiceOptions(options));
  const ok = outcomes.every((outcome) => outcome.ok);
  const stderr = options.stderr ?? process.stderr;
  const out = options.stdout ?? process.stdout;
  stderr.write(`${describeOutcomes(outcomes)}\n`);
  outputJson(out, {
    ok,
    status: ok ? "stopped" : "failed",
    target,
    services: outcomes,
  });
  return ok ? 0 : 1;
}
