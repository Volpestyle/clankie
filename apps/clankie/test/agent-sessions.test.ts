import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  findAgentSession,
  listAgentSessions,
  parseAgentSessionRef,
  readAgentSession,
  type AgentSessionFile,
  type AgentTranscriptHost,
} from "@clankie/agent-transcript";
import { createAgentSessions, type AgentTurnRunner } from "../src/agent-sessions.ts";

/** A host whose files are in-memory strings, recording every byte read it serves. */
function memoryHost(
  files: Record<string, { harness: AgentSessionFile["harness"]; text: string; mtimeMs: number }>,
) {
  const reads: { path: string; from: number; maxBytes: number }[] = [];
  const host: AgentTranscriptHost = {
    id: "pc",
    list: async () =>
      Object.entries(files).map(([path, file]) => ({
        harness: file.harness,
        path,
        size: Buffer.byteLength(file.text),
        mtimeMs: file.mtimeMs,
      })),
    readBytes: async (path, from, maxBytes) => {
      reads.push({ path, from, maxBytes });
      const bytes = Buffer.from(files[path]!.text);
      return {
        bytes: bytes.subarray(from, from + maxBytes),
        size: bytes.length,
      };
    },
  };
  return { host, files, reads };
}

const codexLine = (id: string, text: string) =>
  `${JSON.stringify({
    timestamp: "2026-09-25T00:00:00Z",
    type: "response_item",
    payload: {
      id,
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
      internal_chat_message_metadata_passthrough: {
        content_item_kinds: ["user.text"],
      },
    },
  })}\n`;

const claudeLine = (uuid: string, parentUuid: string | null, text: string) =>
  `${JSON.stringify({
    type: "assistant",
    uuid,
    parentUuid,
    timestamp: "2026-09-25T00:00:00Z",
    message: { role: "assistant", content: [{ type: "text", text }] },
  })}\n`;

const CODEX =
  "C:\\Users\\volpe\\.codex\\sessions\\2026\\09\\25\\rollout-2026-09-25T15-10-58-01a0da31-497a-7d43-9d52-4f16482139aa.jsonl";
const CLAUDE = "C:\\Users\\volpe\\.claude\\projects\\C--dev-game\\533cf71b-2f7b-40a9-8983-1f61364b2604.jsonl";

const texts = (entries: readonly { type: string }[]) =>
  entries.flatMap((entry) => ("text" in entry ? [entry.text] : []));

