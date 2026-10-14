import { createServer } from "node:http";
import { text } from "node:stream/consumers";
import { setTimeout as delay } from "node:timers/promises";
import { runAgentsCommand } from "../../tui/src/command/agents.ts";
import { withFleetAgentHealth } from "../../tui/src/session/herdr-connection.ts";
import { createClankieApp } from "../src/app.ts";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsAsync, { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ClankieSettingsSchema, SettingsStore } from "@clankie/settings";
import { OperatorConversationServiceResultSchema, type OperatorFleetSeat } from "@clankie/protocol";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { occupantIdForHerdrSession, type ObservedFleetSeat } from "../src/captain/herdr-census.ts";
import { HireOwners } from "../src/captain/hire-owners.ts";
import { withSeatSubagents } from "../src/captain/seat-subagents.ts";
import native from "./fixtures/codex-subagents.json" with { type: "json" };

const SEATS = 10;
const CALLERS = 16;
const DIRECTORY_COUNT = 1024;
const UNRELATED_PER_DIRECTORY = 1;
const roots: string[] = [];
const httpCleanups: (() => Promise<void>)[] = [];
const captains: ReturnType<typeof createCaptain>[] = [];
afterEach(async ({ signal }) => {
  for (const cleanup of httpCleanups.splice(0).reverse()) await cleanup();
  await Promise.all(captains.splice(0).map((captain) => captain.close()));
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.unstubAllEnvs();
  // A cancelled or timed-out body may still be writing (scripts/testing/vitest-setup.ts).
  const removed = roots.splice(0);
  if (!signal.aborted) await Promise.all(removed.map((root) => rm(root, { recursive: true, force: true })));
});
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
async function temporaryRoot() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fleet-refresh-")));
  roots.push(root);
  return root;
}

// Native record shapes come from the inspected Codex 0.160 fixture. The trees
// contain many unrelated sessions and substantial parent journals, rather than
// ten model agents or a substituted filesystem.
async function sessionTree(seats = SEATS, directories = DIRECTORY_COUNT) {
  const root = await temporaryRoot();
  const now = new Date().toISOString();
  const sessions = join(root, "sessions");
  const current = join(sessions, now.slice(0, 4), now.slice(5, 7), now.slice(8, 10));
  await mkdir(current, { recursive: true });
  const padding = line({
    timestamp: now,
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "x".repeat(4096) }],
    },
  }).repeat(256);
  const parents = await Promise.all(
    Array.from({ length: seats }, async (_, index) => {
      const id = randomUUID();
      const childId = randomUUID();
      const path = join(current, `rollout-parent-${id}.jsonl`);
      const child = join(current, `rollout-child-${childId}.jsonl`);
      const task = `/root/child_${index}`;
      await Promise.all([
        writeFile(
          path,
          line({ ...native.parent, timestamp: now, payload: { ...native.parent.payload, id, cwd: root } }) +
            padding,
        ),
        writeFile(
          child,
          line({
            ...native.child,
            timestamp: now,
            payload: {
              ...native.child.payload,
              id: childId,
              parent_thread_id: id,
              agent_path: task,
              agent_nickname: `Child ${index}`,
              source: {
                subagent: {
                  thread_spawn: {
                    parent_thread_id: id,
                    agent_path: task,
                    agent_nickname: `Child ${index}`,
                    depth: 1,
                  },
                },
              },
            },
          }) + line({ ...native.taskStarted, timestamp: now }),
        ),
      ]);
      return { id, childId, path, child, task };
    }),
  );
  // Bound fixture creation too: opening a thousand files simultaneously would
  // benchmark the test's setup and can exhaust smaller CI descriptor limits.
  for (let batch = 0; batch < directories; batch += 32)
    await Promise.all(
      Array.from({ length: Math.min(32, directories - batch) }, async (_, offset) => {
        const index = batch + offset;
        const directory = join(
          sessions,
          String(2020 + Math.floor(index / (12 * 28))),
          String((Math.floor(index / 28) % 12) + 1).padStart(2, "0"),
          String((index % 28) + 1).padStart(2, "0"),
        );
        await mkdir(directory, { recursive: true });
        await Promise.all(
          Array.from({ length: UNRELATED_PER_DIRECTORY }, async () => {
            const id = randomUUID();
            await writeFile(
              join(directory, `rollout-unrelated-${id}.jsonl`),
              line({
                ...native.parent,
                timestamp: now,
                payload: { ...native.parent.payload, id },
              }),
            );
          }),
        );
      }),
    );
  return { root, current, parents };
}

