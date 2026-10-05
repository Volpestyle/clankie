import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import * as settingsAccounts from "@clankie/settings";
import { readCodexGoal } from "@clankie/agent-transcript";
import type { OperatorFleetSeat } from "@clankie/protocol";
import { createAgentWorkStore, withSeatWork } from "../src/captain/agent-work.ts";
import type { ObservedFleetSeat } from "../src/captain/herdr-census.ts";
import * as census from "../src/captain/herdr-census.ts";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import type { QuestionAuthority } from "../src/captain/conversation-questions.ts";
import { HerdrWatchStore } from "../src/captain/herdr-watch.ts";

const roots: string[] = [];
const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), "clankie-agent-work-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("publishes assignments and native goal changes through fleet cursors, independently of seat activity", async () => {
  const root = scratch();
  const db = new DatabaseSync(join(root, "goals_1.sqlite"));
  db.exec(
    "CREATE TABLE thread_goals (thread_id TEXT, objective TEXT, status TEXT, token_budget INTEGER, tokens_used INTEGER, time_used_seconds INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER)",
  );
  db.prepare("INSERT INTO thread_goals VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    id,
    "Verify the app",
    "active",
    40000,
    5000,
    12,
    1700000000000,
    1700000001000,
  );
  vi.spyOn(HerdrWatchStore.prototype, "start").mockImplementation(() => {});
  vi.spyOn(HerdrWatchStore.prototype, "trackSeat").mockImplementation(() => {});
  vi.spyOn(census, "readSeatIdForHerdrPane").mockResolvedValue("seat");
  const observed = vi.spyOn(census, "readFleet").mockResolvedValue({
    seats: [
      {
        seatId: "seat",
        paneId: "w1:p1",
        occupantId: id,
        subject: "seat",
        harness: "codex",
        status: "idle",
        title: "Juniper",
        account: { label: "Test", home: root },
        session: { kind: "id", source: "herdr:codex", value: id },
      },
    ],
  });
  const captain = createCaptain({} as CaptainDeps, {
    repoRoot: root,
    stateDir: root,
    settings: new SettingsStore(join(root, "settings.json")),
  });
  const fleet = async () => {
    const result = await captain.serveOperatorConversation({
      op: "fleet",
      schemaVersion: 1,
      includeWork: true,
    });
    if (result.op !== "fleet") throw new Error("Expected a fleet");
    return result.snapshot;
  };
  try {
    const initial = await fleet();
    expect(initial.seats[0]).toMatchObject({
      status: "idle",
      goal: { status: "active", objective: "Verify the app" },
    });
    const legacy = await captain.serveOperatorConversation({ op: "fleet", schemaVersion: 1 });
    if (legacy.op !== "fleet") throw new Error("Expected legacy fleet");
    expect(legacy.snapshot.goals).toBeUndefined();
    expect(legacy.snapshot.assignments).toBeUndefined();
    expect(legacy.snapshot.seats[0]).not.toHaveProperty("goal");
    await captain.serveOperatorConversation({
      op: "state_work",
      schemaVersion: 1,
      work: {
        herdrPaneId: "w1:p1",
        assignment: { objective: "Verify the app", issue: { repoId: "app", itemId: "#42" } },
      },
    });
    const assigned = await fleet();
    expect(assigned.cursor).not.toBe(initial.cursor);
    expect(assigned.seats[0]?.assignment?.issue).toEqual({ repoId: "app", itemId: "#42" });
    const oldRoster = await captain.serveOperatorConversation({ op: "roster", schemaVersion: 1 });
    if (oldRoster.op !== "roster") throw new Error("Expected roster");
    expect(oldRoster.seats[0]).not.toHaveProperty("goal");
    expect(oldRoster.seats[0]).not.toHaveProperty("assignment");
    db.prepare("UPDATE thread_goals SET status = ?, updated_at_ms = ? WHERE thread_id = ?").run(
      "paused",
      1700000002000,
      id,
    );
    const paused = await fleet();
    expect(paused.cursor).not.toBe(assigned.cursor);
    expect(paused.seats[0]).toMatchObject({ status: "idle", goal: { status: "paused" } });
    db.exec("DELETE FROM thread_goals");
    await captain.serveOperatorConversation({
      op: "state_work",
      schemaVersion: 1,
      work: { herdrPaneId: "w1:p1", assignment: null },
    });
    const cleared = await fleet();
    expect(cleared.cursor).not.toBe(paused.cursor);
    expect(cleared.seats[0]?.goal).toBeUndefined();
    expect(cleared.seats[0]?.assignment).toBeUndefined();

    vi.spyOn(settingsAccounts, "codexAccounts").mockReturnValue([{ label: "Test", home: root }]);
    observed.mockResolvedValue({
      seats: [],
      head: {
        seatId: "head",
        paneId: "w1:p2",
        occupantId: id,
        harness: "codex",
        status: "idle",
        session: { kind: "id", source: "herdr:codex", value: id },
      },
    });
    db.prepare("INSERT INTO thread_goals VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      id,
      "Verify the native head",
      "paused",
      40000,
      6000,
      14,
      1700000000000,
      1700000003000,
    );
    const head = await fleet();
    expect(head.goals).toEqual([
      expect.objectContaining({
        conversationId: "global-default",
        goal: expect.objectContaining({ objective: "Verify the native head", status: "paused" }),
      }),
    ]);
    const listed = await captain.serveOperatorConversation({
      op: "list",
      schemaVersion: 1,
      includeWork: true,
    });
    expect(
      listed.op === "list" &&
        listed.conversations.find((entry) => entry.conversationId === "global-default")?.goal?.objective,
    ).toBe("Verify the native head");
    vi.mocked(census.readSeatIdForHerdrPane).mockResolvedValue("head");
    const statedHead = await captain.serveOperatorConversation({
      op: "state_work",
      schemaVersion: 1,
      work: {
        herdrPaneId: "w1:p2",
        assignment: { objective: "Verify the native head", issue: { repoId: "app", itemId: "#42" } },
      },
    });
    expect(statedHead).toMatchObject({ op: "state_work", result: { outcome: "stated", seatId: "head" } });
    expect((await fleet()).assignments).toEqual([
      {
        conversationId: "global-default",
        assignment: expect.objectContaining({ issue: { repoId: "app", itemId: "#42" } }),
      },
    ]);
    const oldGet = await captain.serveOperatorConversation({
      op: "get",
      schemaVersion: 1,
      conversationId: "global-default",
    });
    if (oldGet.op !== "get") throw new Error("Expected conversation");
    expect(oldGet.conversation).not.toHaveProperty("goal");
    expect(oldGet.conversation).not.toHaveProperty("assignment");
    await captain.serveOperatorConversation({
      op: "state_work",
      schemaVersion: 1,
      work: { herdrPaneId: "w1:p2", assignment: null },
    });
    expect((await fleet()).assignments).toEqual([]);
    db.exec("DELETE FROM thread_goals");
    expect((await fleet()).goals).toEqual([]);

    observed.mockResolvedValue({ seats: [] });
    await fleet();
    // The previously observed native head stays native-bound after disappearance.
    // Exercise service-owned goals in a new Pi-owned conversation instead.
    const created = await captain.serveOperatorConversation({
      op: "create",
      schemaVersion: 1,
      scope: { kind: "global" },
      title: "Captain work",
    });
    if (created.op !== "create") throw new Error("Expected a captain conversation");
    const conversationId = created.conversation.conversationId;
    const owner: QuestionAuthority = {
      principal: { kind: "operator", id: "fixture-owner" },
      current: () => true,
      authorize: async () => true,
    };
    await captain.serveOperatorConversation(
      {
        op: "autonomy",
        schemaVersion: 1,
        conversationId,
        command: { action: "set_goal", objective: "Verify captain work", tokenBudget: 1000 },
      },
      owner,
    );
    await captain.serveOperatorConversation({
      op: "autonomy",
      schemaVersion: 1,
      conversationId,
      command: { action: "set_goal_status", status: "paused" },
    });
    expect((await fleet()).goals?.[0]?.goal).toMatchObject({
      objective: "Verify captain work",
      status: "paused",
      tokenBudget: 1000,
    });
    await captain.serveOperatorConversation({
      op: "autonomy",
      schemaVersion: 1,
      conversationId,
      command: { action: "clear_goal" },
    });
    expect((await fleet()).goals).toEqual([]);
  } finally {
    await captain.close();
    db.close();
  }
});
const id = "01999000-0000-7000-8000-000000000001";

