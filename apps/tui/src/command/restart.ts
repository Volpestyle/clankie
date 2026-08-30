import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createServiceOptions,
  parseServiceTarget,
  restartTarget,
  stopTarget,
  type CreateServiceOptionsInput,
  type ServiceOutcome,
  type ServiceTarget,
} from "../../bin/services.ts";
import { commandHost, outputJson } from "./io.ts";

const RESTART_TURN_POLL_MS = 100;
const RESTART_AFTER_TURN_FLAG = "--after-operator-turn";

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

function activeOperatorTurn(env: NodeJS.ProcessEnv): RestartTurnHandoff | undefined {
  const sessionFile = env.PI_SESSION_FILE?.trim();
  if (sessionFile === undefined || sessionFile.length === 0) return undefined;
  const piDirectory = dirname(sessionFile);
  if (basename(piDirectory) !== "pi") return undefined;
  const eventsPath = join(dirname(piDirectory), "events.jsonl");
  try {
    const active = [...turnPhases(eventsPath)].find(([, phase]) => phase === "accepted");
    return active === undefined ? undefined : { eventsPath, runId: active[0] };
  } catch {
    return undefined;
  }
}

function restartIncludesClankie(target: ServiceTarget): boolean {
  return target === "all" || target === "clankie";
}

async function waitForOperatorTurn(
  handoff: RestartTurnHandoff,
  sleepImpl: (ms: number) => Promise<void>,
): Promise<void> {
  for (;;) {
    const phase = turnPhases(handoff.eventsPath).get(handoff.runId);
    if (phase === "completed" || phase === "failed" || phase === "cancelled") return;
    await sleepImpl(RESTART_TURN_POLL_MS);
  }
}

function scheduleRestartAfterTurn(
  target: ServiceTarget,
  handoff: RestartTurnHandoff,
  options: RestartCommandOptions,
): void {
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
  const child = (options.spawnImpl ?? spawn)(
    cliEntryPath,
    ["restart", target, RESTART_AFTER_TURN_FLAG, handoff.eventsPath, handoff.runId],
    { detached: true, env, stdio: "ignore" },
  );
  if (child.pid === undefined) throw new Error("Deferred restart helper did not start.");
  child.unref();
}

export async function runRestartCommand(
  args: readonly string[],
  options: RestartCommandOptions,
): Promise<number> {
  const target = parseServiceTarget(args[0]);
  const afterTurn =
    args[1] === RESTART_AFTER_TURN_FLAG && args[2] !== undefined && args[3] !== undefined
      ? { eventsPath: args[2], runId: args[3] }
      : undefined;
  if (args.length > 1 && afterTurn === undefined) {
    throw new Error("Usage: clankie restart [service]");
  }
  const stderr = options.stderr ?? process.stderr;
  const out = options.stdout ?? process.stdout;
  if (afterTurn !== undefined) {
    await waitForOperatorTurn(afterTurn, options.sleepImpl ?? sleep);
  } else if (restartIncludesClankie(target)) {
    const activeTurn = activeOperatorTurn(options.env ?? process.env);
    if (activeTurn !== undefined) {
      scheduleRestartAfterTurn(target, activeTurn, options);
      stderr.write("Restart scheduled after this conversation turn completes.\n");
      outputJson(out, {
        ok: true,
        status: "scheduled",
        target,
        host: commandHost(options),
        afterRun: activeTurn.runId,
      });
      return 0;
    }
  }
  const registryOptions = await createServiceOptions(options);
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

export async function runDownCommand(
  args: readonly string[],
  options: RestartCommandOptions,
): Promise<number> {
  const target = parseServiceTarget(args[0]);
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