interface NativeRow {
  pane_id: string;
  terminal_id: string;
  agent: string;
  agent_status: string;
  title: string;
  agent_session: { source: string; kind: "path"; value: string };
  cwd: string;
}
async function captainFixture(tree: Awaited<ReturnType<typeof sessionTree>>) {
  const rows: NativeRow[] = tree.parents.map((parent, index) => ({
    pane_id: `w1:p${index}`,
    terminal_id: `term_${index}`,
    agent: "codex",
    agent_status: "working",
    title: `Worker ${index}`,
    agent_session: { source: "herdr:codex", kind: "path", value: parent.path },
    cwd: tree.root,
  }));
  const owners = new HireOwners(join(tree.root, "herdr-watches.json.owners.json"));
  for (const row of rows)
    owners.bind(
      row.pane_id,
      { conversationId: "global-default" },
      row.terminal_id,
      undefined,
      occupantIdForHerdrSession(row.agent_session),
    );
  let calls = 0;
  let onCensus: (() => Promise<void>) | undefined;
  let gate: { entered(): void; wait: Promise<void> } | undefined;
  const execute = async (args: readonly string[]) => {
    if (args[0] === "agent" && args[1] === "list") return JSON.stringify({ result: { agents: rows } });
    if (args[0] === "agent" && args[1] === "get")
      return JSON.stringify({
        result: { agent: rows.find((row) => row.pane_id === args[2] || row.terminal_id === args[2]) },
      });
    if (args[0] === "pane" && args[1] === "list") return JSON.stringify({ result: { panes: rows } });
    if (args[0] === "workspace" && args[1] === "list") return JSON.stringify({ result: { workspaces: [] } });
    throw new Error(`Unexpected census transport request: ${args.join(" ")}`);
  };
  const captain = createCaptain(
    {
      herdrAvailable: () => true,
      memory: {},
      embodiment: { getLiveSession: async () => undefined },
      presence: { listSessions: async () => [] },
      browser: { catalog: async () => ({ available: false, tools: [] }) },
      mcp: { catalog: async () => [] },
    } as unknown as CaptainDeps,
    {
      repoRoot: tree.root,
      stateDir: tree.root,
      workingDirectory: tree.root,
      settings: new SettingsStore(join(tree.root, "settings.json")),
      nativeHerdrRunner: createHerdrWatchRunner(() => true, execute, undefined, {
        localCodexRecovery: false,
      }),
      nativeCensusRunner: async (_command, args) => {
        if (args[0] !== "agent" || args[1] !== "list") return { stdout: await execute(args), stderr: "" };
        calls++;
        const snapshot = structuredClone(rows);
        const held = gate;
        gate = undefined;
        if (held) {
          held.entered();
          await held.wait;
        }
        await onCensus?.();
        return { stdout: JSON.stringify({ result: { agents: snapshot } }), stderr: "" };
      },
      nativeSummariesPath: join(tree.root, "summaries.json"),
      seatAdapters: [],
      discordEnvironment: {},
      fleetRoundIntervalMs: 60 * 60_000,
    },
  );
  captains.push(captain);
  return {
    captain,
    rows,
    calls: () => calls,
    onCensus: (callback?: () => Promise<void>) => {
      onCensus = callback;
    },
    hold: () => {
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      gate = {
        entered,
        wait: new Promise<void>((resolve) => {
          release = resolve;
        }),
      };
      return { started, release };
    },
  };
}

