/**
 * Local proof of the comparison loop. No service process, no credential store,
 * no model call — but the HTTP checks run against the **real** `createClankieApp`
 * router and the real dispatch envelope, not a hand-rolled echo server.
 *
 * `pnpm --filter @clankie/clankie comparison-check-loop`
 *
 * Covers what the loop review named: the real envelope through the maintained
 * protocol client, the captain-versus-operator bearer, unknown observations
 * never becoming zero, the watch-removal/replay race, deadline discipline, and
 * latency measured from the job's real start.
 */
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createOperatorConversationServiceClient } from "@clankie/protocol";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createHttpDispatch } from "./comparison-dispatch.ts";
import { awaitQuiescence, readWatches, readWorkers } from "./comparison-await-job.ts";

const run = promisify(execFile);
let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
};

const dir = mkdtempSync(join(tmpdir(), "comparison-loop-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const CAPTAIN_TOKEN = "clankie_cap_test";
const OPERATOR_TOKEN = "clankie_op_test";

const turnEvent = (runId: string, phase: string, cursor: string, at: string) => ({
  schemaVersion: 1 as const,
  type: "turn" as const,
  conversationId: "conv-real",
  cursor,
  occurredAt: at,
  revision: 1,
  runId,
  phase,
});

/** The real router, with a stub captain and the real bearer guard. */
async function realApp(events: readonly unknown[]) {
  return await createClankieApp({
    captain: createStubCaptain({
      serveOperatorConversation: (request) => {
        if (request.op !== "replay") throw new Error(`unexpected op ${request.op}`);
        return Promise.resolve({
          op: "replay",
          schemaVersion: 1,
          result: {
            schemaVersion: 1,
            status: "page",
            conversationId: "conv-real",
            surfaceClientId: request.replay.surfaceClientId,
            events,
            retainedFromCursor: "000000000000",
            nextCursor: "000000000002",
            safeCursor: "000000000002",
            hasMore: false,
          },
        } as never);
      },
    }),
    // Exactly the shape index.ts wires: only the captain bearer opens this door.
    authenticateCaptain: (request: Request) =>
      Promise.resolve(
        request.headers.get("authorization") === `Bearer ${CAPTAIN_TOKEN}`
          ? { captainId: "test", steerSourceLane: "api" as const }
          : undefined,
      ),
  });
}

const closers: (() => Promise<void> | void)[] = [];

console.log("== the real dispatch envelope, through the maintained protocol client ==");
{
  const now = new Date().toISOString();
  const clankie = await realApp([
    turnEvent("run-initial", "accepted", "000000000001", now),
    turnEvent("run-initial", "completed", "000000000002", now),
  ]);
  if (typeof (clankie as { close?: unknown }).close === "function") {
    closers.push(() => (clankie as unknown as { close: () => Promise<void> }).close());
  }
  const fetchImpl = ((url: URL | string, init?: RequestInit) =>
    clankie.app.request(String(url), init)) as unknown as typeof fetch;

  const client = createOperatorConversationServiceClient(
    createHttpDispatch({
      base: "http://real.invalid",
      token: CAPTAIN_TOKEN,
      deadlineAt: Date.now() + 30_000,
      fetchImpl,
    }),
  );
  const page = await client.replay({
    schemaVersion: 1,
    conversationId: "conv-real",
    surfaceClientId: "proof",
  });
  check(
    "the real app's envelope parses through createOperatorConversationServiceClient",
    page.status === "page" && page.events.length === 2,
    JSON.stringify(page).slice(0, 160),
  );

  // Bearer, explicitly: this route takes the CAPTAIN credential despite living
  // under /operator/v1/. An operator bearer must be refused, not silently work.
  const wrong = createHttpDispatch({
    base: "http://real.invalid",
    token: OPERATOR_TOKEN,
    deadlineAt: Date.now() + 30_000,
    fetchImpl,
  });
  let refused = "";
  try {
    await wrong({ op: "list", schemaVersion: 1 });
  } catch (error) {
    refused = String(error);
  }
  check(
    "an operator bearer is refused on the captain-guarded dispatch route",
    /401/u.test(refused) && /captain_authentication_required/u.test(refused),
    refused.slice(0, 140) || "it was accepted",
  );

  // Deadline discipline: a dispatch past the deadline never reaches the wire.
  let past = "";
  try {
    await createHttpDispatch({
      base: "http://real.invalid",
      token: CAPTAIN_TOKEN,
      deadlineAt: Date.now() - 1,
      fetchImpl,
    })({ op: "list", schemaVersion: 1 });
  } catch (error) {
    past = String(error);
  }
  check("a dispatch past the deadline is refused before sending", /deadline exceeded/u.test(past), past);
}

console.log("== unknown observations never become zero ==");
{
  check(
    "a watch file that never existed is a known zero",
    (() => {
      const observed = readWatches(join(dir, "absent.json"));
      return observed.known && observed.value === 0;
    })(),
  );

  writeFileSync(join(dir, "corrupt.json"), "{not json");
  const corrupt = readWatches(join(dir, "corrupt.json"));
  check("a corrupt watch file is unknown, not zero", !corrupt.known, JSON.stringify(corrupt));

  writeFileSync(join(dir, "shapeless.json"), JSON.stringify({ watches: "three" }));
  const shapeless = readWatches(join(dir, "shapeless.json"));
  check("a watch file with no watches array is unknown", !shapeless.known, JSON.stringify(shapeless));

  const asDirectory = readWatches(dir); // EISDIR, not ENOENT
  check("an unreadable watch path is unknown, not zero", !asDirectory.known, JSON.stringify(asDirectory));

  const missingBin = await readWorkers(join(dir, "no-such-herdr"), "/tmp/x", 5_000);
  check("a failed worker listing is unknown, not an empty fleet", !missingBin.known);

  const noisy = join(dir, "noisy-herdr");
  writeFileSync(noisy, "#!/bin/sh\necho 'not json'\n");
  chmodSync(noisy, 0o755);
  const garbage = await readWorkers(noisy, "/tmp/x", 5_000);
  check("a non-JSON worker listing is unknown", !garbage.known);

  const exhausted = await readWorkers(noisy, "/tmp/x", 0);
  check("no time left to list workers is unknown", !exhausted.known);

  // The lead's edge probe: an error object parses as JSON and has no agents.
  writeFileSync(join(dir, "err-herdr"), '#!/bin/sh\necho \'{"error":"socket unavailable"}\'\n');
  chmodSync(join(dir, "err-herdr"), 0o755);
  const errorObject = await readWorkers(join(dir, "err-herdr"), "/tmp/x", 5_000);
  check(
    "a JSON error object is unknown, not an empty fleet",
    !errorObject.known,
    JSON.stringify(errorObject),
  );

  writeFileSync(join(dir, "partial-herdr"), '#!/bin/sh\necho \'{"result":{"agents":[{"name":"x"}]}}\'\n');
  chmodSync(join(dir, "partial-herdr"), 0o755);
  const partial = await readWorkers(join(dir, "partial-herdr"), "/tmp/x", 5_000);
  check(
    "a worker record missing the fields we decide on is unknown",
    !partial.known,
    JSON.stringify(partial),
  );
}

console.log("== the loop's decisions ==");
{
  const herdrOk = join(dir, "herdr-ok");
  const statusFile = join(dir, "agents.json");
  writeFileSync(
    herdrOk,
    `#!/usr/bin/env node\nprocess.stdout.write(require("node:fs").readFileSync(${JSON.stringify(statusFile)},"utf8"));\n`,
  );
  chmodSync(herdrOk, 0o755);
  const setWorkers = (status: string | null): void =>
    writeFileSync(
      statusFile,
      JSON.stringify({
        result: {
          agents:
            status === null
              ? []
              : [{ name: "capture", pane_id: "w1:p1", agent: "claude", agent_status: status }],
        },
      }),
    );
  const watchFile = join(dir, "herdr-watches.json");
  const setWatches = (count: number): void =>
    writeFileSync(
      watchFile,
      JSON.stringify({ schemaVersion: 1, watches: Array.from({ length: count }, () => ({})) }),
    );
  const started = Date.now() - 5_000;
  const base = {
    conversationId: "conv-real",
    watchFile,
    socket: "/tmp/x",
    herdrBin: herdrOk,
    jobStartedAt: started,
    pollMs: 5,
    reconfirmMs: 5,
    // A real, tiny pause. Resolving instantly spins `herdr agent list` spawns
    // fast enough to exhaust process resources, which surfaces as an unknown
    // observation and makes the test flake for a reason the loop never has:
    // the production poll interval is ten seconds.
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 15))),
  };
  const at = (offsetMs: number) => new Date(started + offsetMs).toISOString();

  // 1. An initial turn settling while a worker works is not terminal.
  setWorkers("working");
  setWatches(1);
  let polls = 0;
  const yielded = await awaitQuiescence({
    ...base,
    deadlineAt: Date.now() + 8_000,
    replay: () => {
      polls += 1;
      return Promise.resolve({
        events: [
          turnEvent("run-initial", "accepted", "1", at(100)),
          turnEvent("run-initial", "completed", "2", at(1_000)),
        ],
        nextCursor: "2",
        hasMore: false,
      });
    },
  });
  check(
    "an initial turn settling while a worker works is not terminal",
    !yielded.quiescent && polls > 1,
    `quiescent=${String(yielded.quiescent)} polls=${String(polls)}`,
  );
  check(
    "latency is measured from the job's real start, not from the watcher attaching",
    yielded.initialTurnLatencyMs === 1_000 && yielded.wholeJobLatencyMs >= 5_000,
    JSON.stringify({ i: yielded.initialTurnLatencyMs, w: yielded.wholeJobLatencyMs }),
  );

  // 2. THE RACE. HerdrWatchStore wakes the conversation BEFORE clearing the
  // watch. Here the watch vanishes and the worker settles on the same pass, and
  // the continuation turn only appears on the pass after — the interleaving that
  // would let a naive loop call the job done while a turn was admitted.
  setWorkers("working");
  setWatches(1);
  let step = 0;
  const raced = await awaitQuiescence({
    ...base,
    deadlineAt: Date.now() + 8_000,
    replay: () => {
      step += 1;
      const events = [
        turnEvent("run-initial", "accepted", "1", at(100)),
        turnEvent("run-initial", "completed", "2", at(1_000)),
      ];
      if (step === 1) {
        // The wake has fired; the store is about to clear the watch.
        setWatches(0);
        setWorkers("done");
      }
      if (step >= 3) {
        events.push(turnEvent("run-watch-continuation", "accepted", "3", at(2_000)));
        events.push(turnEvent("run-watch-continuation", "completed", "4", at(3_000)));
        setWorkers(null);
      }
      return Promise.resolve({ events, nextCursor: String(events.length), hasMore: false });
    },
  });
  check(
    "a continuation admitted after the watch cleared is not missed",
    raced.captainRunCount === 2 &&
      raced.captainRuns.some((entry) => entry.runId === "run-watch-continuation"),
    `runs=${JSON.stringify(raced.captainRuns.map((r) => r.runId))}`,
  );
  check("the job is only called done once the continuation is settled too", raced.quiescent, raced.reason);

  // 3. Unfinished delegated work with nothing watching is failed quiescence.
  setWorkers("working");
  setWatches(0);
  const stranded = await awaitQuiescence({
    ...base,
    // Wide enough that the last observation before the deadline still has time
    // to spawn a real subprocess: a listing killed by a shrinking timeout is
    // correctly reported as unknown, which is a different (also tested) path.
    deadlineAt: Date.now() + 8_000,
    replay: () =>
      Promise.resolve({
        events: [
          turnEvent("run-initial", "accepted", "1", at(100)),
          turnEvent("run-initial", "completed", "2", at(1_000)),
        ],
        nextCursor: "2",
        hasMore: false,
      }),
  });
  check("unfinished delegated work with no watcher fails", !stranded.quiescent, stranded.reason);
  check("failed quiescence names the unfinished work", /busy worker/u.test(stranded.reason), stranded.reason);

  // 4. An unknown observation fails closed rather than reading as quiet.
  setWorkers(null);
  writeFileSync(watchFile, "{not json");
  const unknown = await awaitQuiescence({
    ...base,
    deadlineAt: Date.now() + 8_000,
    replay: () =>
      Promise.resolve({
        events: [
          turnEvent("run-initial", "accepted", "1", at(100)),
          turnEvent("run-initial", "completed", "2", at(1_000)),
        ],
        nextCursor: "2",
        hasMore: false,
      }),
  });
  check("an unknown observation fails closed", !unknown.quiescent, unknown.reason);
  check(
    "the receipt says which observation could not be made",
    /unknown observation/u.test(unknown.reason) && /does not parse/u.test(unknown.reason),
    unknown.reason,
  );

  // 5. A blocked worker is settled for scheduling but is NOT harvested work.
  setWorkers("blocked");
  setWatches(0);
  const blockedRun = await awaitQuiescence({
    ...base,
    deadlineAt: Date.now() + 8_000,
    replay: () =>
      Promise.resolve({
        events: [
          turnEvent("run-initial", "accepted", "1", at(100)),
          turnEvent("run-initial", "completed", "2", at(1_000)),
        ],
        nextCursor: "2",
        hasMore: false,
      }),
  });
  check(
    "a blocked worker is reported, not silently counted as finished work",
    blockedRun.blockedWorkers.length === 1 && blockedRun.harvestEvidence.length > 0,
    JSON.stringify(blockedRun.blockedWorkers),
  );

  // 6. The deadline preserves its receipt.
  setWorkers("working");
  setWatches(2);
  const timedOut = await awaitQuiescence({
    ...base,
    deadlineAt: Date.now() + 8_000,
    replay: () =>
      Promise.resolve({
        events: [turnEvent("run-initial", "accepted", "1", at(100))],
        nextCursor: "1",
        hasMore: false,
      }),
  });
  check(
    "a deadline is a failure that keeps its evidence",
    !timedOut.quiescent && timedOut.samples.length > 0 && timedOut.finalWatches === 2,
    timedOut.reason,
  );
}

