/**
 * Waits for a captain's whole job to go quiescent, not just its first turn.
 *
 * ```
 * pnpm --filter @clankie/clankie comparison-await-job --base URL --conversation ID
 *   --state DIR --socket PATH --herdr PATH --deadline-at EPOCH_MS --job-started-at EPOCH_MS
 *   [--poll MS]
 * ```
 *
 * Clankie is a persistent agent: `herdr_watch` arms a persisted one-shot watch,
 * and when the watched pane settles `HerdrWatchStore` wakes the *same* operator
 * conversation through `submitInternal(conversationId, prompt, "watch")`. The
 * shipped tool says so itself — "do not block the current turn". An initial turn
 * settling with workers running is a yield, so a benchmark that stops there
 * measures initial-turn latency and nothing else.
 *
 * This observes state the service already keeps and **sends nothing**: no nudge,
 * no resume prompt, no second brief. Clankie's own wake mechanism does the work.
 *
 * An observation it cannot make is `unknown`, never zero. A Herdr listing that
 * fails, or a watch file that exists but will not parse, fails the job closed
 * with the reason on the receipt — the one exception is a watch file that has
 * never existed, which genuinely means no watch was ever armed.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createOperatorConversationServiceClient } from "@clankie/protocol";
import { createHttpDispatch } from "./comparison-dispatch.ts";

const run = promisify(execFile);

interface Options {
  readonly base: string;
  readonly conversationId: string;
  readonly stateDir: string;
  readonly socket: string;
  readonly herdrBin: string;
  readonly deadlineAt: number;
  readonly jobStartedAt: number;
  readonly pollMs: number;
}

function parseArgs(argv: readonly string[]): Options {
  const read = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at === -1 ? undefined : argv[at + 1];
  };
  const required = (flag: string): string => {
    const value = read(flag);
    if (value === undefined || value.length === 0) throw new Error(`${flag} is required`);
    return value;
  };
  const epoch = (flag: string): number => {
    const value = Number(required(flag));
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${flag} must be epoch milliseconds`);
    return value;
  };
  const poll = Number(read("--poll") ?? 10_000);
  if (!Number.isSafeInteger(poll) || poll <= 0) throw new Error("--poll must be positive ms");
  return {
    base: required("--base"),
    conversationId: required("--conversation"),
    stateDir: required("--state"),
    socket: required("--socket"),
    herdrBin: required("--herdr"),
    deadlineAt: epoch("--deadline-at"),
    jobStartedAt: epoch("--job-started-at"),
    pollMs: poll,
  };
}

/** Settled for harvest purposes. `blocked` is settled but is NOT done work. */
const SETTLED = new Set(["idle", "done", "blocked"]);

/**
 * The least time in which a full observation can complete: listing workers
 * spawns a process. Starting one with less left manufactures a timeout that
 * looks like an unknown observation and masks the real reason, which is the
 * deadline. An observation that cannot fit is not attempted.
 */
const OBSERVATION_BUDGET_MS = 5_000;

export interface WorkerObservation {
  readonly name: string | null;
  readonly paneId: string;
  readonly kind: string;
  readonly status: string;
}
export type Observed<T> =
  | { readonly known: true; readonly value: T }
  | { readonly known: false; readonly why: string };

/**
 * Registered one-shot watches. The captain writes these under its own state
 * directory — `join(stateDir, "herdr-watches.json")` in `captain.ts`, where
 * `index.ts` passes `join(CLANKIE_STATE, "captain")`.
 */
export function readWatches(watchFile: string): Observed<number> {
  let raw: string;
  try {
    raw = readFileSync(watchFile, "utf8");
  } catch (error) {
    // Only a file that has never existed can mean "none armed". Anything else —
    // a permission error, a vanished mount — is an observation we did not make.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { known: true, value: 0 };
    return { known: false, why: `watch file unreadable: ${String(error).slice(0, 160)}` };
  }
  try {
    const watches = (JSON.parse(raw) as { watches?: unknown }).watches;
    if (!Array.isArray(watches)) return { known: false, why: "watch file has no watches array" };
    return { known: true, value: watches.length };
  } catch {
    return { known: false, why: "watch file is present but does not parse" };
  }
}

