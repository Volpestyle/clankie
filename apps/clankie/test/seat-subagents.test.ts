import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseClaudeSubagents, readClaudeSubagents } from "@clankie/agent-transcript";
import type { OperatorFleetSeat } from "@clankie/protocol";
import { withSeatSubagents } from "../src/captain/seat-subagents.ts";
import type { ObservedFleetSeat } from "../src/captain/herdr-census.ts";

const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const call = (messageId: string, id: string, description: string, name = "Agent") =>
  line({
    type: "assistant",
    message: {
      id: messageId,
      content: [{ type: "tool_use", id, name, input: { description, prompt: "…" } }],
    },
  });
const result = (id: string, toolUseResult: unknown = { status: "completed" }) =>
  line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id }] }, toolUseResult });
const notification = (id: string) =>
  line({
    type: "queue-operation",
    content: `<task-notification>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>\n</task-notification>`,
  });

describe("Claude subagents from the native transcript", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("counts foreground calls without results and background calls until their notification", () => {
    const journal =
      call("m1", "t1", "Map the app") +
      call("m1", "t2", "Review the diff", "Task") +
      result("t1") +
      call("m2", "t3", "Build the renderer") +
      result("t3", { isAsync: true, status: "async_launched" }) +
      line({ type: "assistant", isSidechain: true, message: { id: "side", content: [] } }) +
      call("m3", "t4", "Write tests");
    expect(parseClaudeSubagents(journal)).toEqual({
      // t2 was abandoned when the main thread spoke again in m2; t3 runs in the background.
      running: 2,
      recent: [
        { label: "Write tests", status: "running" },
        { label: "Build the renderer", status: "running" },
        { label: "Review the diff", status: "done" },
        { label: "Map the app", status: "done" },
      ],
    });
    expect(parseClaudeSubagents(journal + notification("t3") + result("t4")).running).toBe(0);
  });

  it("ignores other tools, keeps the eight newest and bounds labels", () => {
    let journal = line({
      type: "assistant",
      message: { id: "x", content: [{ type: "tool_use", id: "b", name: "Bash", input: {} }] },
    });
    for (let index = 0; index < 10; index += 1)
      journal += call(`m${String(index)}`, `t${String(index)}`, `${"x".repeat(200)}${String(index)}`);
    const summary = parseClaudeSubagents(journal);
    expect(summary.running).toBe(1);
    expect(summary.recent).toHaveLength(8);
    expect(summary.recent[0]?.label).toHaveLength(120);
  });

  it("reads appends incrementally from a session path", () => {
    const root = mkdtempSync(join(tmpdir(), "clankie-subagents-"));
    roots.push(root);
    const path = join(root, "session.jsonl");
    writeFileSync(path, call("m1", "t1", "Explore"));
    const session = { source: "test", kind: "path" as const, value: path };
    expect(readClaudeSubagents(session)).toEqual({
      running: 1,
      recent: [{ label: "Explore", status: "running" }],
    });
    appendFileSync(path, result("t1"));
    expect(readClaudeSubagents(session)?.running).toBe(0);
    expect(readClaudeSubagents({ ...session, value: join(root, "missing.jsonl") })).toBeUndefined();
  });

  it("reads only local Claude seats the host already has an address for", () => {
    const base = {
      occupantId: "o",
      personaId: "p",
      status: "working",
      title: "t",
    } satisfies Partial<OperatorFleetSeat>;
    const seats: OperatorFleetSeat[] = [
      { ...base, seatId: "addressed", harness: "claude" },
      { ...base, seatId: "roster-only", harness: "claude" },
      { ...base, seatId: "codex", harness: "codex" },
      { ...base, seatId: "remote", harness: "claude", fleet: "pc" },
    ];
    const observed = seats.map(
      (seat) =>
        ({
          ...seat,
          paneId: seat.seatId,
          subject: seat.seatId,
          session: { source: "herdr:claude", kind: "id", value: seat.seatId },
        }) as ObservedFleetSeat,
    );
    const read: string[] = [];
    const result = withSeatSubagents(
      seats,
      observed,
      (seat) => seat.seatId !== "roster-only",
      (session) => {
        read.push(session.value);
        return { running: 1, recent: [{ label: "x", status: "running" }] };
      },
    );
    expect(read).toEqual(["addressed"]);
    expect(result.map((seat) => seat.subagents?.running)).toEqual([1, undefined, undefined, undefined]);
    // An unreadable transcript leaves the count unknown rather than failing the roster.
    expect(
      withSeatSubagents(
        seats,
        observed,
        () => true,
        () => {
          throw new Error("EACCES");
        },
      )[0],
    ).not.toHaveProperty("subagents");
  });
});