console.log("== failures that must not throw the receipt away ==");
{
  const herdrOk = join(dir, "herdr-ok");
  const watchFile = join(dir, "herdr-watches.json");
  writeFileSync(join(dir, "agents.json"), JSON.stringify({ result: { agents: [] } }));
  writeFileSync(watchFile, JSON.stringify({ schemaVersion: 1, watches: [] }));
  const started = Date.now() - 3_000;
  let calls = 0;
  const afterOne = await awaitQuiescence({
    conversationId: "conv-real",
    watchFile,
    socket: "/tmp/x",
    herdrBin: herdrOk,
    jobStartedAt: started,
    deadlineAt: Date.now() + 30_000,
    pollMs: 5,
    reconfirmMs: 5,
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 15))),
    replay: () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          events: [turnEvent("run-initial", "accepted", "1", new Date(started + 10).toISOString())],
          nextCursor: "1",
          hasMore: false,
        });
      }
      return Promise.reject(new Error("dispatch 503: captain_execution_unavailable"));
    },
  });
  check("a replay rejection does not throw out of the loop", !afterOne.settledUnblocked, afterOne.reason);
  check(
    "the receipt keeps the runs and samples already collected",
    afterOne.captainRunCount === 1 && afterOne.samples.length >= 1,
    JSON.stringify({ runs: afterOne.captainRunCount, samples: afterOne.samples.length }),
  );
  check("the receipt names the replay failure", /replay failed/u.test(afterOne.reason), afterOne.reason);
}