it("concurrent public fleet reads share a ten-seat refresh; force callers observe the changed census", async () => {
  const tree = await sessionTree();
  const f = await captainFixture(tree);
  const read = async (index: number) => {
    const result = OperatorConversationServiceResultSchema.parse(
      await f.captain.serveOperatorConversation({
        schemaVersion: 1,
        op: index % 2 ? "roster" : "fleet",
      }),
    );
    if (result.op === "roster") return result.seats;
    if (result.op === "fleet") return result.snapshot.seats;
    throw new Error("Expected fleet response");
  };
  const coldStart = f.calls();
  const cold = await Promise.all(Array.from({ length: CALLERS }, (_, index) => read(index)));
  expect(cold.every((seats) => seats.length === SEATS)).toBe(true);
  // Initial projection can change its cursor and require one stabilizing read,
  // independently of how many clients requested the snapshot.
  expect(f.calls()).toBeLessThanOrEqual(coldStart + 2);
  await read(1);
  const warmCalls = f.calls();
  expect(await Promise.all(Array.from({ length: CALLERS }, (_, index) => read(index)))).toHaveLength(CALLERS);
  expect(f.calls()).toBe(warmCalls);
  // The public read cache is one second. Holding the next native reply makes
  // contention deterministic without a fake clock or a refresh implementation hook.
  await new Promise<void>((resolve) => setTimeout(resolve, 1050));
  const held = f.hold();
  const burst = Promise.all(Array.from({ length: CALLERS }, (_, index) => read(index)));
  await held.started;
  expect(f.calls()).toBe(warmCalls + 1);
  const originalOccupant = occupantIdForHerdrSession(f.rows[0]!.agent_session);
  f.rows[0]!.agent_session = { ...f.rows[0]!.agent_session, value: tree.parents[0]!.child };
  const changedOccupant = occupantIdForHerdrSession(f.rows[0]!.agent_session);
  const forced = Promise.all(
    [0, 1].map((index) =>
      f.captain.serveOperatorConversation({
        schemaVersion: 1,
        op: "state_work",
        work: { herdrPaneId: f.rows[index]!.pane_id, assignment: null },
      }),
    ),
  );
  // Each state_work has its own identity lookup; both must then share the one
  // post-request refresh rather than joining the already-started stale census.
  await vi.waitFor(() => expect(f.calls()).toBe(warmCalls + 3));
  held.release();
  const old = await burst;
  expect(old.every((seats) => seats.length === SEATS && seats[0]?.occupantId === originalOccupant)).toBe(
    true,
  );
  expect(await forced).toMatchObject([
    { op: "state_work", result: { outcome: "cleared", seatId: "term_0" } },
    { op: "state_work", result: { outcome: "cleared", seatId: "term_1" } },
  ]);
  expect(f.calls()).toBe(warmCalls + 4);
  expect((await read(0))[0]?.occupantId).toBe(changedOccupant);
  expect(f.calls()).toBeLessThanOrEqual(warmCalls + 5);
  const current = await read(1);
  await new Promise<void>((resolve) => setTimeout(resolve, 1050));
  const rename = f.hold();
  const beforeRename = f.calls();
  const projection = read(1);
  try {
    await rename.started;
    await f.captain.serveOperatorConversation({
      schemaVersion: 1,
      op: "update_persona",
      persona: { schemaVersion: 1, personaId: current[1]!.personaId, name: "Renamed during refresh" },
    });
  } finally {
    rename.release();
  }
  await projection;
  expect((await read(1))[1]?.title).toBe("Renamed during refresh");
  // A mutation during the held census invalidates its cache eligibility even
  // when that projection happens to include the updated persona already.
  expect(f.calls()).toBe(beforeRename + 2);
});