/** Owned workers on this arm's own socket only. */
export async function readWorkers(
  herdrBin: string,
  socket: string,
  timeoutMs: number,
): Promise<Observed<readonly WorkerObservation[]>> {
  if (timeoutMs <= 0) return { known: false, why: "no time left to list workers" };
  let stdout: string;
  try {
    ({ stdout } = await run(herdrBin, ["agent", "list"], {
      env: { ...process.env, HERDR_SOCKET_PATH: socket },
      timeout: timeoutMs,
    }));
  } catch (error) {
    // A failed listing is not an empty fleet. Reporting [] here would let a
    // dead socket read as quiescence.
    return { known: false, why: `herdr agent list failed: ${String(error).slice(0, 160)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { known: false, why: "herdr agent list did not return JSON" };
  }
  // `{"error":"socket unavailable"}` parses fine and has no `agents`. Treating a
  // missing list as an empty fleet turns a broken socket into proof of quiet.
  const agents = (parsed as { result?: { agents?: unknown } })?.result?.agents;
  if (!Array.isArray(agents)) {
    return { known: false, why: `herdr agent list returned no agents array: ${stdout.slice(0, 160)}` };
  }
  const value: WorkerObservation[] = [];
  for (const agent of agents) {
    const record = agent as Record<string, unknown>;
    // Every field this loop decides on must actually be there and be a string.
    if (typeof record.pane_id !== "string" || typeof record.agent_status !== "string") {
      return { known: false, why: `herdr agent list record is missing pane_id or agent_status` };
    }
    value.push({
      name: typeof record.name === "string" ? record.name : null,
      paneId: record.pane_id,
      kind: typeof record.agent === "string" ? record.agent : "",
      status: record.agent_status,
    });
  }
  return { known: true, value };
}

export interface Sample {
  readonly at: string;
  readonly watches: number | null;
  readonly workers: readonly WorkerObservation[] | null;
  readonly busyWorkers: number | null;
  readonly runsSeen: number;
  readonly runsInFlight: number;
  readonly unknown?: string;
}

export interface RunRecord {
  readonly runId: string;
  readonly phases: { readonly phase: string; readonly at: string }[];
}

export interface QuiescenceInput {
  readonly conversationId: string;
  readonly watchFile: string;
  readonly socket: string;
  readonly herdrBin: string;
  readonly deadlineAt: number;
  readonly jobStartedAt: number;
  readonly pollMs: number;
  readonly reconfirmMs?: number;
  readonly replay: (cursor: string | undefined) => Promise<{
    readonly events: readonly { type: string; runId?: string; phase?: string; occurredAt: string }[];
    readonly nextCursor: string;
    readonly hasMore: boolean;
  }>;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Runs the observation loop to quiescence, a fail-closed unknown, or the
 * deadline. Exported so the race and the unknown handling are testable without
 * a service.
 */
export async function awaitQuiescence(input: QuiescenceInput) {
  const runs = new Map<string, RunRecord>();
  let cursor: string | undefined;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function drainConversation(): Promise<void> {
    for (;;) {
      const page = await input.replay(cursor);
      for (const event of page.events) {
        if (event.type !== "turn" || event.runId === undefined || event.phase === undefined) continue;
        const record = runs.get(event.runId) ?? { runId: event.runId, phases: [] };
        record.phases.push({ phase: event.phase, at: event.occurredAt });
        runs.set(event.runId, record);
      }
      cursor = page.nextCursor;
      if (!page.hasMore) return;
    }
  }
  const inFlight = (): RunRecord[] =>
    [...runs.values()].filter((record) => !record.phases.some((phase) => phase.phase !== "accepted"));

  /**
   * One pass in the order the race demands. `HerdrWatchStore` wakes the
   * conversation BEFORE it clears the watch, so a watch can disappear between a
   * replay snapshot and a watch read, leaving an admitted continuation unseen.
   * Reading the conversation LAST, then re-confirming, closes that window.
   */
  async function observe(): Promise<Sample> {
    const remaining = (): number => input.deadlineAt - Date.now();
    const workers = await readWorkers(input.herdrBin, input.socket, Math.min(20_000, remaining()));
    const watches = readWatches(input.watchFile);
    await drainConversation();
    const running = inFlight();
    const known = workers.known && watches.known;
    return {
      at: new Date().toISOString(),
      watches: watches.known ? watches.value : null,
      workers: workers.known ? workers.value : null,
      busyWorkers: workers.known ? workers.value.filter((w) => !SETTLED.has(w.status)).length : null,
      runsSeen: runs.size,
      runsInFlight: running.length,
      ...(known
        ? {}
        : {
            unknown: [workers.known ? undefined : workers.why, watches.known ? undefined : watches.why]
              .filter(Boolean)
              .join("; "),
          }),
    };
  }

  const isCandidate = (sample: Sample): boolean =>
    sample.unknown === undefined &&
    sample.watches === 0 &&
    sample.busyWorkers === 0 &&
    sample.runsInFlight === 0 &&
    sample.runsSeen > 0;

  const samples: Sample[] = [];
  let quiescent = false;
  let failClosed: string | undefined;

  while (Date.now() < input.deadlineAt) {
    // Out of time to observe is a deadline, never a successful quiet. Leave
    // `failClosed` unset so the deadline reason still names what was
    // outstanding — that is the diagnostic, not the fact that time ran out.
    if (input.deadlineAt - Date.now() < OBSERVATION_BUDGET_MS) break;
    let sample: Sample;
    try {
      sample = await observe();
    } catch (error) {
      // A replay rejection is an observation we could not make. Losing the
      // receipt with it would discard every run and sample already collected.
      failClosed = `unknown observation: replay failed: ${String(error).slice(0, 200)}`;
      break;
    }
    samples.push(sample);
    if (sample.unknown !== undefined) {
      failClosed = `unknown observation: ${sample.unknown}`;
      break;
    }
    if (isCandidate(sample)) {
      const pause = Math.min(input.reconfirmMs ?? 2_000, input.deadlineAt - Date.now());
      if (pause > 0) await sleep(pause);
      let confirm: Sample;
      try {
        confirm = await observe();
      } catch (error) {
        failClosed = `unknown observation on re-confirm: replay failed: ${String(error).slice(0, 200)}`;
        break;
      }
      samples.push(confirm);
      if (confirm.unknown !== undefined) {
        failClosed = `unknown observation on re-confirm: ${confirm.unknown}`;
        break;
      }
      // A continuation admitted between the two passes shows up as a new run,
      // and disqualifies the candidate rather than being missed.
      if (isCandidate(confirm) && confirm.runsSeen === sample.runsSeen) {
        quiescent = true;
        break;
      }
      continue;
    }
    const nap = Math.min(input.pollMs, input.deadlineAt - Date.now());
    if (nap > 0) await sleep(nap);
  }

  const finishedAt = Date.now();
  const last = samples.at(-1);
  const ordered = [...runs.values()].sort(
    (a, b) => Date.parse(a.phases[0]?.at ?? "") - Date.parse(b.phases[0]?.at ?? ""),
  );
  const initialSettled = ordered[0]?.phases.find((phase) => phase.phase !== "accepted");
  const blocked = (last?.workers ?? []).filter((worker) => worker.status === "blocked");
  // Blocked is settled for scheduling but is unfinished delegated work. A job
  // cannot exit successfully with a worker sitting on a prompt, and a prose
  // warning in the receipt is not enough to stop that.
  const settledUnblocked = quiescent && blocked.length === 0;
  // A captain that did nothing leaves everything trivially quiet. That is a
  // legitimate reason to stop waiting, but it is not the job being done — only
  // the frozen acceptance check decides that. Surfaced so a receipt can never
  // read as success for a turn that produced no work at all.
  const producedNoWork = runs.size <= 1 && (last?.workers?.length ?? 0) === 0;
  return {
    settledUnblocked,
    producedNoWork,
    quiescent,
    reason: settledUnblocked
      ? producedNoWork
        ? "quiet, but the captain started no worker and took no further turn — nothing ran"
        : "no registered watch, no busy worker, no run in flight, re-confirmed"
      : quiescent
        ? `scheduling is quiet but ${String(blocked.length)} worker(s) are blocked on unfinished work`
        : (failClosed ??
          `deadline reached with ${String(last?.watches ?? "unknown")} watch(es), ` +
            `${String(last?.busyWorkers ?? "unknown")} busy worker(s), ` +
            `${String(last?.runsInFlight ?? 0)} run(s) in flight`),
    captainRuns: [...runs.values()],
    captainRunCount: runs.size,
    // Both measured from the job's real start — when the brief was submitted —
    // not from when this watcher attached after the first run had already ended.
    initialTurnLatencyMs:
      initialSettled === undefined ? null : Date.parse(initialSettled.at) - input.jobStartedAt,
    wholeJobLatencyMs: finishedAt - input.jobStartedAt,
    // Settled for scheduling, but NOT harvested work.
    blockedWorkers: blocked,
    harvestEvidence:
      "settledUnblocked means the waiting ended cleanly, NOT that the job was done: only the " +
      "frozen acceptance check decides that, and harvest must be read from the transcript and " +
      "the worker screens",
    finalWorkers: last?.workers ?? null,
    finalWatches: last?.watches ?? null,
    samples,
  };
}

// Only run as a command when invoked directly: the proof imports this module
// for `awaitQuiescence`, `readWatches` and `readWorkers`.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2));
  const token = process.env["CLANKIE_CAPTAIN_TOKEN"];
  if (token === undefined || token.length === 0) {
    console.error("CLANKIE_CAPTAIN_TOKEN is required; it is read from the environment and never printed.");
    process.exit(2);
  }

  const watchFile = `${options.stateDir}/herdr-watches.json`;
  const client = createOperatorConversationServiceClient(
    createHttpDispatch({ base: options.base, token, deadlineAt: options.deadlineAt }),
  );
  const receipt = await awaitQuiescence({
    conversationId: options.conversationId,
    watchFile,
    socket: options.socket,
    herdrBin: options.herdrBin,
    deadlineAt: options.deadlineAt,
    jobStartedAt: options.jobStartedAt,
    pollMs: options.pollMs,
    replay: async (cursor) => {
      const page = await client.replay({
        schemaVersion: 1,
        conversationId: options.conversationId,
        surfaceClientId: `await-job-${options.conversationId}`,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (page.status !== "page") throw new Error(`replay recovery: ${page.status}`);
      return {
        events: page.events as unknown as readonly {
          type: string;
          runId?: string;
          phase?: string;
          occurredAt: string;
        }[],
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      };
    },
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (!receipt.settledUnblocked || receipt.producedNoWork) process.exitCode = 1;
}