console.log("== blocked work fails the command ==");
{
  const herdrOk = join(dir, "herdr-ok");
  const watchFile = join(dir, "herdr-watches.json");
  writeFileSync(
    join(dir, "agents.json"),
    JSON.stringify({
      result: { agents: [{ name: "capture", pane_id: "w1:p1", agent: "claude", agent_status: "blocked" }] },
    }),
  );
  writeFileSync(watchFile, JSON.stringify({ schemaVersion: 1, watches: [] }));
  const started = Date.now() - 3_000;
  const blockedQuiet = await awaitQuiescence({
    conversationId: "conv-real",
    watchFile,
    socket: "/tmp/x",
    herdrBin: herdrOk,
    jobStartedAt: started,
    deadlineAt: Date.now() + 30_000,
    pollMs: 5,
    reconfirmMs: 5,
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 15))),
    replay: () =>
      Promise.resolve({
        events: [
          turnEvent("run-initial", "accepted", "1", new Date(started + 10).toISOString()),
          turnEvent("run-initial", "completed", "2", new Date(started + 1_000).toISOString()),
        ],
        nextCursor: "2",
        hasMore: false,
      }),
  });
  check(
    "scheduling quiet with a blocked worker is NOT success",
    blockedQuiet.quiescent && !blockedQuiet.settledUnblocked,
    JSON.stringify({ quiescent: blockedQuiet.quiescent, settled: blockedQuiet.settledUnblocked }),
  );
  check(
    "the reason names the blocked work",
    /blocked on unfinished work/u.test(blockedQuiet.reason),
    blockedQuiet.reason,
  );
}

