import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { expect, test } from "vitest";
import { runSeatSyncCommand } from "../src/command/seat-sync.ts";

test("seat hook uploads redacted native records to its selected conversation and never a child session", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-seat-sync-"));
  const sessionId = randomUUID(),
    path = join(root, sessionId + ".jsonl");
  const token = "clankie_op_" + "a".repeat(43);
  const env = {
    CLANKIE_SEAT_SESSION_ID: sessionId,
    CLANKIE_CONVERSATION_ID: "project-1",
    CLANKIE_OPERATOR_TOKEN: token,
  };
  const records = [
    { uuid: "user-1", parentUuid: null, type: "user", message: { content: "Project question" } },
    {
      uuid: "assistant-1",
      parentUuid: "user-1",
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Project answer" },
          {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: { command: `Authorization: Bearer ${token}` },
          },
        ],
      },
    },
  ];
  await writeFile(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const requests: Array<{ url: string; body: { entries: unknown[]; activity?: string } }> = [];
  const fetchImpl: typeof fetch = async (url, options) => {
    expect(options?.headers).toMatchObject({ authorization: `Bearer ${token}` });
    const body = JSON.parse(String(options?.body));
    expect(JSON.stringify(body)).not.toContain(token);
    expect(JSON.stringify(body)).not.toContain(path);
    requests.push({ url: String(url), body });
    return Response.json({ ok: true });
  };
  const input = (id = sessionId, transcript_path = path) =>
    Readable.from([JSON.stringify({ session_id: id, transcript_path, hook_event_name: "Stop" })]);
  try {
    expect(await runSeatSyncCommand([], { env, fetchImpl, stdin: input() })).toBe(0);
    expect(requests[0]!.url).toContain("/v1/seat/transcript?conversationId=project-1");
    expect(requests[0]!.body.entries).toHaveLength(3);
    expect(requests[0]!.body.activity).toBe("waiting");
    await runSeatSyncCommand([], { env, fetchImpl, stdin: input(randomUUID()) });
    expect(requests).toHaveLength(1);
    await expect(
      runSeatSyncCommand([], { env, fetchImpl, stdin: input(sessionId, join(root, "other.jsonl")) }),
    ).rejects.toThrow("does not match");
    await expect(
      runSeatSyncCommand([], {
        env,
        fetchImpl: async () => new Response("", { status: 503 }),
        stdin: input(),
      }),
    ).rejects.toThrow("next hook retries");
    await runSeatSyncCommand([], { env: {}, fetchImpl, stdin: input() });
    expect(requests).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native hooks report activity even before a transcript exists, but compaction does not settle a turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-seat-activity-"));
  const sessionId = randomUUID();
  const bodies: unknown[] = [];
  try {
    for (const hook_event_name of [
      "SessionStart",
      "UserPromptSubmit",
      "PreCompact",
      "StopFailure",
      "SessionEnd",
    ]) {
      await runSeatSyncCommand([], {
        env: { CLANKIE_SEAT_SESSION_ID: sessionId, CLANKIE_OPERATOR_TOKEN: "clankie_op_" + "a".repeat(43) },
        stdin: Readable.from([
          JSON.stringify({
            session_id: sessionId,
            transcript_path: join(root, `${sessionId}.jsonl`),
            hook_event_name,
          }),
        ]),
        fetchImpl: async (_url, options) => {
          bodies.push(JSON.parse(String(options?.body)));
          return Response.json({ ok: true });
        },
      });
    }
    expect(bodies).toEqual(
      ["waiting", "responding", "waiting", "waiting"].map((activity) => ({
        sessionId,
        entries: [],
        activity,
      })),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
