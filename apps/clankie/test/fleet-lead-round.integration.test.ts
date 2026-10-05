import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { OperatorConversationServiceResultSchema } from "@clankie/protocol";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { HireOwners } from "../src/captain/hire-owners.ts";
import { createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import { ConversationJournal } from "../src/captain/conversation-journal.ts";
import { SeatEfficiencyStore } from "../src/captain/seat-efficiency.ts";

interface NativeRow {
  pane_id: string;
  terminal_id: string;
  agent: string;
  agent_status: string;
  title: string;
  agent_session: { source: string; kind: "path"; value: string };
  cwd: string;
}
const fixtures: Array<{ root: string; captain: ReturnType<typeof createCaptain> }> = [];
const exec = promisify(execFile);
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.captain.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

async function fixture(
  roundMs = 60 * 60_000,
  objective?: string,
  rebound = false,
  healthy = false,
  configure?: (root: string, rows: NativeRow[]) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "fleet-lead-round-"));
  const conversations = new ConversationStore(join(root, "conversations"), async () => {});
  const second = await conversations.serve({
    op: "create",
    schemaVersion: 1,
    scope: { kind: "global" },
    title: "Other lead",
  });
  if (second.op !== "create") throw new Error("Missing second lead");
  await conversations.close();
  const rows: NativeRow[] = [];
  const owners = new HireOwners(join(root, "herdr-watches.json.owners.json"));
  const evidence = new SeatEfficiencyStore(join(root, "seat-efficiency.json"));
  for (let i = 1; i <= 4; i++) {
    const nativeId = randomUUID();
    const path = join(root, `rollout-fixture-${nativeId}.jsonl`);
    const timestamp = new Date(Date.now() - (healthy ? 1000 : 3 * 60 * 60_000)).toISOString();
    await writeFile(
      path,
      [
        { timestamp, type: "session_meta", payload: { id: nativeId, cwd: root } },
        { timestamp, type: "turn_context", payload: { model: "gpt-6-sol", effort: "high" } },
        {
          timestamp,
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              model_context_window: 100000,
              last_token_usage: { input_tokens: healthy ? 40000 : 80000 },
            },
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    const row: NativeRow = {
      pane_id: `w1:p${i}`,
      terminal_id: `term_${i}`,
      agent: "codex",
      agent_status: "working",
      title: i === 4 ? "Unowned worker" : `Worker ${i}`,
      agent_session: { source: "herdr:codex", kind: "path", value: path },
      cwd: root,
    };
    rows.push(row);
    if (i === 4) continue;
    const owner = { conversationId: i <= 2 ? "global-default" : second.conversation.conversationId };
    const occupantId = occupantIdForHerdrSession(row.agent_session);
    owners.bind(
      row.pane_id,
      owner,
      row.terminal_id,
      undefined,
      occupantId,
      JSON.stringify(["local", "codex", nativeId]),
    );
    evidence.assign(occupantId, {
      owner,
      deliverable: healthy ? `VUH-${1700 + i}` : "VUH-1662",
      assignedAt: timestamp,
      objective,
    });
  }
  if (rebound) rows[0]!.terminal_id = "term_rebound";
  await configure?.(root, rows);
  const waits = new Map<string, Set<() => void>>();
  let censusGate: { entered(): void; wait: Promise<void> } | undefined;
  const execute = async (args: readonly string[], signal?: AbortSignal): Promise<string> => {
    if (censusGate && args[0] === "agent" && args[1] === "list") {
      const held = censusGate;
      censusGate = undefined;
      held.entered();
      await held.wait;
    }
    let result: unknown;
    if (args[0] === "agent" && args[1] === "wait") {
      const target = args[2]!;
      const current = rows.find((row) => row.pane_id === target || row.terminal_id === target);
      const until = args.flatMap((arg, index) => (arg === "--until" ? [args[index + 1]] : []));
      if (current?.agent_status !== "working" && (!until.length || until.includes(current?.agent_status)))
        return JSON.stringify({ result: { agent: current } });
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const handlers = waits.get(target) ?? new Set();
        const complete = () => {
          handlers.delete(complete);
          resolve();
        };
        handlers.add(complete);
        waits.set(target, handlers);
        signal?.addEventListener(
          "abort",
          () => {
            handlers.delete(complete);
            reject(signal.reason);
          },
          { once: true },
        );
      });
      result = { agent: rows.find((row) => row.pane_id === target || row.terminal_id === target) };
    } else if (args[0] === "agent" && args[1] === "get") {
      result = { agent: rows.find((row) => row.pane_id === args[2] || row.terminal_id === args[2]) };
    } else if (args[0] === "agent" && args[1] === "list") result = { agents: rows };
    else if (args[0] === "pane" && args[1] === "list") result = { panes: rows };
    else if (args[0] === "workspace" && args[1] === "list") result = { workspaces: [] };
    else throw new Error(`Unexpected native transport request: ${args.join(" ")}`);
    return JSON.stringify({ result });
  };
  const captain = createCaptain(
    {
      herdrAvailable: () => true,
      memory: {},
      embodiment: {},
      browser: { catalog: async () => ({ available: false, tools: [] }) },
      mcp: { catalog: async () => [], call: async () => ({ outcome: "ok", content: "", isError: false }) },
    } as unknown as CaptainDeps,
    {
      repoRoot: root,
      stateDir: root,
      workingDirectory: root,
      settings: new SettingsStore(join(root, "settings.json")),
      nativeHerdrRunner: createHerdrWatchRunner(() => true, execute, undefined, {
        localCodexRecovery: false,
      }),
      nativeCensusRunner: async (_cmd, args) => ({ stdout: await execute(args), stderr: "" }),
      nativeSummariesPath: join(root, "summaries.json"),
      seatAdapters: [],
      discordEnvironment: {},
      fleetRoundIntervalMs: roundMs,
    },
  );
  fixtures.push({ root, captain });
  // Bind real native outboxes before a scheduled wake, so no model is called.
  await captain.pollSeatEvents(0, undefined, "global-default");
  await captain.pollSeatEvents(0, undefined, second.conversation.conversationId);
  const leadSessions = new Map([
    ["global-default", randomUUID()],
    [second.conversation.conversationId, randomUUID()],
  ]);
  return {
    root,
    captain,
    rows,
    other: second.conversation.conversationId,
    holdNextCensus: () => {
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      censusGate = { entered, wait };
      return { started, release };
    },
    finish: async (
      eventId: string,
      conversationId = "global-default",
      sessionId = leadSessions.get(conversationId)!,
    ) => {
      expect(await captain.acknowledgeSeatEvent(eventId, conversationId)).toBe(true);
      // The delivery acknowledgment is distinct from the harness completing its turn.
      expect(
        captain.syncSeatTranscript(conversationId, {
          sessionId,
          activity: "waiting",
          entries: [
            { type: "message", id: `review-${eventId}`, role: "agent", text: "Fleet review completed." },
          ],
        }),
      ).toBe(true);
    },
    settle: (index: number) => {
      const row = rows[index]!;
      row.agent_status = "done";
      for (const complete of [...(waits.get(row.pane_id) ?? []), ...(waits.get(row.terminal_id) ?? [])])
        complete();
    },
  };
}

