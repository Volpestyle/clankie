/**
 * The real-app run: one command that starts this checkout's real Clankie service and
 * relay in a scratch home, drives the owner's key flows through the CLI and HTTP as
 * an agent or the app would, and checks each outcome through the API, the files the
 * service writes and its own structured logs. Nothing is mocked; no model is called.
 *
 *   pnpm real-run [--only FLOW,FLOW] [--out DIRECTORY] [--keep]
 *
 * Exit 0 when every flow passed. The run's own JSON log, the service and relay logs
 * and report.json stay in the output directory (default .local/real-run/<time>).
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Cause, Effect, Exit, Fiber } from "effect";
import { flows, type RunState } from "./flows.ts";
import { runLoggers } from "./log.ts";
import { makeStack, repoRoot } from "./stack.ts";

const { values } = parseArgs({
  options: {
    only: { type: "string" },
    out: { type: "string" },
    keep: { type: "boolean", default: false },
  },
});
const out = resolve(
  values.out ?? join(repoRoot, ".local/real-run", new Date().toISOString().replace(/[:.]/gu, "-")),
);
mkdirSync(out, { recursive: true, mode: 0o700 });
// Herdr's Unix sockets live under the scratch state and must stay within 103 bytes,
// so the scratch home sits under a short root whatever the checkout or output path.
const home = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "clankie-real-run-"));
const only = values.only?.split(",").map((name) => name.trim());
for (const name of only ?? [])
  if (!flows.some((flow) => flow.name === name))
    throw new Error(`Unknown flow ${name}: ${flows.map((f) => f.name).join(", ")}`);
// Flows build on each other (a project before its feed), so --only keeps the order
// and always boots first.
const selected = flows.filter((flow) => !only || flow.name === "boot" || only.includes(flow.name));

/** Service log lines at error level or above that a passing run may still show, each with why. */
const expectedErrors: ReadonlyArray<{ readonly event: string; readonly why: string }> = [];

interface FlowReport {
  name: string;
  proves: string;
  outcome: "passed" | "failed" | "skipped";
  ms: number;
  failure?: string;
}

/** Runs the selected flows, then stops everything it started before returning. */
const runFlows = Effect.gen(function* () {
  const stack = yield* Effect.acquireRelease(makeStack(home), (stack) => stack.close);
  const state: RunState = {};
  const reports: FlowReport[] = [];
  let failed = false;
  for (const flow of selected) {
    if (failed) {
      reports.push({ name: flow.name, proves: flow.proves, outcome: "skipped", ms: 0 });
      continue;
    }
    const started = Date.now();
    const exit = yield* flow
      .run(stack, state)
      .pipe(
        Effect.withSpan(`flow.${flow.name}`),
        Effect.withLogSpan(flow.name),
        Effect.annotateLogs({ flow: flow.name }),
        Effect.exit,
      );
    const ms = Date.now() - started;
    if (Exit.isSuccess(exit)) {
      reports.push({ name: flow.name, proves: flow.proves, outcome: "passed", ms });
      yield* Effect.logInfo(`✓ ${flow.name}: ${flow.proves}`).pipe(
        Effect.annotateLogs({ flow: flow.name, ms }),
      );
    } else {
      failed = true;
      const failure = Cause.pretty(exit.cause);
      reports.push({ name: flow.name, proves: flow.proves, outcome: "failed", ms, failure });
      yield* Effect.logError(`✗ ${flow.name}: ${flow.proves}`).pipe(
        Effect.annotateLogs({ flow: flow.name, ms, failure }),
      );
    }
  }
  return { stack, reports, failed };
}).pipe(Effect.scoped);

const program = Effect.gen(function* () {
  const run = yield* runFlows;
  const { stack, reports } = run;
  let { failed } = run;
  // Whatever the flows saw, the service must not have logged an error doing it,
  // shutdown included: the processes have stopped and their logs are complete here.
  const errors = stack
    .serviceLog()
    .filter((line) => (line.level ?? 0) >= 50)
    .filter((line) => !expectedErrors.some((expected) => expected.event === line.event));
  if (errors.length) {
    failed = true;
    yield* Effect.logError("the service logged errors").pipe(
      Effect.annotateLogs({
        errors: errors.slice(0, 20).map((line) => ({ event: line.event, msg: line.msg })),
      }),
    );
  }
  const warnings = stack.serviceLog().filter((line) => line.level === 40);
  const report = {
    head: process.env.GITHUB_SHA,
    passed: !failed,
    flows: reports,
    serviceErrors: errors.map((line) => ({ event: line.event, msg: line.msg })),
    serviceWarnings: [...new Set(warnings.map((line) => String(line.event ?? line.msg)))],
    logs: {
      run: join(out, "run.jsonl"),
      service: join(out, "service.log"),
      relay: join(out, "relay.log"),
    },
  };
  writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
});

const fiber = Effect.runFork(program.pipe(Effect.provide(runLoggers(join(out, "run.jsonl")))));
// The service and relay run in their own process groups, so Ctrl-C or a cancelled CI
// job reaches only this process: interrupting the run lets its scope stop them and
// the scratch Herdr server before it exits. A second signal leaves at once.
let interrupted: NodeJS.Signals | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (interrupted) process.exit(130);
    interrupted = signal;
    console.error(`\n${signal}: stopping the scratch stack...`);
    fiber.interruptUnsafe();
  });
const exit = await Effect.runPromise(Fiber.await(fiber));
// The processes have stopped: their logs join the run's own output.
for (const log of ["service.log", "relay.log"])
  if (existsSync(join(home, log))) copyFileSync(join(home, log), join(out, log));
const passed = !interrupted && Exit.isSuccess(exit) && exit.value.passed;
if (interrupted) {
  console.error("real run interrupted");
  process.exitCode = 130;
} else if (Exit.isFailure(exit)) {
  console.error(Cause.pretty(exit.cause));
  process.exitCode = 1;
} else {
  const { flows: ran } = exit.value;
  console.log(
    `\nreal run ${passed ? "passed" : "FAILED"}: ${ran.filter((f) => f.outcome === "passed").length}/${ran.length} flows; ${out}/report.json`,
  );
  process.exitCode = passed ? 0 : 1;
}
// A run leaves its logs and report. The scratch home stays for a look after a local
// failure or with --keep; CI keeps only the logs.
if (values.keep || (!passed && !process.env.CI)) console.log(`scratch home kept at ${home}`);
else rmSync(home, { recursive: true, force: true });
