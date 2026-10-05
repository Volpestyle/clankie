import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCodexSubagents } from "@clankie/agent-transcript";
import type { OperatorFleetSeat } from "@clankie/protocol";
import type { ObservedFleetSeat } from "../src/captain/herdr-census.ts";
import { withSeatSubagents } from "../src/captain/seat-subagents.ts";

// Minimized from actual Codex 0.160.0 rollouts; see the VUH-1531 evidence report.
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/codex-subagents.json", import.meta.url), "utf8"),
) as {
  parent: { timestamp: string; type: string; payload: { id: string } };
  child: { timestamp: string; type: string; payload: Record<string, unknown> };
  taskStarted: unknown;
  collected: { timestamp: string; type: string; payload: Record<string, unknown> };
};
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const now = new Date("2026-10-04T18:00:00Z");
const roots: string[] = [];
const label = "Herschel · /root/wave1_adr";
const running = {
  running: 1,
  recent: [{ id: fixture.child.payload.id, label, status: "running", startedAt: fixture.child.timestamp }],
};
const done = {
  running: 0,
  recent: [
    {
      id: fixture.child.payload.id,
      label,
      status: "done",
      startedAt: fixture.child.timestamp,
      endedAt: fixture.collected.timestamp,
    },
  ],
};

function fresh(path: string): void {
  utimesSync(path, now, now);
}
function setup(extra = "") {
  const root = mkdtempSync(join(tmpdir(), "clankie-codex-subagents-"));
  roots.push(root);
  const directory = join(root, "sessions", "2026", "10", "04");
  mkdirSync(directory, { recursive: true });
  const parent = join(directory, `rollout-parent-${fixture.parent.payload.id}.jsonl`);
  const child = join(directory, `rollout-child-${String(fixture.child.payload.id)}.jsonl`);
  writeFileSync(parent, line(fixture.parent) + extra);
  writeFileSync(child, line(fixture.child) + line(fixture.taskStarted));
  fresh(parent);
  fresh(child);
  const session = { source: "herdr:codex", kind: "path" as const, value: parent };
  return { root, directory, parent, child, session };
}
// These calls/results preserve inspected native shapes with messages omitted.
function tool(
  name: string,
  output: unknown,
  target = "/root/wave1_adr",
  namespace: string | undefined = "collaboration",
) {
  const callId = `${name}-call`;
  const timestamp = "2026-10-04T17:50:00Z";
  return (
    line({
      timestamp,
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: callId,
        name,
        namespace,
        arguments: JSON.stringify({ target }),
      },
    }) +
    line({
      timestamp,
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: callId,
        output: typeof output === "string" ? output : JSON.stringify(output),
      },
    })
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Codex children on the existing seat subagents path", async () => {
  it("labels a native child by nickname and task, then settles in one fleet read of collection", async () => {
    const { parent, session } = setup();
    const seat = {
      seatId: "codex",
      occupantId: "o",
      personaId: "p",
      status: "working",
      title: "t",
      harness: "codex",
    } satisfies OperatorFleetSeat;
    const observed = [{ ...seat, paneId: seat.seatId, subject: seat.seatId, session }] as ObservedFleetSeat[];
    const fleet = async () => (await withSeatSubagents([seat], observed, () => true))[0]?.subagents;
    expect(await fleet()).toEqual(running);
    appendFileSync(parent, line(fixture.collected));
    expect(await fleet()).toEqual(done);
    expect(await fleet()).toEqual(done);
  });

  it("does not infer completion from an untargeted wait, ordinary message or quoted FINAL_ANSWER", async () => {
    const { parent, session } = setup(tool("wait_agent", { message: "Wait completed.", timed_out: false }));
    appendFileSync(
      parent,
      line({
        ...fixture.collected,
        payload: {
          ...fixture.collected.payload,
          content: [
            { type: "input_text", text: "Message Type: MESSAGE\nPayload:\nMessage Type: FINAL_ANSWER" },
          ],
        },
      }),
    );
    expect(await readCodexSubagents(session)).toEqual(running);
  });

  it("uses targeted list statuses and does not settle missing list members", async () => {
    const { parent, session } = setup(
      tool("list_agents", { agents: [{ agent_name: "/root", agent_status: "running" }] }),
    );
    expect(await readCodexSubagents(session)).toEqual(running);
    appendFileSync(
      parent,
      tool("list_agents", {
        agents: [{ agent_name: "/root/wave1_adr", agent_status: { completed: "result" } }],
      }),
    );
    expect(await readCodexSubagents(session)).toMatchObject({
      running: 0,
      recent: [{ id: fixture.child.payload.id, label, status: "done", startedAt: fixture.child.timestamp }],
    });
  });

  it("settles legacy close results by child UUID, not session_id (which is the parent)", async () => {
    const { session } = setup(
      tool(
        "close_agent",
        { previous_status: { completed: "result" } },
        String(fixture.child.payload.id),
        "multi_agent_v1",
      ),
    );
    expect(await readCodexSubagents(session)).toMatchObject({
      running: 0,
      recent: [{ id: fixture.child.payload.id, label, status: "done", startedAt: fixture.child.timestamp }],
    });
  });

  it("uses the older targeted wait result, and ignores close errors", async () => {
    const id = String(fixture.child.payload.id);
    const { parent, session } = setup(tool("close_agent", { error: "not found" }, id, undefined));
    expect(await readCodexSubagents(session)).toEqual(running);
    appendFileSync(parent, tool("wait_agent", { status: {}, timed_out: true }, id, "multi_agent_v1"));
    expect(await readCodexSubagents(session)).toEqual(running);
    appendFileSync(
      parent,
      tool(
        "wait_agent",
        { status: { [id]: { completed: "result" } }, timed_out: false },
        id,
        "multi_agent_v1",
      ),
    );
    expect(await readCodexSubagents(session)).toMatchObject({
      running: 0,
      recent: [{ id: fixture.child.payload.id, label, status: "done", startedAt: fixture.child.timestamp }],
    });
  });

  it("restarts after successful followup, preserves completion after failed followup, and settles interruption", async () => {
    const { parent, session } = setup(line(fixture.collected));
    expect(await readCodexSubagents(session)).toMatchObject({
      running: 0,
      recent: [{ id: fixture.child.payload.id, label, status: "done", startedAt: fixture.child.timestamp }],
    });
    appendFileSync(
      parent,
      tool("followup_task", "collab tool failed: agent thread limit reached", "wave1_adr"),
    );
    expect(await readCodexSubagents(session)).toMatchObject({
      running: 0,
      recent: [{ id: fixture.child.payload.id, label, status: "done", startedAt: fixture.child.timestamp }],
    });
    appendFileSync(parent, tool("followup_task", "", "wave1_adr"));
    expect(await readCodexSubagents(session)).toEqual(running);
    appendFileSync(parent, tool("interrupt_agent", { previous_status: "running" }, "wave1_adr"));
    expect(await readCodexSubagents(session)).toMatchObject({
      running: 0,
      recent: [{ id: fixture.child.payload.id, label, status: "done", startedAt: fixture.child.timestamp }],
    });
  });

  it("resolves relative followup targets from a subagent parent's own task path", async () => {
    const { parent, child, session } = setup();
    writeFileSync(
      parent,
      line({ ...fixture.parent, payload: { ...fixture.parent.payload, agent_path: "/root/reviewer" } }) +
        tool("list_agents", {
          agents: [{ agent_name: "/root/reviewer/check", agent_status: { completed: "result" } }],
        }),
    );
    writeFileSync(
      child,
      line({ ...fixture.child, payload: { ...fixture.child.payload, agent_path: "/root/reviewer/check" } }),
    );
    fresh(child);
    expect((await readCodexSubagents(session))?.running).toBe(0);
    appendFileSync(parent, tool("followup_task", "", "check"));
    expect((await readCodexSubagents(session))?.running).toBe(1);
  });

  it("redacts secrets in metadata labels", async () => {
    const { child, session } = setup();
    writeFileSync(
      child,
      line({
        ...fixture.child,
        payload: { ...fixture.child.payload, agent_nickname: "Bearer abcdefghijklmnop" },
      }),
    );
    fresh(child);
    expect((await readCodexSubagents(session))?.recent[0]?.label).toBe("Bearer [REDACTED] · /root/wave1_adr");
  });

  it("a newer child task_started supersedes the previous collected turn", async () => {
    const { child, session } = setup(line(fixture.collected));
    expect(await readCodexSubagents(session)).toMatchObject({
      running: 0,
      recent: [{ id: fixture.child.payload.id, label, status: "done", startedAt: fixture.child.timestamp }],
    });
    appendFileSync(
      child,
      line({ timestamp: "2026-10-04T17:55:00Z", type: "event_msg", payload: { type: "task_started" } }),
    );
    fresh(child);
    expect(await readCodexSubagents(session)).toEqual(running);
  });

  it("falls back to file idleness, but a native running status overrides the heuristic", async () => {
    const { child, parent, session } = setup();
    utimesSync(child, new Date(now.getTime() - 300_000), new Date(now.getTime() - 300_000));
    expect(await readCodexSubagents(session)).toMatchObject({
      running: 0,
      recent: [{ id: fixture.child.payload.id, label, status: "done", startedAt: fixture.child.timestamp }],
    });
    fresh(child);
    expect(await readCodexSubagents(session)).toEqual(running);
    utimesSync(child, new Date(now.getTime() - 300_000), new Date(now.getTime() - 300_000));
    appendFileSync(
      parent,
      tool("list_agents", { agents: [{ agent_name: "/root/wave1_adr", agent_status: "running" }] }),
    );
    expect(await readCodexSubagents(session)).toEqual(running);
  });

  it("discovers new cross-day direct children only in the parent's home and uses nested metadata", async () => {
    const { directory, child, session, root } = setup();
    const nested = { ...fixture.child, payload: { ...fixture.child.payload } };
    delete nested.payload.parent_thread_id;
    delete nested.payload.agent_path;
    delete nested.payload.agent_nickname;
    delete nested.payload.thread_source;
    writeFileSync(child, line(nested));
    fresh(child);
    const nextDay = join(root, "sessions", "2026", "10", "05");
    mkdirSync(nextDay);
    const other = join(nextDay, "rollout-another.jsonl");
    const grandchild = join(directory, "rollout-grandchild.jsonl");
    const foreign = join(directory, "rollout-foreign.jsonl");
    const metadata = (id: string, parentId: string, task: string) =>
      line({
        ...fixture.child,
        payload: {
          ...fixture.child.payload,
          id,
          parent_thread_id: parentId,
          agent_path: task,
        },
      });
    writeFileSync(
      grandchild,
      metadata(
        "00000000-0000-7000-8000-000000000002",
        String(fixture.child.payload.id),
        "/root/wave1_adr/grandchild",
      ),
    );
    writeFileSync(
      foreign,
      metadata(
        "00000000-0000-7000-8000-000000000003",
        "00000000-0000-7000-8000-000000000004",
        "/root/foreign",
      ),
    );
    expect(await readCodexSubagents(session)).toEqual(running);
    writeFileSync(
      other,
      metadata("00000000-0000-7000-8000-000000000001", fixture.parent.payload.id, "/root/second"),
    );
    fresh(other);
    expect((await readCodexSubagents(session))?.running).toBe(2);
  });

  it("defers partial headers and collection records, then handles a replaced parent", async () => {
    const { parent, child, session } = setup();
    writeFileSync(child, line(fixture.child).trimEnd());
    fresh(child);
    expect((await readCodexSubagents(session))?.running).toBe(0);
    appendFileSync(child, "\n");
    fresh(child);
    expect(await readCodexSubagents(session)).toEqual(running);
    const collected = line(fixture.collected);
    appendFileSync(parent, collected.slice(0, -2));
    expect(await readCodexSubagents(session)).toEqual(running);
    appendFileSync(parent, collected.slice(-2));
    expect(await readCodexSubagents(session)).toMatchObject({
      running: 0,
      recent: [{ id: fixture.child.payload.id, label, status: "done", startedAt: fixture.child.timestamp }],
    });
    const replacement = `${parent}.replacement`;
    writeFileSync(replacement, line(fixture.parent));
    renameSync(replacement, parent);
    expect(await readCodexSubagents(session)).toEqual(running);
  });

  it("counts beyond the eight displayed children and bounds their labels", async () => {
    const { directory, session } = setup();
    for (let index = 0; index < 9; index++) {
      const id = `00000000-0000-7000-8000-${String(index).padStart(12, "0")}`;
      const path = join(directory, `rollout-extra-${id}.jsonl`);
      writeFileSync(
        path,
        line({
          ...fixture.child,
          timestamp: "2026-10-04T17:40:00Z",
          payload: {
            ...fixture.child.payload,
            id,
            agent_nickname: "N".repeat(200),
            agent_path: `/root/task${index}`,
          },
        }),
      );
      fresh(path);
    }
    const summary = await readCodexSubagents(session);
    expect(summary?.running).toBe(10);
    expect(summary?.recent).toHaveLength(8);
    expect(summary?.recent[0]?.label).toHaveLength(120);
  });

  it("advances cached children to idle without a file change, sharing concurrent reads", async () => {
    const { session } = setup();
    const initial = await Promise.all(Array.from({ length: 16 }, () => readCodexSubagents(session)));
    expect(initial).toEqual(Array.from({ length: 16 }, () => running));
    vi.setSystemTime(new Date(now.getTime() + 300_000));
    expect(await readCodexSubagents(session)).toMatchObject({
      running: 0,
      recent: [{ status: "done", endedAt: new Date(now.getTime() + 300_000).toISOString() }],
    });
  });

  it("drops a removed or redirected cached child and discovers its replacement", async () => {
    const { child, session, root } = setup();
    expect(await readCodexSubagents(session)).toEqual(running);
    const outside = join(root, "outside.jsonl");
    writeFileSync(outside, line(fixture.child) + line(fixture.taskStarted));
    rmSync(child);
    symlinkSync(outside, child);
    expect(await readCodexSubagents(session)).toEqual({ running: 0, recent: [] });
    rmSync(child);
    writeFileSync(child, line(fixture.child) + line(fixture.taskStarted));
    fresh(child);
    expect(await readCodexSubagents(session)).toEqual(running);
    rmSync(child);
    expect(await readCodexSubagents(session)).toEqual({ running: 0, recent: [] });
  });

  it("discovers a child in a new date tree after the parent discovery was cached", async () => {
    const { session, root } = setup();
    expect(await readCodexSubagents(session)).toEqual(running);
    const directory = join(root, "sessions", "2027", "01", "01");
    mkdirSync(directory, { recursive: true });
    const child = join(directory, "rollout-new-year.jsonl");
    writeFileSync(
      child,
      line({
        ...fixture.child,
        payload: {
          ...fixture.child.payload,
          id: "00000000-0000-7000-8000-000000000099",
          agent_path: "/root/later",
        },
      }),
    );
    fresh(child);
    expect((await readCodexSubagents(session))?.running).toBe(2);
  });

  it("bounds discovery delay for a late child in an unrelated existing historical directory", async () => {
    const { session, root } = setup();
    const historical = join(root, "sessions", "2020", "01", "01");
    mkdirSync(historical, { recursive: true });
    writeFileSync(join(historical, "rollout-unrelated.jsonl"), line(fixture.parent));
    expect(await readCodexSubagents(session)).toEqual(running);
    const child = join(historical, "rollout-late-child.jsonl");
    writeFileSync(
      child,
      line({
        ...fixture.child,
        payload: {
          ...fixture.child.payload,
          id: "00000000-0000-7000-8000-000000000098",
          agent_path: "/root/late",
        },
      }),
    );
    fresh(child);
    expect(await readCodexSubagents(session)).toEqual(running);
    vi.setSystemTime(new Date(now.getTime() + 2_000));
    expect((await readCodexSubagents(session))?.running).toBe(2);
  });
});