it("a real watch wake includes every owned seat and never another lead's or unowned worker", async () => {
  const f = await fixture();
  const bank = await f.captain.laneToolBank("operator", "global-default");
  const watch = bank.tools.find((tool) => tool.name === "herdr_watch")!;
  const poll = f.captain.pollSeatEvents(3000, undefined, "global-default");
  await watch.call({ agent: f.rows[0]!.pane_id, reason: "Harvest the assigned patch" });
  // The external wait may begin after the arm call. A settled census is also
  // sufficient native proof, so both paths exercise the normal watcher.
  f.settle(0);
  const [event] = await poll;
  expect(event?.content).toContain("Fleet lead round.");
  expect(event?.content).toContain('"seatId":"term_1"');
  expect(event?.content).toContain('"seatId":"term_2"');
  expect(event?.content).not.toContain('"seatId":"term_3"');
  expect(event?.content).not.toContain('"seatId":"term_4"');
  expect(event?.content).toContain("context 80%");
  expect(event?.content).toContain("no progress in 2h");
  expect(event?.content).toContain("overlap");
  await f.finish(event!.id);
  expect(await f.captain.pollSeatEvents(0, undefined, f.other)).toEqual([]);
});

it("periodic rounds independently wake both leading conversations with only their seats", async () => {
  const f = await fixture(500);
  const [first, other] = await Promise.all([
    f.captain.pollSeatEvents(3000, undefined, "global-default"),
    f.captain.pollSeatEvents(3000, undefined, f.other),
  ]);
  expect(first[0]?.content).toContain('"seatId":"term_1"');
  expect(first[0]?.content).toContain('"seatId":"term_2"');
  expect(first[0]?.content).not.toContain('"seatId":"term_3"');
  expect(other[0]?.content).toContain('"seatId":"term_3"');
  expect(other[0]?.content).not.toContain('"seatId":"term_1"');
  expect(other[0]?.content).not.toContain('"seatId":"term_4"');
  // Leave the first review outstanding across two more real periodic ticks.
  // Durable accepted turns reveal a queue even when native delivery is held.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const journal = new ConversationJournal(join(f.root, "conversations"));
  for (const conversationId of ["global-default", f.other])
    expect(
      journal.read(conversationId).filter((event) => event.type === "turn" && event.phase === "accepted"),
    ).toHaveLength(1);
  await f.finish(first[0]!.id);
  await f.finish(other[0]!.id, f.other);
  // An unresolved flag remains worth a later round even with identical evidence.
  const [next, nextOther] = await Promise.all([
    f.captain.pollSeatEvents(3000, undefined, "global-default"),
    f.captain.pollSeatEvents(3000, undefined, f.other),
  ]);
  expect(next[0]?.content).toContain("context 80%");
  expect(nextOther[0]?.content).toContain("context 80%");
  for (const conversationId of ["global-default", f.other])
    expect(
      journal.read(conversationId).filter((event) => event.type === "turn" && event.phase === "accepted"),
    ).toHaveLength(2);
  await f.finish(next[0]!.id);
  await f.finish(nextOther[0]!.id, f.other);
});