describe("agent sessions over a transcript host", () => {
  it("lists newest first with host-qualified refs and resolves a unique prefix", async () => {
    const { host } = memoryHost({
      [CODEX]: { harness: "codex", text: codexLine("a", "hi"), mtimeMs: 1 },
      [CLAUDE]: {
        harness: "claude",
        text: claudeLine("u1", null, "yo"),
        mtimeMs: 2,
      },
    });
    const sessions = await listAgentSessions(host);
    expect(sessions.map((session) => session.ref)).toEqual([
      "pc:533cf71b-2f7b-40a9-8983-1f61364b2604",
      "pc:01a0da31-497a-7d43-9d52-4f16482139aa",
    ]);
    expect(sessions[0]!.project).toBe("C--dev-game");
    expect(parseAgentSessionRef("pc:01a0da31")).toEqual({
      host: "pc",
      session: "01a0da31",
    });
    expect(parseAgentSessionRef("01a0da31")).toEqual({
      host: "local",
      session: "01a0da31",
    });
    expect((await findAgentSession(host, "01a0")).path).toBe(CODEX);
    await expect(findAgentSession(host, "ffff")).rejects.toThrow(/No recent agent session/);
  });

  it("tails the last entries and pages only what was appended after the cursor", async () => {
    const { host, files } = memoryHost({
      [CODEX]: {
        harness: "codex",
        text: ["one", "two", "three"].map((t) => codexLine(t, t)).join(""),
        mtimeMs: 1,
      },
    });
    const file = await findAgentSession(host, "01a0da31");
    const first = await readAgentSession(host, file, { tail: 2 });
    expect(texts(first.entries)).toEqual(["two", "three"]);

    const idle = await readAgentSession(host, file, { after: first.cursor });
    expect(idle.entries).toEqual([]);
    expect(idle.cursor).toBe(first.cursor);

    // A half-written record stays for the next page instead of being dropped.
    files[CODEX]!.text += codexLine("four", "four") + codexLine("five", "five").slice(0, 20);
    const next = await readAgentSession(host, file, { after: first.cursor });
    expect(texts(next.entries)).toEqual(["four"]);
    files[CODEX]!.text = files[CODEX]!.text.slice(0, -20) + codexLine("five", "five");
    expect(texts((await readAgentSession(host, file, { after: next.cursor })).entries)).toEqual(["five"]);
  });

  it("walks Claude's chain across the page boundary without repeating earlier entries", async () => {
    const { host, files } = memoryHost({
      [CLAUDE]: {
        harness: "claude",
        text: claudeLine("u1", null, "first") + claudeLine("u2", "u1", "second"),
        mtimeMs: 1,
      },
    });
    const file = await findAgentSession(host, "533cf71b");
    const page = await readAgentSession(host, file);
    expect(texts(page.entries)).toEqual(["first", "second"]);
    files[CLAUDE]!.text += claudeLine("u3", "u2", "third");
    expect(texts((await readAgentSession(host, file, { after: page.cursor })).entries)).toEqual(["third"]);
  });

  it("restarts from the tail when the file under a cursor was replaced", async () => {
    const { host, files } = memoryHost({
      [CODEX]: {
        harness: "codex",
        text: codexLine("a", "old") + codexLine("b", "older"),
        mtimeMs: 1,
      },
    });
    const file = await findAgentSession(host, "01a0");
    const page = await readAgentSession(host, file);
    files[CODEX]!.text = codexLine("c", "new");
    const reset = await readAgentSession(host, file, { after: page.cursor });
    expect(reset.reset).toBe(true);
    expect(texts(reset.entries)).toEqual(["new"]);
    await expect(readAgentSession(host, file, { after: "-3" })).rejects.toThrow(/cursor/);
  });

  it("notices a replacement as long as the original instead of paging garbage", async () => {
    const { host, files } = memoryHost({
      [CODEX]: { harness: "codex", text: codexLine("a", "aaaa"), mtimeMs: 1 },
    });
    const file = await findAgentSession(host, "01a0");
    const page = await readAgentSession(host, file);
    files[CODEX]!.text = codexLine("a", "bbbb") + codexLine("b", "appended");
    const reset = await readAgentSession(host, file, { after: page.cursor });
    expect(reset.reset).toBe(true);
    expect(texts(reset.entries)).toEqual(["bbbb", "appended"]);
  });

  it("refuses a tail that is not a whole number in range", async () => {
    const { host } = memoryHost({ [CODEX]: { harness: "codex", text: codexLine("a", "hi"), mtimeMs: 1 } });
    const file = await findAgentSession(host, "01a0");
    for (const tail of [Number.NaN, Number.POSITIVE_INFINITY, 0, 1.5, 501])
      await expect(readAgentSession(host, file, { tail })).rejects.toThrow(/tail must be/);
  });

  it("refuses a cursor from another session", async () => {
    const { host } = memoryHost({
      [CODEX]: { harness: "codex", text: codexLine("a", "hi"), mtimeMs: 1 },
      [CLAUDE]: {
        harness: "claude",
        text: claudeLine("u1", null, "yo"),
        mtimeMs: 2,
      },
    });
    const codex = await readAgentSession(host, await findAgentSession(host, "01a0"));
    await expect(
      readAgentSession(host, await findAgentSession(host, "533c"), {
        after: codex.cursor,
      }),
    ).rejects.toThrow(/another session/);
  });

  it("reports a tool result that lands after the cursor, named by the call before it", async () => {
    const call = `${JSON.stringify({ type: "response_item", payload: { id: "c1", type: "function_call", call_id: "k1", name: "shell", arguments: "{}" } })}\n`;
    const output = `${JSON.stringify({ type: "response_item", payload: { id: "o1", type: "function_call_output", call_id: "k1", output: "done" } })}\n`;
    const { host, files } = memoryHost({
      [CODEX]: { harness: "codex", text: call, mtimeMs: 1 },
    });
    const file = await findAgentSession(host, "01a0");
    const page = await readAgentSession(host, file);
    expect(page.entries).toMatchObject([{ type: "tool", name: "shell", phase: "started" }]);
    files[CODEX]!.text += output;
    const next = await readAgentSession(host, file, { after: page.cursor });
    expect(next.entries).toMatchObject([
      { type: "tool", name: "shell", phase: "completed", toolCallId: "k1" },
    ]);
  });

  it("re-aims a tail when more was appended since listing than the read slack covers", async () => {
    const { host, files } = memoryHost({
      [CODEX]: { harness: "codex", text: codexLine("a", "listed"), mtimeMs: 1 },
    });
    const file = await findAgentSession(host, "01a0");
    files[CODEX]!.text += codexLine("pad", "x".repeat(600 * 1024)) + codexLine("b", "newest");
    expect(texts((await readAgentSession(host, file, { tail: 1 })).entries)).toEqual(["newest"]);
  });

  it("widens a tail window instead of reading a large transcript whole", async () => {
    const filler = "x".repeat(900 * 1024);
    const text =
      codexLine("a", "early") +
      codexLine("pad1", filler) +
      codexLine("pad2", filler) +
      codexLine("b", "late");
    const { host, reads } = memoryHost({
      [CODEX]: { harness: "codex", text, mtimeMs: 1 },
    });
    const file = await findAgentSession(host, "01a0");
    const page = await readAgentSession(host, file, { tail: 1 });
    expect(texts(page.entries)).toEqual(["late"]);
    expect(reads).toHaveLength(1);
    expect(reads[0]!.from).toBeGreaterThan(0);
  });

  it("steps over a record too long for one read instead of stalling the cursor", async () => {
    const { host, files } = memoryHost({
      [CODEX]: { harness: "codex", text: codexLine("a", "before"), mtimeMs: 1 },
    });
    const file = await findAgentSession(host, "01a0");
    const page = await readAgentSession(host, file);
    files[CODEX]!.text += codexLine("huge", "x".repeat(5 * 1024 * 1024)) + codexLine("b", "after");
    const skip = await readAgentSession(host, file, { after: page.cursor });
    expect(skip.skippedBytes).toBeGreaterThan(0);
    expect(skip.entries).toEqual([]);
    let next = await readAgentSession(host, file, { after: skip.cursor });
    while (next.skippedBytes !== undefined) next = await readAgentSession(host, file, { after: next.cursor });
    expect(next.reset).toBeUndefined();
    expect(texts(next.entries)).toEqual(["after"]);
  });

  it("stops re-aiming a tail that keeps outgrowing its reads", async () => {
    const { host, files, reads } = memoryHost({
      [CODEX]: { harness: "codex", text: codexLine("a", "a"), mtimeMs: 1 },
    });
    const file = await findAgentSession(host, "01a0");
    const readBytes = host.readBytes;
    host.readBytes = async (path, from, max) => {
      files[CODEX]!.text += codexLine("pad", "x".repeat(600 * 1024));
      return readBytes(path, from, max);
    };
    await readAgentSession(host, file, { tail: 1 });
    // One first read, three re-aims, and at most three widenings (256 KiB -> 1 MiB -> 3.75 MiB).
    expect(reads.length).toBeLessThanOrEqual(7);
  });
});