console.log("== a captain that did nothing is not a finished job ==");
{
  const herdrOk = join(dir, "herdr-ok");
  const watchFile = join(dir, "herdr-watches.json");
  writeFileSync(join(dir, "agents.json"), JSON.stringify({ result: { agents: [] } }));
  writeFileSync(watchFile, JSON.stringify({ schemaVersion: 1, watches: [] }));
  const started = Date.now() - 3_000;
  const empty = await awaitQuiescence({
    conversationId: "conv-real",
    watchFile,
    socket: "/tmp/x",
    herdrBin: herdrOk,
    jobStartedAt: started,
    deadlineAt: Date.now() + 30_000,
    pollMs: 5,
    reconfirmMs: 5,
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 15))),
    replay: () =>
      Promise.resolve({
        events: [
          turnEvent("run-only", "accepted", "1", new Date(started + 10).toISOString()),
          turnEvent("run-only", "completed", "2", new Date(started + 900).toISOString()),
        ],
        nextCursor: "2",
        hasMore: false,
      }),
  });
  check(
    "one turn, no workers, nothing started is flagged as no work",
    empty.quiescent && empty.producedNoWork,
    JSON.stringify({ quiescent: empty.quiescent, producedNoWork: empty.producedNoWork }),
  );
  check("the reason says nothing ran", /nothing ran/u.test(empty.reason), empty.reason);
}

