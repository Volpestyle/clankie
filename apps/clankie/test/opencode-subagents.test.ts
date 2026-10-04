import { DatabaseSync } from "node:sqlite";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { emptySettings } from "@clankie/settings";
import type { OperatorFleetSeat } from "@clankie/protocol";
import { projectOpenCodeSubagents } from "@clankie/agent-transcript";
import { createAgentSessions } from "../src/agent-sessions.ts";
import { OpenCodeProfiles } from "../src/opencode-profiles.ts";
import { withSeatSubagents } from "../src/captain/seat-subagents.ts";
import type { ObservedFleetSeat } from "../src/captain/herdr-census.ts";
import { writeOpenCodeNativeSession } from "./helpers/opencode-native-db.ts";
import native from "./fixtures/opencode-subagents-native.json" with { type: "json" };

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const iso = (at: number) => new Date(at).toISOString();
const start = native.completed.state.time.start;
const end = native.completed.state.time.end;
const seat: OperatorFleetSeat = {
  seatId: "native-opencode",
  occupantId: "o",
  personaId: "p",
  status: "working",
  title: "worker",
  harness: "opencode",
};
const observed = [
  {
    ...seat,
    paneId: seat.seatId,
    subject: seat.seatId,
    session: { source: "herdr:opencode", kind: "id", value: native.parent },
  },
] as ObservedFleetSeat[];

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opencode-subagents-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const profiles = new OpenCodeProfiles(root);
  const profile = await profiles.allocate();
  await writeOpenCodeNativeSession(profile.database, root, native.parent);
  await profiles.register(profile, native.parent, root, async () => {});
  const db = new DatabaseSync(profile.database);
  db.exec("PRAGMA foreign_keys=OFF"); // Fixture contains history tables only.
  cleanup.push(async () => db.close());
  db.prepare(
    "INSERT INTO session(id,project_id,parent_id,slug,directory,title,version,time_created,time_updated) VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(
    native.child,
    "project",
    native.parent,
    "child",
    root,
    "Inspect session reader (@general subagent)",
    "1.18.18",
    start,
    end,
  );
  const put = (id: string, part: unknown, at = start, role = "assistant") => {
    db.prepare("INSERT INTO message VALUES(?,?,?,?,?)").run(
      id,
      native.parent,
      at,
      at,
      JSON.stringify({ role, time: { created: at } }),
    );
    db.prepare("INSERT INTO part VALUES(?,?,?,?,?,?)").run(
      `prt_${id}`,
      id,
      native.parent,
      at,
      at,
      JSON.stringify(part),
    );
  };
  const update = (id: string, part: unknown) =>
    db.prepare("UPDATE part SET data=? WHERE id=?").run(JSON.stringify(part), `prt_${id}`);
  const sessions = createAgentSessions({ load: async () => emptySettings() }, undefined, profiles);
  const read = vi.fn(async (session) => sessions.subagents!(`local:${session.value}`));
  const fleet = async () =>
    (await withSeatSubagents([seat], observed, () => true, undefined, read))[0]?.subagents;
  return { root, db, profiles, sessions, put, update, read, fleet };
}

test("native task identity and times settle within one existing fleet read of collection", async () => {
  const f = await fixture();
  const running = structuredClone(native.completed);
  Object.assign(running.state, { status: "running", output: undefined, time: { start } });
  f.put("task", running);
  const entry = { id: running.callID, label: "general: Inspect session reader", startedAt: iso(start) };
  expect(await f.fleet()).toEqual({ running: 1, recent: [{ ...entry, status: "running" }] });
  f.update("task", native.completed);
  expect(await f.fleet()).toEqual({ running: 0, recent: [{ ...entry, status: "done", endedAt: iso(end) }] });
  expect(await f.fleet()).toEqual({ running: 0, recent: [{ ...entry, status: "done", endedAt: iso(end) }] });
  // Continuation reuses its child session, but starts another native call.
  f.put(
    "continued",
    { ...running, callID: "call_continuation", state: { ...running.state, time: { start: end + 1 } } },
    end + 1,
  );
  expect(await f.fleet()).toMatchObject({
    running: 1,
    recent: [
      { id: "call_continuation", status: "running" },
      { id: running.callID, status: "done" },
    ],
  });
});