describe("agent sessions service", () => {
  it("never reads a cached path after a host is retargeted", async () => {
    const hosts: Record<string, ReturnType<typeof memoryHost>> = {
      "old-box": memoryHost({
        [CODEX]: {
          harness: "codex",
          text: codexLine("a", "old box"),
          mtimeMs: 1,
        },
      }),
      "new-box": memoryHost({
        [CODEX]: {
          harness: "codex",
          text: codexLine("a", "new box"),
          mtimeMs: 1,
        },
      }),
    };
    let settings = {
      agentHosts: {
        connections: [{ id: "pc", ssh: "old-box", shell: "powershell" as const }],
      },
    };
    const store = {
      load: async () => settings as never,
      update: async (mutate: (current: never) => never) => (settings = mutate(settings as never)),
    };
    const sessions = createAgentSessions(store, (id, connections) => {
      const config = connections.find((entry) => entry.id === id)!;
      return { ...hosts[config.ssh]!.host, id };
    });
    expect(texts((await sessions.read("pc:01a0")).entries)).toEqual(["old box"]);
    settings = {
      agentHosts: {
        connections: [{ id: "pc", ssh: "new-box", shell: "powershell" }],
      },
    };
    expect(texts((await sessions.read("pc:01a0")).entries)).toEqual(["new box"]);
    expect(hosts["new-box"]!.reads.length).toBeGreaterThan(0);
  });
});