console.log("== argument validation ==");
{
  const cases: readonly (readonly string[])[] = [
    [],
    ["--base", "http://x"],
    [
      "--base",
      "http://x",
      "--conversation",
      "c",
      "--state",
      "/s",
      "--socket",
      "/k",
      "--herdr",
      "/h",
      "--deadline-at",
      "nope",
      "--job-started-at",
      "1",
    ],
    [
      "--base",
      "http://x",
      "--conversation",
      "c",
      "--state",
      "/s",
      "--socket",
      "/k",
      "--herdr",
      "/h",
      "--deadline-at",
      "1",
      "--job-started-at",
      "1",
      "--poll",
      "-5",
    ],
  ];
  let refusals = 0;
  for (const argv of cases) {
    try {
      await run(
        process.execPath,
        [
          join(import.meta.dirname, "../node_modules/.bin/tsx"),
          join(import.meta.dirname, "comparison-await-job.ts"),
          ...argv,
        ],
        { env: { ...process.env, CLANKIE_CAPTAIN_TOKEN: "t" }, timeout: 60_000 },
      );
    } catch {
      refusals += 1;
    }
  }
  check("every malformed argument set is refused", refusals === cases.length, `${String(refusals)}/4`);
}

for (const close of closers) await close();
rmSync(dir, { recursive: true, force: true });

console.log(`\n${String(pass)} passed, ${String(fail)} failed`);
process.exitCode = fail === 0 ? 0 : 1;