it("reads native goal state without changing Codex's store or confusing it with a running turn", () => {
  const home = scratch();
  const path = join(home, "goals_1.sqlite");
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE thread_goals (thread_id TEXT, objective TEXT, status TEXT, token_budget INTEGER, tokens_used INTEGER, time_used_seconds INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER)",
  );
  db.prepare("INSERT INTO thread_goals VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    id,
    "Verify the app",
    "paused",
    40_000,
    5_000,
    12,
    1_700_000_000_000,
    1_700_000_001_000,
  );
  db.close();
  const before = readFileSync(path);
  expect(readCodexGoal({ source: "herdr:codex", kind: "id", value: id }, [home])).toMatchObject({
    objective: "Verify the app",
    status: "paused",
    tokenBudget: 40_000,
    tokensUsed: 5_000,
    timeUsedSeconds: 12,
  });
  expect(readFileSync(path)).toEqual(before);
  expect(
    readCodexGoal({ source: "herdr:codex", kind: "id", value: id }, [join(home, "missing")]),
  ).toBeUndefined();
  expect(existsSync(join(home, "missing", "goals_1.sqlite"))).toBe(false);
});

it("keeps an explicit issue pointer through restart and pane moves, without transferring it to another session", () => {
  const home = scratch();
  const store = createAgentWorkStore(home, () => 1_700_000_000_000);
  store.state("native-session", {
    objective: "Fix loading",
    issue: { repoId: "workspace", itemId: "VUH-1436" },
  });
  const restored = createAgentWorkStore(home);
  const seat: OperatorFleetSeat = {
    seatId: "new-pane",
    occupantId: "native-session",
    personaId: "juniper",
    harness: "claude",
    status: "idle",
    title: "Juniper",
  };
  expect(withSeatWork([seat], [], restored)[0]?.assignment?.issue?.itemId).toBe("VUH-1436");
  expect(
    withSeatWork([{ ...seat, occupantId: "different-session" }], [], restored)[0]?.assignment,
  ).toBeUndefined();
  restored.state("native-session", null);
  expect(createAgentWorkStore(home).read("native-session")).toBeUndefined();
});

it("does not inspect remote or unsupported native goal stores", () => {
  const store = createAgentWorkStore(scratch());
  const seats: OperatorFleetSeat[] = [
    {
      seatId: "remote",
      occupantId: "remote",
      personaId: "remote",
      harness: "codex",
      fleet: "pc",
      status: "working",
      title: "Remote",
    },
    {
      seatId: "claude",
      occupantId: "claude",
      personaId: "claude",
      harness: "claude",
      status: "working",
      title: "Claude",
    },
  ];
  const observed = seats.map((seat) => ({
    ...seat,
    paneId: seat.seatId,
    subject: seat.seatId,
    session: { kind: "id", source: "test", value: id },
  })) as ObservedFleetSeat[];
  const read = () => {
    throw new Error("Must not read this store");
  };
  expect(withSeatWork(seats, observed, store, read).every((seat) => seat.goal === undefined)).toBe(true);
});