it("skips unchanged unflagged rounds despite fresh observation clocks, then wakes only the owner with new evidence", async () => {
  const f = await fixture(200, undefined, false, true);
  const before = await f.captain.fleetEfficiency!("global-default");
  expect(before.seats.every((seat) => seat.efficiency?.flags.length === 0)).toBe(true);
  const [first, other] = await Promise.all([
    f.captain.pollSeatEvents(3000, undefined, "global-default"),
    f.captain.pollSeatEvents(3000, undefined, f.other),
  ]);
  expect(first[0]?.content).toContain('"seatId":"term_1"');
  expect(other[0]?.content).toContain('"seatId":"term_3"');
  await f.finish(first[0]!.id);
  await f.finish(other[0]!.id, f.other);
  expect(
    await Promise.all([
      f.captain.pollSeatEvents(650, undefined, "global-default"),
      f.captain.pollSeatEvents(650, undefined, f.other),
    ]),
  ).toEqual([[], []]);
  const refreshed = await f.captain.fleetEfficiency!("global-default");
  expect(refreshed.seats[0]?.efficiency?.checkedAt).not.toBe(before.seats[0]?.efficiency?.checkedAt);
  const journal = new ConversationJournal(join(f.root, "conversations"));
  const accepted = (conversationId: string) =>
    journal.read(conversationId).filter((event) => event.type === "turn" && event.phase === "accepted");
  expect(accepted("global-default")).toHaveLength(1);
  expect(accepted(f.other)).toHaveLength(1);
  // A fresh native turn setting is useful evidence without creating any problem flag.
  await appendFile(
    f.rows[0]!.agent_session.value,
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "turn_context",
      payload: { model: "gpt-6-sol", effort: "medium" },
    }) + "\n",
  );
  const changed = await f.captain.fleetEfficiency!("global-default");
  expect(changed.seats[0]?.efficiency).toMatchObject({ flags: [], effort: "medium" });
  const [fresh, unchanged] = await Promise.all([
    f.captain.pollSeatEvents(3000, undefined, "global-default"),
    f.captain.pollSeatEvents(650, undefined, f.other),
  ]);
  expect(fresh[0]?.content).toContain('"effort":"medium"');
  expect(unchanged).toEqual([]);
  expect(accepted("global-default")).toHaveLength(2);
  expect(accepted(f.other)).toHaveLength(1);
  await f.finish(fresh[0]!.id);
  expect(await f.captain.pollSeatEvents(650, undefined, "global-default")).toEqual([]);
  expect(accepted("global-default")).toHaveLength(2);
});