describe("agent session send", () => {
  const PI =
    "/home/v/.pi/agent/sessions/--home-v-game--/2026-09-25T10-00-00-000Z_01a0d5af-e780-7398-8112-1b5f7092eebd.jsonl";
  const GROK =
    "/home/v/.grok/sessions/%2Fhome%2Fv%2Frivals/01a0c12b-d588-7a90-90a0-a506243efa04/chat_history.jsonl";
  const piText = `${JSON.stringify({ type: "session", id: "01a0d5af", cwd: "/home/v/game" })}\n`;

  function harness(
    options: { mtimeMs?: number; run?: AgentTurnRunner["runAgentTurn"]; runsPath?: string } = {},
  ) {
    const memory = memoryHost({
      [PI]: { harness: "pi", text: piText, mtimeMs: options.mtimeMs ?? 0 },
      [GROK]: { harness: "grok", text: "", mtimeMs: 0 },
    });
    const turns: Parameters<AgentTurnRunner["runAgentTurn"]>[0][] = [];
    let settle!: (value: Awaited<ReturnType<AgentTurnRunner["runAgentTurn"]>>) => void;
    const host = {
      ...memory.host,
      runAgentTurn:
        options.run ??
        ((input: Parameters<AgentTurnRunner["runAgentTurn"]>[0]) => {
          turns.push(input);
          return new Promise<Awaited<ReturnType<AgentTurnRunner["runAgentTurn"]>>>(
            (resolve) => (settle = resolve),
          );
        }),
    };
    const settings = { agentHosts: { connections: [{ id: "pc", ssh: "box", shell: "posix" as const }] } };
    const sessions = createAgentSessions({ load: async () => settings as never }, () => host, {
      clock: () => 120_000,
      ...(options.runsPath === undefined ? {} : { runsPath: options.runsPath }),
    });
    return {
      sessions,
      turns,
      settle: (value: Awaited<ReturnType<AgentTurnRunner["runAgentTurn"]>>) => settle(value),
    };
  }

  it("names Grok and Pi sessions and resumes from the directory each recorded", async () => {
    const { sessions, turns, settle } = harness();
    const listed = await sessions.list({ host: "pc" });
    expect(listed.sessions.map((session) => [session.harness, session.sessionId, session.project])).toEqual(
      expect.arrayContaining([
        ["pi", "01a0d5af-e780-7398-8112-1b5f7092eebd", "--home-v-game--"],
        ["grok", "01a0c12b-d588-7a90-90a0-a506243efa04", "/home/v/rivals"],
      ]),
    );
    const run = await sessions.send("pc:01a0d5af", "status?");
    expect(run.state).toBe("running");
    expect(turns).toEqual([
      {
        harness: "pi",
        sessionId: "01a0d5af-e780-7398-8112-1b5f7092eebd",
        sessionPath: PI,
        cwd: "/home/v/game",
        message: "status?",
      },
    ]);
    const grok = await sessions.send("pc:01a0c12b", "hi");
    expect(turns[1]!.cwd).toBe("/home/v/rivals");
    settle({ exitCode: 0, stdout: "ok", stderr: "" });
    await vi.waitFor(() =>
      expect(sessions.run(grok.runId)).toMatchObject({ state: "finished", output: "ok" }),
    );
  });

  it("refuses a session written within the quiet window, and a second turn on a busy one", async () => {
    await expect(harness({ mtimeMs: 100_000 }).sessions.send("pc:01a0d5af", "hi")).rejects.toMatchObject({
      status: 409,
    });
    const { sessions } = harness();
    await sessions.send("pc:01a0d5af", "one");
    await expect(sessions.send("pc:01a0d5af", "two")).rejects.toThrow(/already has run/);
  });

  it("keeps the session locked when the transport is lost, until an operator releases it", async () => {
    const { sessions, settle } = harness();
    const run = await sessions.send("pc:01a0d5af", "one");
    settle({ exitCode: null, stdout: "", stderr: "connection reset", termination: "unknown" });
    await vi.waitFor(() => expect(sessions.run(run.runId).state).toBe("unknown"));
    await expect(sessions.send("pc:01a0d5af", "two")).rejects.toThrow(/unknown/);
    // Cancelling claims a stop it cannot prove; only an explicit release unlocks.
    expect(() => sessions.cancel(run.runId)).toThrow(/release/);
    expect(sessions.release(run.runId).state).toBe("released");
    await expect(sessions.send("pc:01a0d5af", "two")).resolves.toMatchObject({ state: "running" });
  });

  it("treats a runner that throws as unknown, not finished", async () => {
    const { sessions } = harness({
      run: async () => {
        throw new Error("ssh: broken pipe authorization: Bearer sk-live-abcdefgh12345678");
      },
    });
    const run = await sessions.send("pc:01a0d5af", "one");
    await vi.waitFor(() =>
      expect(sessions.run(run.runId)).toMatchObject({
        state: "unknown",
        output: "ssh: broken pipe authorization: [REDACTED]",
      }),
    );
  });

  it("starts only one of two concurrent sends to the same session", async () => {
    const { sessions, turns } = harness();
    const results = await Promise.allSettled([
      sessions.send("pc:01a0d5af", "one"),
      sessions.send("pc:01a0d5af", "two"),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(turns).toHaveLength(1);
  });

  it("measures the message cap in UTF-8 bytes and refuses NUL", async () => {
    const { sessions } = harness();
    await expect(sessions.send("pc:01a0d5af", "é".repeat(20_000))).rejects.toThrow(/bytes/);
    await expect(sessions.send("pc:01a0d5af", "a\0b")).rejects.toThrow(/NUL/);
  });

  it("brings a run that was in flight across a restart back as unknown and still locked", async () => {
    const runsPath = join(mkdtempSync(join(tmpdir(), "agent-runs-")), "runs.json");
    const first = harness({ runsPath });
    const run = await first.sessions.send("pc:01a0d5af", "one");
    const second = harness({ runsPath });
    expect(second.sessions.run(run.runId)).toMatchObject({ state: "unknown" });
    await expect(second.sessions.send("pc:01a0d5af", "two")).rejects.toThrow(/unknown/);
  });

  it("refuses to start from a damaged runs file rather than reopen locked sessions", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-runs-"));
    const runsPath = join(dir, "runs.json");
    for (const damaged of [
      "{}",
      JSON.stringify([{ runId: "r", ref: "pc:x", state: "sleeping", startedAt: "t", cursor: "c" }]),
      JSON.stringify([{ runId: "r" }]),
    ]) {
      writeFileSync(runsPath, damaged);
      expect(() => harness({ runsPath })).toThrow(/damaged/);
    }
  });

  it("keeps the lock when the end of a run cannot be saved, without an unhandled rejection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-runs-"));
    const { sessions, settle } = harness({ runsPath: join(dir, "runs.json") });
    const run = await sessions.send("pc:01a0d5af", "one");
    chmodSync(dir, 0o500);
    try {
      settle({ exitCode: 0, stdout: "done", stderr: "" });
      await vi.waitFor(() =>
        expect(sessions.run(run.runId)).toMatchObject({
          state: "unknown",
          output: expect.stringContaining("Could not record"),
        }),
      );
      await expect(sessions.send("pc:01a0d5af", "two")).rejects.toThrow(/unknown/);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("redacts output whole before keeping its tail", async () => {
    const { sessions, settle } = harness();
    const run = await sessions.send("pc:01a0d5af", "one");
    // The token straddles the 4 KiB tail boundary: cut first, and its prefix is gone.
    const token = "Bearer sk-live-abcdefgh12345678";
    settle({ exitCode: 0, stdout: `${token}${"x".repeat(4096 - 20)}`, stderr: "" });
    await vi.waitFor(() => expect(sessions.run(run.runId).state).toBe("finished"));
    expect(sessions.run(run.runId).output).not.toContain("12345678");
  });

  it("refuses a subagent transcript that has no session UUID to resume, without locking it", async () => {
    const SUB =
      "/home/v/.claude/projects/-home-v-game/0a1b2c3d-0000-4000-8000-000000000000/subagents/agent-a1b2c3.jsonl";
    const memory = memoryHost({
      [SUB]: { harness: "claude", text: claudeLine("u1", null, "sub"), mtimeMs: 0 },
    });
    let launched = false;
    const host = {
      ...memory.host,
      runAgentTurn: async () => ((launched = true), { exitCode: 0, stdout: "", stderr: "" }),
    };
    const settings = { agentHosts: { connections: [{ id: "pc", ssh: "box", shell: "posix" as const }] } };
    const sessions = createAgentSessions({ load: async () => settings as never }, () => host, {
      clock: () => 120_000,
    });
    await expect(sessions.send("pc:agent-a1b2c3", "hi")).rejects.toMatchObject({ status: 409 });
    expect(launched).toBe(false);
    expect(sessions.runs()).toEqual([]);
  });
});