function observeFilesystem(root: string) {
  const counts = { stats: 0, directories: 0, opens: 0, parentOpens: 0, syncWalks: 0 };
  const watch = (target: object, name: string, metric: keyof typeof counts) => {
    const methods = target as Record<string, (...args: unknown[]) => unknown>;
    const original = methods[name];
    if (!original) return;
    vi.spyOn(methods, name).mockImplementation((...args) => {
      const options = args[1];
      const cwd =
        options !== null && typeof options === "object" && "cwd" in options ? options.cwd : undefined;
      if (
        [args[0], cwd].some(
          (value) => typeof value === "string" && (value === root || value.startsWith(root + sep)),
        )
      ) {
        counts[metric]++;
        if (
          metric === "opens" &&
          typeof args[0] === "string" &&
          args[0].split(sep).at(-1)?.startsWith("rollout-parent-")
        )
          counts.parentOpens++;
      }
      return Reflect.apply(original, target, args);
    });
  };
  for (const name of ["stat", "lstat", "realpath"]) watch(fsAsync, name, "stats");
  for (const name of ["readdir", "glob"]) watch(fsAsync, name, "directories");
  watch(fsAsync, "open", "opens");
  for (const name of ["statSync", "lstatSync", "realpathSync"]) watch(fs, name, "stats");
  for (const name of ["readdirSync", "globSync"]) watch(fs, name, "syncWalks");
  watch(fs, "openSync", "opens");
  syncBuiltinESMExports();
  return {
    counts,
    reset: () => {
      for (const key of Object.keys(counts) as Array<keyof typeof counts>) counts[key] = 0;
    },
  };
}

it("real addressed-seat subagent projection shares large-tree discovery and avoids warm filesystem walks", async () => {
  const tree = await sessionTree();
  const seats: OperatorFleetSeat[] = tree.parents.map((_, index) => ({
    seatId: `term_${index}`,
    occupantId: `occupant_${index}`,
    personaId: `person_${index}`,
    harness: "codex",
    status: "working",
    title: `Worker ${index}`,
  }));
  const observed: ObservedFleetSeat[] = seats.map((seat, index) => ({
    seatId: seat.seatId,
    occupantId: seat.occupantId,
    harness: seat.harness,
    status: seat.status,
    title: seat.title,
    paneId: `w1:p${index}`,
    subject: seat.personaId,
    session: { source: "herdr:codex", kind: "path", value: tree.parents[index]!.path },
  }));
  // Observation wrappers count the real filesystem calls and forward every
  // original operation. No dependency or transcript result is substituted.
  const fs = observeFilesystem(tree.root);
  const read = () => withSeatSubagents(seats, observed, () => true);
  const cold = await Promise.all(Array.from({ length: CALLERS }, read));
  for (const result of cold)
    expect(result.map((seat) => seat.subagents?.running)).toEqual(Array(SEATS).fill(1));
  expect(fs.counts.directories).toBeGreaterThan(0);
  expect(fs.counts.directories).toBeLessThanOrEqual((DIRECTORY_COUNT + 80) * 2);
  expect(fs.counts.syncWalks).toBe(0);
  expect(fs.counts.opens).toBeLessThanOrEqual((DIRECTORY_COUNT * UNRELATED_PER_DIRECTORY + SEATS * 2) * 3);
  expect(fs.counts.parentOpens).toBeLessThanOrEqual(SEATS * 4);
  expect(fs.counts.stats).toBeLessThanOrEqual(
    (DIRECTORY_COUNT * UNRELATED_PER_DIRECTORY + SEATS * 2) * 8 + SEATS * 24,
  );
  const coldCalls = { ...fs.counts };
  fs.reset();
  const warm = await Promise.all(Array.from({ length: CALLERS }, read));
  expect(warm[0]?.[0]?.subagents?.recent[0]?.id).toBe(tree.parents[0]!.childId);
  expect(fs.counts.directories).toBe(0);
  expect(fs.counts.syncWalks).toBe(0);
  expect(fs.counts.opens).toBe(0);
  // Validation scales with known directories and active children, not every
  // unrelated session multiplied by every seat and every concurrent caller.
  expect(fs.counts.stats).toBeLessThanOrEqual(SEATS * 24 + 32);
  process.stdout.write(
    `Fleet filesystem calls ${JSON.stringify({
      seats: SEATS,
      callers: CALLERS,
      unrelatedDirectories: DIRECTORY_COUNT,
      cold: coldCalls,
      warm: fs.counts,
    })}\n`,
  );
  await appendFile(
    tree.parents[0]!.path,
    line({
      ...native.collected,
      timestamp: new Date(Date.now() + 1000).toISOString(),
      payload: {
        ...native.collected.payload,
        author: tree.parents[0]!.task,
        content: [
          {
            type: "input_text",
            text: `Message Type: FINAL_ANSWER\nTask name: /root\nSender: ${tree.parents[0]!.task}\nPayload:\n`,
          },
        ],
      },
    }),
  );
  expect((await read())[0]?.subagents?.running).toBe(0);
  const id = randomUUID();
  await writeFile(
    join(tree.current, `rollout-new-child-${id}.jsonl`),
    line({
      ...native.child,
      timestamp: new Date().toISOString(),
      payload: {
        ...native.child.payload,
        id,
        parent_thread_id: tree.parents[1]!.id,
        source: {
          subagent: {
            thread_spawn: { parent_thread_id: tree.parents[1]!.id, agent_path: "/root/new_child" },
          },
        },
      },
    }),
  );
  expect((await read())[1]?.subagents?.running).toBe(2);
});

