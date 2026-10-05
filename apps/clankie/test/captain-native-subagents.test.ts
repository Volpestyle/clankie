import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OperatorPresenceSnapshotSchema } from "@clankie/protocol/presence";
import { captainNativeSubagents, pollPresence, projectPresence } from "../src/captain/presence.ts";

const idle = { thinking: false, inVoice: false, playing: false, activeSeats: 4 };
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const start = line({
  type: "assistant",
  message: {
    id: "m1",
    content: [{ type: "tool_use", id: "child", name: "Agent", input: { description: "Review" } }],
  },
});
const finish = line({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: "child" }] },
  toolUseResult: { status: "completed" },
});

describe("captain native children across transcript, presence and schema", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  function parent(contents: string) {
    const root = mkdtempSync(join(tmpdir(), "clankie-captain-children-"));
    roots.push(root);
    const path = join(root, "parent.jsonl");
    writeFileSync(path, contents);
    return { harness: "claude", session: { source: "test", kind: "path" as const, value: path } };
  }
  it("reports the selected captain parent's real running children independently of worker seats", async () => {
    const captain = parent(start);
    const worker = parent(start + start);
    expect(await captainNativeSubagents(captain)).toBe(1);
    const snapshot = OperatorPresenceSnapshotSchema.parse(
      projectPresence({ ...idle, nativeSubagents: (await captainNativeSubagents(captain))! }),
    );
    expect(snapshot).toMatchObject({ activeSeats: 4, nativeSubagents: 1 });
    appendFileSync(captain.session.value, finish);
    expect(await captainNativeSubagents(captain)).toBe(0);
    expect(await captainNativeSubagents(worker)).toBe(1);
    expect(await captainNativeSubagents(undefined)).toBeUndefined();
    expect(
      await captainNativeSubagents({
        ...captain,
        session: { ...captain.session, value: join(roots[0]!, "missing.jsonl") },
      }),
    ).toBeUndefined();
    expect(projectPresence(idle)).not.toHaveProperty("nativeSubagents");
    expect(OperatorPresenceSnapshotSchema.safeParse({ ...snapshot, nativeSubagents: -1 }).success).toBe(
      false,
    );
    expect(OperatorPresenceSnapshotSchema.safeParse({ ...snapshot, nativeSubagents: 0.5 }).success).toBe(
      false,
    );
  });
  it("wakes for child completion and parent replacement while the fleet count stays fixed", async () => {
    let captain = parent(start);
    const read = async () =>
      projectPresence({ ...idle, nativeSubagents: (await captainNativeSubagents(captain))! });
    const first = await read();
    const completion = pollPresence(read, first.cursor, 2000);
    appendFileSync(captain.session.value, finish);
    const completed = await completion;
    expect(completed.nativeSubagents).toBe(0);
    expect(completed.cursor).not.toBe(first.cursor);
    expect(completed.activeSeats).toBe(first.activeSeats);
    const replacement = pollPresence(read, completed.cursor, 2000);
    captain = parent(start);
    expect((await replacement).nativeSubagents).toBe(1);
  });
});
