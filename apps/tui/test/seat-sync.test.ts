import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { expect, test, vi } from "vitest";
import { runSeatSyncCommand } from "../src/command/seat-sync.ts";

test("Codex hooks project only their bound native rollout and redact tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-seat-sync-"));
  const sessionId = randomUUID();
  const path = join(root, `rollout-2026-09-30T00-00-00-${sessionId}.jsonl`);
  const token = "clankie_op_" + "a".repeat(43);
  const requests: Array<Record<string, unknown>> = [];
  try {
    await writeFile(
      path,
      [
        {
          type: "response_item",
          payload: {
            id: "u1",
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Hello seat" }],
            internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] },
          },
        },
        {
          type: "response_item",
          payload: {
            id: "a1",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Hello operator" }],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "tool1",
            name: "exec_command",
            arguments: JSON.stringify({ command: `Authorization: Bearer ${token}` }),
          },
        },
      ]
        .map((item) => JSON.stringify(item))
        .join("\n") + "\n",
    );
    await runSeatSyncCommand([], {
      env: {
        CLANKIE_SEAT_HARNESS: "codex",
        CLANKIE_SEAT_SESSION_ID: sessionId,
        CLANKIE_CONVERSATION_ID: "scratch",
        CLANKIE_OPERATOR_TOKEN: token,
      },
      stdin: Readable.from([
        JSON.stringify({ session_id: sessionId, transcript_path: path, hook_event_name: "Stop" }),
      ]),
      fetchImpl: async (url, init) => {
        expect(String(url)).toContain("conversationId=scratch");
        expect(String(init?.body)).not.toContain(token);
        requests.push(JSON.parse(String(init?.body)));
        return Response.json({ ok: true });
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      sessionId,
      activity: "waiting",
      entries: [
        { type: "message", text: "Hello seat" },
        { type: "message", text: "Hello operator" },
        { type: "tool" },
      ],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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

test("seat sync omits internal channel deliveries but keeps queued human prompts and channel replies", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-seat-channel-"));
  const sessionId = randomUUID();
  const path = join(root, `${sessionId}.jsonl`);
  const records = [
    { uuid: "human", parentUuid: null, type: "user", message: { content: "Visible question" } },
    {
      uuid: "channel-user",
      parentUuid: "human",
      type: "user",
      message: { content: '<channel source="clankie">Private wake envelope</channel>' },
    },
    {
      uuid: "channel-queued",
      parentUuid: "channel-user",
      type: "attachment",
      attachment: {
        type: "queued_command",
        origin: { kind: "channel" },
        prompt: '<channel source="clankie">Private watch envelope</channel>',
      },
    },
    {
      uuid: "human-queued",
      parentUuid: "channel-queued",
      type: "attachment",
      attachment: { type: "queued_command", origin: { kind: "human" }, prompt: "Visible follow-up" },
    },
    {
      uuid: "reply",
      parentUuid: "human-queued",
      type: "assistant",
      message: { content: [{ type: "text", text: "Visible answer after the wake" }] },
    },
  ];
  const bodies: Array<{ entries: Array<{ text: string }>; activity: string }> = [];
  const sync = () =>
    runSeatSyncCommand([], {
      env: { CLANKIE_SEAT_SESSION_ID: sessionId, CLANKIE_OPERATOR_TOKEN: "clankie_op_" + "a".repeat(43) },
      stdin: Readable.from([
        JSON.stringify({ session_id: sessionId, transcript_path: path, hook_event_name: "Stop" }),
      ]),
      fetchImpl: async (_url, options) => {
        bodies.push(JSON.parse(String(options?.body)));
        return Response.json({ ok: true });
      },
    });
  try {
    await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    expect(await sync()).toBe(0);
    expect(bodies[0]!.entries.map((entry) => entry.text)).toEqual([
      "Visible question",
      "Visible follow-up",
      "Visible answer after the wake",
    ]);
    expect(bodies[0]!.activity).toBe("waiting");
    expect(JSON.stringify(bodies)).not.toContain("Private");
    expect(JSON.stringify(bodies)).not.toContain('"internal"');

    // An internal-only turn still settles the display activity.
    await writeFile(path, JSON.stringify({ ...records[1], parentUuid: null }) + "\n");
    expect(await sync()).toBe(0);
    expect(bodies[1]).toMatchObject({ entries: [], activity: "waiting" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("seat sync stops paging when the shared upload deadline expires", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-seat-deadline-"));
  const sessionId = randomUUID();
  const path = join(root, `${sessionId}.jsonl`);
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  let requests = 0;
  try {
    await writeFile(
      path,
      Array.from({ length: 101 }, (_, index) =>
        JSON.stringify({
          uuid: `message-${index}`,
          parentUuid: index ? `message-${index - 1}` : null,
          type: "user",
          message: { content: `Message ${index}` },
        }),
      ).join("\n") + "\n",
    );
    await expect(
      runSeatSyncCommand([], {
        env: { CLANKIE_SEAT_SESSION_ID: sessionId, CLANKIE_OPERATOR_TOKEN: "clankie_op_" + "a".repeat(43) },
        stdin: Readable.from([
          JSON.stringify({ session_id: sessionId, transcript_path: path, hook_event_name: "Stop" }),
        ]),
        fetchImpl: async (_url, options) => {
          requests++;
          expect(options?.signal).toBe(deadline.signal);
          deadline.abort(new Error("upload deadline"));
          return Response.json({ ok: true });
        },
      }),
    ).rejects.toThrow("upload deadline");
    expect(requests).toBe(1);
    expect(timeout).toHaveBeenCalledTimes(1);
  } finally {
    timeout.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("tool-call progress syncs mid-turn, at most once per burst", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-seat-progress-"));
  const sessionId = randomUUID();
  const bodies: unknown[] = [];
  try {
    const call = () =>
      runSeatSyncCommand([], {
        env: { CLANKIE_SEAT_SESSION_ID: sessionId, CLANKIE_OPERATOR_TOKEN: "clankie_op_" + "a".repeat(43) },
        stdin: Readable.from([
          JSON.stringify({
            session_id: sessionId,
            transcript_path: join(root, `${sessionId}.jsonl`),
            hook_event_name: "PostToolUse",
          }),
        ]),
        fetchImpl: async (_url, options) => {
          bodies.push(JSON.parse(String(options?.body)));
          return Response.json({ ok: true });
        },
      });
    await call();
    await call();
    expect(bodies).toEqual([{ sessionId, entries: [], activity: "responding" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(join(tmpdir(), `clankie-seat-sync-${sessionId}`), { force: true });
  }
});

test("Codex PostToolUse uploads commentary before Stop and Stop flushes throttled progress", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-midturn-"));
  const sessionId = randomUUID();
  const path = join(root, `rollout-progress-${sessionId}.jsonl`);
  const bodies: Array<{ entries: Array<{ text?: string }>; activity: string }> = [];
  const record = (text: string, id: string) =>
    JSON.stringify({
      type: "response_item",
      payload: {
        id,
        type: "message",
        role: "assistant",
        channel: "commentary",
        content: [{ type: "output_text", text }],
      },
    }) + "\n";
  const sync = (event: string) =>
    runSeatSyncCommand([], {
      env: {
        CLANKIE_SEAT_SESSION_ID: sessionId,
        CLANKIE_SEAT_HARNESS: "codex",
        CLANKIE_OPERATOR_TOKEN: "clankie_op_" + "a".repeat(43),
      },
      stdin: Readable.from([
        JSON.stringify({ session_id: sessionId, transcript_path: path, hook_event_name: event }),
      ]),
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ ok: true });
      },
    });
  try {
    await writeFile(path, record("I found the cause and am fixing it", "a1"));
    await sync("PostToolUse");
    expect(bodies).toMatchObject([
      { entries: [{ text: "I found the cause and am fixing it" }], activity: "responding" },
    ]);
    await writeFile(
      path,
      record("I found the cause and am fixing it", "a1") + record("The fix passed", "a2"),
    );
    await sync("PostToolUse");
    expect(bodies).toHaveLength(1);
    await sync("Stop");
    expect(bodies[1]).toMatchObject({
      entries: [{ text: "I found the cause and am fixing it" }, { text: "The fix passed" }],
      activity: "waiting",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(join(tmpdir(), `clankie-seat-sync-${sessionId}`), { force: true });
  }
});