async function contactsHttp(captain: ReturnType<typeof createCaptain>, root: string) {
  const host = await operatorHttp(captain, root);
  return () =>
    runAgentsCommand(["contacts"], {
      host,
      env: { CLANKIE_CAPTAIN_TOKEN: "contacts-test" },
    });
}

async function operatorHttp(captain: ReturnType<typeof createCaptain>, root: string) {
  const service = await createClankieApp({
    captain,
    settings: { load: async () => ClankieSettingsSchema.parse({ schemaVersion: 1 }) },
    eventLogPath: join(root, "http-events.jsonl"),
    authenticateCaptain: async (request) =>
      request.headers.get("authorization") === "Bearer contacts-test"
        ? { captainId: "contacts-test" }
        : undefined,
  });
  const server = createServer(async (request, response) => {
    try {
      const result = await service.app.request(request.url!, {
        method: request.method ?? "POST",
        headers: { authorization: request.headers.authorization ?? "", "content-type": "application/json" },
        body: await text(request),
      });
      response.writeHead(result.status, { "content-type": "application/json" });
      response.end(await result.text());
    } catch (error) {
      response.writeHead(500);
      response.end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing contacts fixture address");
  httpCleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    service.close();
  });
  return `http://127.0.0.1:${address.port}`;
}

it("busy fleet changes during a slow census return partial contacts instead of starving the HTTP read", async () => {
  const tree = await sessionTree(1, 0);
  const f = await captainFixture(tree);
  const contacts = await contactsHttp(f.captain, tree.root);
  const initial = (await contacts()) as { personaId: string }[];
  expect(initial).toHaveLength(1);
  await delay(1050);
  const before = f.calls();
  let changes = 0;
  f.onCensus(async () => {
    await delay(20);
    await f.captain.serveOperatorConversation({
      op: "update_persona",
      schemaVersion: 1,
      persona: { schemaVersion: 1, personaId: initial[0]!.personaId, name: `Busy worker ${++changes}` },
    });
  });
  const pending = contacts();
  try {
    const result = await Promise.race([pending, delay(1500).then(() => undefined)]);
    expect(result).toMatchObject({
      personas: [{ personaId: initial[0]!.personaId, name: "Busy worker 2" }],
      readWarnings: [{ source: "fleet_consistency", reason: "changed_during_read" }],
    });
    expect(f.calls() - before).toBe(2);
  } finally {
    f.onCensus();
    await pending;
  }
  expect(await contacts()).toEqual(
    expect.arrayContaining([expect.objectContaining({ personaId: initial[0]!.personaId })]),
  );
}, 20_000);

it("a stalled Herdr census returns named partial contacts by the display deadline and shares its in-flight work", async () => {
  const tree = await sessionTree(1, 0);
  const f = await captainFixture(tree);
  const contacts = await contactsHttp(f.captain, tree.root);
  const initial = (await contacts()) as { personaId: string }[];
  await delay(1050);
  const before = f.calls();
  const held = f.hold();
  const pending = contacts();
  await held.started;
  const concurrent = f.captain.serveOperatorConversation({ op: "fleet", schemaVersion: 1 });
  try {
    const [result, fleet] = await Promise.all([pending, concurrent]);
    expect(result).toMatchObject({
      personas: [{ personaId: initial[0]!.personaId }],
      readWarnings: [
        { source: "herdr:default", reason: "timeout", message: expect.stringContaining("5000 ms") },
      ],
    });
    expect(fleet.op).toBe("fleet");
    if (fleet.op !== "fleet") throw new Error("Wrong snapshot result");
    expect(fleet.snapshot.seats).toHaveLength(1);
    expect(fleet.snapshot.readWarnings).toMatchObject([{ source: "herdr:default", reason: "timeout" }]);
    expect(f.calls() - before).toBe(1);
  } finally {
    held.release();
    await pending;
    await f.captain.serveOperatorConversation({ op: "roster", schemaVersion: 1 });
  }
  expect(await contacts()).toHaveLength(1);
}, 20_000);

it("a stalled census still answers the roster CLI inside its deadline, named as partial", async () => {
  const tree = await sessionTree(1, 0);
  const f = await captainFixture(tree);
  const options = {
    repoRoot: tree.root,
    host: await operatorHttp(f.captain, tree.root),
    env: { CLANKIE_CAPTAIN_TOKEN: "contacts-test" },
  };
  const native = JSON.stringify({ result: { agents: f.rows } });
  const complete = JSON.parse(await withFleetAgentHealth(native, options));
  expect(complete.result.agents[0].owner).toBe("global-default");
  await delay(1050);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const held = f.hold();
  const started = performance.now();
  const listing = withFleetAgentHealth(native, options);
  await held.started;
  try {
    const partial = JSON.parse(await listing);
    // Inside the CLI's own five-second client deadline, with owner fields kept.
    expect(performance.now() - started).toBeLessThan(5000);
    expect(partial.result.agents[0].owner).toBe("global-default");
    const written = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(written).toContain("roster is partial: herdr:default did not finish within 3000 ms");
    expect(written).not.toContain("roster is unavailable");
  } finally {
    held.release();
    await listing.catch(() => undefined);
  }
}, 20_000);

it("presence counts working seats from the last projection while a census stalls, then reports the change", async () => {
  const tree = await sessionTree(1, 0);
  const f = await captainFixture(tree);
  const presence = async (cursor?: string) => {
    const result = await f.captain.serveOperatorConversation({
      op: "presence",
      schemaVersion: 1,
      ...(cursor === undefined ? {} : { cursor, waitMs: 10_000 }),
    });
    if (result.op !== "presence") throw new Error("Wrong presence result");
    return result.snapshot;
  };
  await f.captain.serveOperatorConversation({ op: "roster", schemaVersion: 1 });
  await delay(1050);
  const held = f.hold();
  const roster = f.captain.serveOperatorConversation({ op: "roster", schemaVersion: 1 });
  await held.started;
  try {
    // A presence read never waits for the stalled projection, so its client cannot time out to idle.
    const started = performance.now();
    const working = await presence();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(working).toMatchObject({ activeSeats: 1, mood: "leading" });
    held.release();
    await roster;
    // The finished worker reaches presence through the shared refresh and its long poll.
    f.rows[0]!.agent_status = "idle";
    await delay(1050);
    expect(await presence(working.cursor)).toMatchObject({ activeSeats: 0, mood: "idle" });
  } finally {
    held.release();
    await roster.catch(() => undefined);
  }
}, 20_000);
