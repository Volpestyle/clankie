import { spawn } from "node:child_process";
import { join } from "node:path";
import type { OperatorSeatSpawnResult, Routine, RoutineRun, SpawnOperatorSeat } from "@clankie/protocol";
import type { RoutineExecution } from "./routines.ts";

const CHECK_TIMEOUT_MS = 30 * 60_000;
const CHECK_KILL_GRACE_MS = 10_000;
const OUTPUT_TAIL_BYTES = 6_000;

export interface RoutineRunnerDeps {
  /** One host-authored turn in the target conversation; resolves when it settles, throws when it fails. */
  readonly runTurn: (conversationId: string, prompt: string) => Promise<void>;
  /** `hire_agent`'s own path, led by the target conversation. */
  readonly hire: (
    conversationId: string,
    seat: SpawnOperatorSeat,
    brief: string,
  ) => Promise<OperatorSeatSpawnResult>;
  /** A note in the target conversation; false when nothing accepted it. */
  readonly notify: (conversationId: string, text: string) => Promise<boolean>;
  /** The launcher that provides `clankie heavy`. */
  readonly launcher: { readonly command: string; readonly args: readonly string[] };
}

/** Runs a routine's target with that conversation's authority and nothing more (ADR 0265). */
export function createRoutineRunner(deps: RoutineRunnerDeps) {
  return async (routine: Routine, run: RoutineRun): Promise<RoutineExecution> => {
    const target = routine.target;
    switch (target.kind) {
      case "turn":
        await deps.runTurn(target.conversationId, `${routineHeader(routine, run)}\n\n${target.prompt}`);
        return { ok: true, detail: "The lead turn ran." };
      case "hire": {
        const result = await deps.hire(
          target.conversationId,
          { schemaVersion: 1, ...target.hire },
          `${target.brief}\n\n(Hired by the routine "${routine.name}", run ${run.slot}.)`,
        );
        if (result.outcome !== "spawned") {
          const why = `${result.reason}${result.detail ? `: ${result.detail}` : ""}`;
          // The lead relying on a recurring hire hears when it didn't happen, not only the run log.
          await deps
            .notify(
              target.conversationId,
              `${routineHeader(routine, run)}\n\nThis routine could not hire ${target.hire.title}, so no seat was started: ${why}`,
            )
            .catch(() => false);
          return { ok: false, detail: `Hire ${why}` };
        }
        const seat = result.seat.seatId;
        await deps
          .notify(
            target.conversationId,
            `${routineHeader(routine, run)}\n\nThis routine hired ${target.hire.title} (seat ${seat}). You lead it; its reports come here.`,
          )
          .catch(() => false);
        return { ok: true, detail: `Hired ${target.hire.title} as ${seat}.` };
      }
      case "check": {
        const result = await runCheck(deps.launcher, routine, run, target);
        const report = target.report ?? "failure";
        if (report === "always" || !result.ok)
          await deps
            .notify(
              target.conversationId,
              `${routineHeader(routine, run)}\n\nCheck \`${target.command.join(" ")}\` in ${target.workingDirectory}: ${result.detail}`,
            )
            .catch(() => false);
        return result;
      }
    }
  };
}

function routineHeader(routine: Routine, run: RoutineRun): string {
  const when = routine.schedule.text ?? routine.schedule.cron;
  const missed =
    run.missed === undefined
      ? ""
      : ` It stands in for ${String(run.missed)} run${run.missed === 1 ? "" : "s"} missed while the Mac slept or the service was down.`;
  const by = routine.createdBy === "owner" ? "the owner" : "a lead in this conversation";
  return (
    `Routine "${routine.name}" (${when}, ${routine.schedule.timeZone}), ${run.trigger} run for ${run.slot}.${missed} ` +
    `Its instructions were written by ${by} when the routine was set up; running it grants no additional authority.`
  );
}

async function runCheck(
  launcher: RoutineRunnerDeps["launcher"],
  routine: Routine,
  run: RoutineRun,
  target: Extract<Routine["target"], { kind: "check" }>,
): Promise<RoutineExecution> {
  const started = Date.now();
  const child = spawn(
    launcher.command,
    [
      ...launcher.args,
      "heavy",
      "--seat",
      `routine:${routine.id}`,
      "--holder",
      `routine:${run.id}`,
      "--",
      ...target.command,
    ],
    { cwd: target.workingDirectory, stdio: ["ignore", "pipe", "pipe"], env: process.env },
  );
  let tail = "";
  const keep = (chunk: Buffer) => {
    tail = (tail + chunk.toString("utf8")).slice(-OUTPUT_TAIL_BYTES);
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  let timedOut = false;
  let kill: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(
    () => {
      timedOut = true;
      child.kill("SIGTERM");
      kill = setTimeout(() => child.kill("SIGKILL"), CHECK_KILL_GRACE_MS);
    },
    (target.timeoutSeconds ?? CHECK_TIMEOUT_MS / 1000) * 1000,
  );
  const code = await new Promise<number | string>((resolve) => {
    child.once("error", (error) => resolve(error.message));
    child.once("close", (exit, signal) => resolve(exit ?? signal ?? "unknown"));
  });
  clearTimeout(timer);
  if (kill !== undefined) clearTimeout(kill);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const output = tail.trim() ? `\n\n${tail.trim()}` : "";
  if (code === 0) return { ok: true, detail: `passed in ${seconds}s.${output}` };
  const why = timedOut
    ? `timed out after ${seconds}s`
    : typeof code === "number"
      ? `exited ${String(code)} after ${seconds}s`
      : `failed: ${code}`;
  return { ok: false, detail: `${why}.${output}` };
}

/** The launcher this service ships with, run by the same Node. */
export function serviceLauncher(repoRoot: string): RoutineRunnerDeps["launcher"] {
  return { command: process.execPath, args: [join(repoRoot, "apps", "tui", "bin", "clankie.ts")] };
}