it("does not consume healthy evidence when a periodic native turn is canceled before delivery", async () => {
  const f = await fixture(200, undefined, false, true);
  const sessionId = randomUUID();
  expect(
    f.captain.syncSeatTranscript("global-default", { sessionId, entries: [], activity: "responding" }),
  ).toBe(true);
  const [held, other] = await Promise.all([
    f.captain.pollSeatEvents(450, undefined, "global-default"),
    f.captain.pollSeatEvents(3000, undefined, f.other),
  ]);
  expect(held).toEqual([]);
  await f.finish(other[0]!.id, f.other);
  const journal = new ConversationJournal(join(f.root, "conversations"));
  const accepted = journal
    .read("global-default")
    .filter((event) => event.type === "turn" && event.phase === "accepted");
  expect(accepted).toHaveLength(1);
  const run = accepted[0]!;
  if (run.type !== "turn") throw new Error("Missing accepted periodic run");
  expect(
    await f.captain.serveOperatorConversation({
      op: "cancel",
      schemaVersion: 1,
      conversationId: "global-default",
      runId: run.runId,
    }),
  ).toMatchObject({ op: "cancel", cancelled: true });
  expect(
    f.captain.syncSeatTranscript("global-default", { sessionId, entries: [], activity: "waiting" }),
  ).toBe(true);
  const [retried] = await f.captain.pollSeatEvents(3000, undefined, "global-default");
  expect(retried?.content).toContain("Fleet lead round.");
  expect(
    journal.read("global-default").filter((event) => event.type === "turn" && event.phase === "accepted"),
  ).toHaveLength(2);
  expect(journal.read("global-default")).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: "turn", runId: run.runId, phase: "cancelled" })]),
  );
  await f.finish(retried!.id, "global-default", sessionId);
  expect(await f.captain.pollSeatEvents(650, undefined, "global-default")).toEqual([]);
});

async function git(path: string, args: readonly string[]) {
  await exec(
    "git",
    [
      "--no-optional-locks",
      "-C",
      path,
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
      encoding: "utf8",
      timeout: 5000,
    },
  );
}