test.each(["completed", "error"])(
  "background tool return stays running until a synthetic parent %s notification",
  async (status) => {
    const f = await fixture();
    const background = structuredClone(native.completed);
    background.state.metadata = {
      ...background.state.metadata,
      background: true,
    } as typeof background.state.metadata;
    background.state.output = `<task id="${native.child}" state="running">\n<task_result>\nStarted\n</task_result>\n</task>`;
    f.put("background", background);
    expect(await f.fleet()).toMatchObject({ running: 1, recent: [{ status: "running" }] });
    const notification = {
      type: "text",
      synthetic: true,
      text: `<task id="${native.child}" state="${status}">\n<summary>Background task finished</summary>\n<task_result>\nResult\n</task_result>\n</task>`,
    };
    f.put("ordinary", { ...notification, synthetic: false }, end + 1, "user");
    f.put("quoted", { ...notification, text: `Quoted:\n${notification.text}` }, end + 2, "user");
    expect(await f.fleet()).toMatchObject({ running: 1 });
    f.put("collected", notification, end + 3, "user");
    expect(await f.fleet()).toEqual({
      running: 0,
      recent: [
        {
          id: background.callID,
          label: "general: Inspect session reader",
          status: "done",
          startedAt: iso(start),
          endedAt: iso(end + 3),
        },
      ],
    });
  },
);

test("native error without child metadata and pending call still retain ids and source times", async () => {
  const f = await fixture();
  f.put("failed", native.error);
  f.put(
    "pending",
    {
      type: "tool",
      tool: "task",
      callID: "call_pending",
      state: { status: "pending", input: { description: "Investigate", subagent_type: "explore" } },
    },
    end + 1,
  );
  expect(await f.fleet()).toMatchObject({
    running: 1,
    recent: [
      { id: "call_pending", label: "explore: Investigate", status: "running", startedAt: iso(end + 1) },
      {
        id: native.error.callID,
        status: "done",
        startedAt: iso(native.error.state.time.start),
        endedAt: iso(native.error.state.time.end),
      },
    ],
  });
});

test("an older background notification cannot finish a later continuation in the same assistant message", async () => {
  const f = await fixture();
  const part = {
    ...native.completed,
    state: {
      ...native.completed.state,
      metadata: { ...native.completed.state.metadata, background: true },
      output: `<task id="${native.child}" state="running">\n<task_result>\nStarted\n</task_result>\n</task>`,
    },
  };
  f.put("same-message", part);
  f.db.prepare("INSERT INTO part VALUES(?,?,?,?,?,?)").run(
    "prt_same-message_later",
    "same-message",
    native.parent,
    end + 20,
    end + 20,
    JSON.stringify({
      ...part,
      callID: "call_later_continuation",
      state: { ...part.state, time: { start: end + 20, end: end + 21 } },
    }),
  );
  f.put(
    "older-notification",
    {
      type: "text",
      synthetic: true,
      text: `<task id="${native.child}" state="completed">\n<task_result>\nEarlier result\n</task_result>\n</task>`,
    },
    end + 10,
    "user",
  );
  expect(await f.fleet()).toMatchObject({
    running: 1,
    recent: [
      { id: "call_later_continuation", status: "running", startedAt: iso(end + 20) },
      { id: part.callID, status: "done", endedAt: iso(end + 10) },
    ],
  });
});

test("only addressed local id seats read a registered profile; foreign children and retargeted profiles refuse", async () => {
  const f = await fixture();
  f.put("task", native.completed);
  await withSeatSubagents([seat], observed, () => false, undefined, f.read);
  await withSeatSubagents([{ ...seat, fleet: "remote" }], observed, () => true, undefined, f.read);
  expect(f.read).not.toHaveBeenCalled();
  expect(await f.sessions.subagents!("remote:ses_anyNative123")).toBeUndefined();
  await expect(f.sessions.subagents!("local:ses_unregistered123")).rejects.toThrow("No registered");
  f.db.prepare("UPDATE session SET parent_id=? WHERE id=?").run("ses_unrelatedParent123", native.child);
  expect(await f.fleet()).toEqual({ running: 0, recent: [] });
  f.db.prepare("UPDATE session SET directory=? WHERE id=?").run("/replacement", native.parent);
  expect(await f.fleet()).toBeUndefined();
});

test("bounded task projection bounds labels, skips foreign envelopes and omits unknown times", () => {
  const part = {
    type: "tool",
    tool: "task",
    sessionID: native.parent,
    state: { status: "running", input: { description: "x".repeat(200), subagent_type: "general" } },
  };
  const summary = projectOpenCodeSubagents(
    native.parent,
    [
      {
        info: { sessionID: native.parent },
        parts: Array.from({ length: 80 }, (_, i) => ({ ...part, callID: `call_${i}` })),
      },
    ],
    () => true,
  );
  expect(summary.running).toBe(64);
  expect(summary.recent).toHaveLength(8);
  expect(summary.recent[0]).toMatchObject({ id: "call_79", status: "running" });
  expect(summary.recent[0]?.label).toHaveLength(120);
  expect(summary.recent[0]).not.toHaveProperty("startedAt");
  expect(
    projectOpenCodeSubagents(native.parent, [{ info: { sessionID: "foreign" }, parts: [part] }], () => true),
  ).toEqual({ running: 0, recent: [] });
});