it("attributes advanced commits only with fresh exclusive worktree and branch claims across the entire census", async () => {
  let repository = "";
  let worktree = "";
  let otherWorktree = "";
  const f = await fixture(undefined, undefined, false, false, async (root, rows) => {
    repository = join(root, "primary-repository");
    worktree = join(root, "owned-worktree");
    otherWorktree = join(root, "unowned-worktree");
    await mkdir(repository);
    await git(repository, ["init", "--initial-branch", "main"]);
    await git(repository, ["config", "user.name", "Local fixture"]);
    await git(repository, ["config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(repository, "base.txt"), "Retained baseline\n");
    await git(repository, ["add", "base.txt"]);
    await git(repository, ["commit", "--quiet", "-m", "fixture baseline"]);
    await git(repository, ["worktree", "add", "-b", "owned-native", worktree]);
    await git(repository, ["worktree", "add", "-b", "unowned-native", otherWorktree]);
    await mkdir(join(worktree, "nested"));
    rows[0]!.cwd = worktree;
    rows[3]!.cwd = otherWorktree;
  });
  const baseline = await f.captain.fleetEfficiency!("global-default");
  expect(baseline.seats.find((seat) => seat.seatId === "term_1")?.efficiency?.flags).toContain(
    "no progress in 2h",
  );
  // Discovery grants no ownership, but every native claimant still prevents exclusive commit attribution.
  f.rows[3]!.cwd = join(worktree, "nested");
  await writeFile(join(worktree, "delivered.txt"), "Advanced native deliverable\n");
  await git(worktree, ["add", "delivered.txt"]);
  await git(worktree, ["commit", "--quiet", "-m", "native deliverable"]);
  const shared = await f.captain.fleetEfficiency!("global-default");
  expect(shared.seats.find((seat) => seat.seatId === "term_1")?.efficiency?.flags).toContain(
    "no progress in 2h",
  );
  const [unowned] = f.rows.splice(3, 1);
  const exclusive = await f.captain.fleetEfficiency!("global-default");
  const own = exclusive.seats.find((seat) => seat.seatId === "term_1")?.efficiency;
  expect(own?.lastProgressAt).toBeDefined();
  expect(own?.flags).not.toContain("no progress in 2h");
  expect(exclusive.seats.find((seat) => seat.seatId === "term_2")?.efficiency?.flags).toContain(
    "no progress in 2h",
  );
  // The other seat returns on its original different branch, then changes
  // branches after discovery. A cached initial claim cannot establish exclusivity.
  unowned!.cwd = otherWorktree;
  f.rows.push(unowned!);
  await f.captain.fleetEfficiency!("global-default");
  await git(otherWorktree, ["checkout", "--ignore-other-worktrees", "owned-native"]);
  await writeFile(join(worktree, "later.txt"), "Commit while another native seat claims the branch\n");
  await git(worktree, ["add", "later.txt"]);
  // Git timestamps have one-second precision; a later timestamp makes a false
  // new progress attribution observable instead of coincidentally unchanged.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await git(worktree, ["commit", "--quiet", "-m", "shared branch commit"]);
  const collided = await f.captain.fleetEfficiency!("global-default");
  expect(collided.seats.find((seat) => seat.seatId === "term_1")?.efficiency?.lastProgressAt).toBe(
    own!.lastProgressAt,
  );
  // A forced primary-checkout claimant has no linked baseline and must not
  // make the linked branch appear exclusive merely because its claim is unknown.
  unowned!.cwd = repository;
  await git(repository, ["checkout", "--ignore-other-worktrees", "owned-native"]);
  await writeFile(join(worktree, "primary-shared.txt"), "Primary claimant remains unproven\n");
  await git(worktree, ["add", "primary-shared.txt"]);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await git(worktree, ["commit", "--quiet", "-m", "primary-shared branch commit"]);
  const primaryShared = await f.captain.fleetEfficiency!("global-default");
  expect(primaryShared.seats.find((seat) => seat.seatId === "term_1")?.efficiency?.lastProgressAt).toBe(
    own!.lastProgressAt,
  );
});

it("an admitted lead can record a scope finding, and another lead cannot change that exact seat", async () => {
  const f = await fixture();
  expect(
    await f.captain.fleetEfficiency!("global-default", {
      seatId: "term_1",
      offScope: true,
      assignmentStatus: "paused",
      evidence: "Owner paused VUH-1662; worker still active",
    }),
  ).toMatchObject({
    seats: [
      {
        seatId: "term_1",
        efficiency: { flags: expect.arrayContaining(["off-scope", "context 80%", "no progress in 2h"]) },
      },
      { seatId: "term_2" },
    ],
  });
  await expect(
    f.captain.fleetEfficiency!(f.other, {
      seatId: "term_1",
      offScope: false,
      evidence: "A different lead's attempted edit",
    }),
  ).rejects.toThrow(/does not lead/u);
  const roster = OperatorConversationServiceResultSchema.parse(
    await f.captain.serveOperatorConversation({ op: "fleet", schemaVersion: 1 }),
  );
  if (roster.op !== "fleet") throw new Error("No fleet roster");
  expect(roster.snapshot.seats.find((seat) => seat.seatId === "term_1")?.efficiency?.flags).toContain(
    "off-scope",
  );
  expect(roster.snapshot.seats.find((seat) => seat.seatId === "term_4")?.efficiency).toBeUndefined();
});

it("large native objectives stay available in the roster while the wake carries bounded untrusted summaries", async () => {
  const objective = "Long untrusted native context.\n".repeat(500);
  const f = await fixture(500, objective);
  const [event] = await f.captain.pollSeatEvents(3000, undefined, "global-default");
  expect(event?.content.length).toBeLessThanOrEqual(10_000);
  expect(event?.content).toContain("Untrusted seat context:");
  expect(event?.content).toContain('"seatId":"term_1"');
  expect(event?.content).toContain('"seatId":"term_2"');
  expect(event?.content).not.toContain(objective);
  const result = await f.captain.fleetEfficiency!("global-default");
  expect(result.seats[0]?.efficiency?.objective).toBe(objective);
  await f.finish(event!.id);
});

it("same-thread workers needing readoption remain visible to their historical lead without permission to edit the new occupant", async () => {
  const f = await fixture(500, undefined, true);
  const show = await f.captain.fleetEfficiency!("global-default");
  expect(show.seats.find((seat) => seat.seatId === "term_rebound")?.efficiency?.flags).toContain(
    "reports failing",
  );
  await expect(
    f.captain.fleetEfficiency!("global-default", {
      seatId: "term_rebound",
      offScope: false,
      evidence: "Historical hire only",
    }),
  ).rejects.toThrow(/re-adopted/u);
  const [event] = await f.captain.pollSeatEvents(3000, undefined, "global-default");
  expect(event?.content).toContain('"seatId":"term_rebound"');
  expect(event?.content).toContain("reports failing");
  await f.finish(event!.id);
});

it("periodic inspection queues behind an active native turn and coalesces until that turn finishes", async () => {
  const f = await fixture(250);
  const sessionId = randomUUID();
  expect(
    f.captain.syncSeatTranscript("global-default", { sessionId, entries: [], activity: "responding" }),
  ).toBe(true);
  expect(await f.captain.pollSeatEvents(900, undefined, "global-default")).toEqual([]);
  const journal = new ConversationJournal(join(f.root, "conversations"));
  expect(
    journal.read("global-default").filter((event) => event.type === "turn" && event.phase === "accepted"),
  ).toHaveLength(1);
  expect(
    f.captain.syncSeatTranscript("global-default", { sessionId, entries: [], activity: "waiting" }),
  ).toBe(true);
  const [event] = await f.captain.pollSeatEvents(3000, undefined, "global-default");
  expect(event?.content).toContain("Fleet lead round.");
  await f.finish(event!.id, "global-default", sessionId);
});

it("a held fleet refresh cannot recreate efficiency persistence after Captain closes", async () => {
  const f = await fixture();
  await f.captain.serveOperatorConversation({ schemaVersion: 1, op: "fleet" });
  expect(existsSync(join(f.root, "seat-efficiency.json"))).toBe(true);
  const held = f.holdNextCensus();
  const refresh = f.captain.serveOperatorConversation({ schemaVersion: 1, op: "roster" });
  try {
    await held.started;
    f.rows[0]!.agent_status = "idle";
    await f.captain.close();
    await rm(f.root, { recursive: true, force: true });
    held.release();
    await refresh;
    expect(existsSync(f.root)).toBe(false);
  } finally {
    held.release();
    await refresh.catch(() => undefined);
  }
});
