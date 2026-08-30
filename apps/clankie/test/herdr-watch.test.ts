import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPERATOR_CONVERSATION_TEXT_MAX } from "@clankie/protocol";
import { parseHerdrSeatTranscript } from "../src/captain/herdr-transcript.ts";
import {
  distillHerdrSeatReply,
  herdrAgentName,
  HerdrWatchStore,
  parseHerdrAgentResult,
  parseHerdrForegroundProcessId,
  type HerdrAgentSnapshot,
  type HerdrWatchRunner,
} from "../src/captain/herdr-watch.ts";

const roots: string[] = [];
const working: HerdrAgentSnapshot = {
  paneId: "w18:p1",
  terminalId: "term-potato",
  agent: "claude",
  status: "working",
  title: "PStack analysis",
};
const done = { ...working, status: "done" };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("HerdrWatchStore", () => {
  it("persists one event-driven wait and wakes the same conversation when it settles", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-herdr-watch-"));
    roots.push(root);
    const path = join(root, "herdr-watches.json");
    const settled = deferred<HerdrAgentSnapshot>();
    const runner: HerdrWatchRunner = {
      get: vi.fn(() => Promise.resolve(working)),
      resolveTerminal: vi.fn(() => Promise.resolve(working)),
      wait: vi.fn(() => settled.promise),
    };
    const wake = vi.fn((_conversationId: string, _prompt: string) => Promise.resolve());
    const store = new HerdrWatchStore(path, { runner });
    store.start(wake);

    const armed = await store.watch("global-default", "w18:p1", "Harvest the PStack synthesis");
    expect(armed).toMatchObject({ outcome: "watching", alreadyWatching: false, terminalId: "term-potato" });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      watches: [{ conversationId: "global-default", terminalId: "term-potato" }],
    });

    settled.resolve(done);
    await vi.waitFor(() => expect(wake).toHaveBeenCalledOnce());
    expect(wake).toHaveBeenCalledWith(
      "global-default",
      expect.stringContaining("Harvest the PStack synthesis"),
    );
    expect(wake.mock.calls[0]?.[1]).toContain("agent status done");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ schemaVersion: 1, watches: [] });
    store.close();
  });

  it("re-arms a persisted watch after restart using the stable terminal id", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-herdr-watch-restart-"));
    roots.push(root);
    const path = join(root, "herdr-watches.json");
    const firstRunner: HerdrWatchRunner = {
      get: () => Promise.resolve(working),
      resolveTerminal: () => Promise.resolve(working),
      wait: (_target, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    };
    const first = new HerdrWatchStore(path, { runner: firstRunner });
    first.start(() => Promise.resolve());
    await first.watch("global-default", "w18:p1", "Harvest after restart");
    first.close();

    const wake = vi.fn((_conversationId: string, _prompt: string) => Promise.resolve());
    const second = new HerdrWatchStore(path, {
      runner: {
        get: () => Promise.resolve(done),
        resolveTerminal: (terminalId) => {
          expect(terminalId).toBe("term-potato");
          return Promise.resolve(done);
        },
        wait: () => Promise.reject(new Error("already settled; wait should not run")),
      },
    });
    second.start(wake);
    await vi.waitFor(() => expect(wake).toHaveBeenCalledOnce());
    expect(wake.mock.calls[0]?.[1]).toContain("agent status done");
    second.close();
  });

  it("returns an already-settled pane instead of arming a redundant watcher", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-herdr-watch-done-"));
    roots.push(root);
    const wait = vi.fn(() => Promise.resolve(done));
    const store = new HerdrWatchStore(join(root, "herdr-watches.json"), {
      runner: {
        get: () => Promise.resolve(done),
        resolveTerminal: () => Promise.resolve(done),
        wait,
      },
    });
    store.start(() => Promise.resolve());
    await expect(store.watch("global-default", "w18:p1", "Harvest it")).resolves.toEqual({
      outcome: "already_settled",
      target: "w18:p1",
      paneId: "w18:p1",
      terminalId: "term-potato",
      status: "done",
    });
    expect(wait).not.toHaveBeenCalled();
    store.close();
  });

  it("sends through the current pane and projects status and changed summaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-herdr-seat-watch-"));
    roots.push(root);
    const summariesPath = join(root, "summaries.json");
    await writeFile(
      summariesPath,
      JSON.stringify({ at: new Date().toISOString(), agents: { "w18:p1": { summary: "Initial" } } }),
    );
    let current = working;
    const changed = deferred<HerdrAgentSnapshot>();
    const sendText = vi.fn(() => Promise.resolve());
    const pressEnter = vi.fn(() => Promise.resolve());
    const closePane = vi.fn((_target: string) => Promise.resolve());
    const read = vi.fn((_target: string, _harness: string, source: string) =>
      Promise.resolve(source === "recent-unwrapped" ? "※ recap: Tests are green." : ""),
    );
    const runner: HerdrWatchRunner = {
      get: () => Promise.resolve(current),
      resolveTerminal: () => Promise.resolve(current),
      wait: () => Promise.resolve(done),
      waitForChange: (_target, status, signal) =>
        status === "working"
          ? changed.promise
          : new Promise((_resolve, reject) =>
              signal.addEventListener("abort", () => reject(new Error("aborted"))),
            ),
      read,
      sendText,
      pressEnter,
      closePane,
    };
    const project = vi.fn();
    const store = new HerdrWatchStore(join(root, "watches.json"), {
      runner,
      summariesPath,
      summaryWatchIntervalMs: 10,
    });
    store.start(() => Promise.resolve(), project);
    store.trackSeat("term-potato");

    await vi.waitFor(() =>
      expect(project).toHaveBeenCalledWith("term-potato", { kind: "status", status: "working" }),
    );
    await vi.waitFor(() =>
      expect(project).toHaveBeenCalledWith("term-potato", { kind: "summary", text: "Initial" }),
    );
    await expect(store.sendToSeat("term-potato", "hello")).resolves.toBe(true);
    expect(sendText).toHaveBeenCalledWith("w18:p1", "hello");
    expect(pressEnter).toHaveBeenCalledWith("w18:p1");
    await expect(store.closeSeat("term-potato")).resolves.toBe(true);
    expect(closePane).toHaveBeenCalledWith("w18:p1");

    await writeFile(
      summariesPath,
      JSON.stringify({ at: new Date().toISOString(), agents: { "w18:p1": { summary: "Finished" } } }),
    );
    await vi.waitFor(() =>
      expect(project).toHaveBeenCalledWith("term-potato", { kind: "summary", text: "Finished" }),
    );
    current = done;
    changed.resolve(done);
    await vi.waitFor(() =>
      expect(project).toHaveBeenCalledWith("term-potato", { kind: "status", status: "done" }),
    );
    expect(project).toHaveBeenCalledWith("term-potato", {
      kind: "reply",
      text: "Tests are green.",
    });
    expect(read).toHaveBeenCalledWith("w18:p1", "claude", "recent-unwrapped");
    store.close();
  });

  it("seeds a tracked seat that is already settled with its last distilled answer", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-herdr-seat-seed-"));
    roots.push(root);
    const read = vi.fn(() => Promise.resolve("※ recap: Already shipped before tracking."));
    const project = vi.fn();
    const store = new HerdrWatchStore(join(root, "watches.json"), {
      runner: {
        get: () => Promise.resolve(done),
        resolveTerminal: () => Promise.resolve(done),
        wait: () => Promise.resolve(done),
        waitForChange: (_target, _status, signal) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(new Error("aborted"))),
          ),
        read,
      },
    });
    store.start(() => Promise.resolve(), project);
    store.trackSeat("term-potato");

    await vi.waitFor(() =>
      expect(project).toHaveBeenCalledWith("term-potato", {
        kind: "reply",
        text: "Already shipped before tracking.",
      }),
    );
    expect(read).toHaveBeenCalledWith("w18:p1", "claude", "recent-unwrapped");
    expect(read).toHaveBeenCalledOnce();
    store.close();
  });

  it("keeps status observation alive when settled reply capture fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-herdr-seat-reply-failure-"));
    roots.push(root);
    let current = working;
    const changed = deferred<HerdrAgentSnapshot>();
    const project = vi.fn();
    const store = new HerdrWatchStore(join(root, "watches.json"), {
      runner: {
        get: () => Promise.resolve(current),
        resolveTerminal: () => Promise.resolve(current),
        wait: () => Promise.resolve(done),
        waitForChange: (_target, status, signal) =>
          status === "working"
            ? changed.promise
            : new Promise((_resolve, reject) =>
                signal.addEventListener("abort", () => reject(new Error("aborted"))),
              ),
        read: () => Promise.reject(new Error("pane read unavailable")),
      },
    });
    store.start(() => Promise.resolve(), project);
    store.trackSeat("term-potato");

    await vi.waitFor(() =>
      expect(project).toHaveBeenCalledWith("term-potato", { kind: "status", status: "working" }),
    );
    current = done;
    changed.resolve(done);
    await vi.waitFor(() =>
      expect(project).toHaveBeenCalledWith("term-potato", { kind: "status", status: "done" }),
    );
    expect(project.mock.calls.some(([, projection]) => projection.kind === "reply")).toBe(false);
    store.close();
  });

  it("projects the harness-native transcript instead of a lossy terminal summary", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-herdr-seat-transcript-"));
    roots.push(root);
    const transcript = {
      sessionKey: "herdr:claude:id:session-1",
      messages: [
        { id: "claude:u1", role: "operator" as const, text: "Ship it" },
        { id: "claude:a1", role: "agent" as const, text: "Shipped." },
      ],
    };
    const project = vi.fn();
    const read = vi.fn(() => Promise.resolve("※ recap: lossy fallback"));
    const store = new HerdrWatchStore(join(root, "watches.json"), {
      runner: {
        get: () => Promise.resolve(done),
        resolveTerminal: () => Promise.resolve(done),
        wait: () => Promise.resolve(done),
        transcript: () => Promise.resolve(transcript),
        read,
      },
    });
    store.start(() => Promise.resolve(), project);
    store.trackSeat("term-potato");

    await vi.waitFor(() =>
      expect(project).toHaveBeenCalledWith("term-potato", { kind: "transcript", transcript }),
    );
    expect(project.mock.calls.findIndex(([, projection]) => projection.kind === "transcript")).toBeLessThan(
      project.mock.calls.findIndex(
        ([, projection]) => projection.kind === "status" && projection.status === "done",
      ),
    );
    expect(read).not.toHaveBeenCalled();
    store.close();
  });
});

describe("harness-native seat transcripts", () => {
  it("keeps Codex user text and assistant commentary/final text, not injected instructions", () => {
    const line = (value: unknown) => JSON.stringify(value);
    const messages = parseHerdrSeatTranscript(
      "codex",
      [
        line({
          timestamp: "2026-08-30T00:00:00Z",
          type: "response_item",
          payload: {
            id: "instructions",
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "AGENTS.md" }],
            internal_chat_message_metadata_passthrough: { content_item_kinds: ["agents_md.instructions"] },
          },
        }),
        line({
          timestamp: "2026-08-30T00:00:01Z",
          type: "response_item",
          payload: {
            id: "u1",
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Ship it" }],
            internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] },
          },
        }),
        line({
          type: "response_item",
          payload: {
            id: "a1",
            type: "message",
            role: "assistant",
            phase: "commentary",
            content: [{ type: "output_text", text: "Running tests." }],
          },
        }),
        line({
          type: "response_item",
          payload: {
            id: "a2",
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "Shipped." }],
          },
        }),
      ].join("\n"),
    );

    expect(messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "operator", text: "Ship it" },
      { role: "agent", text: "Running tests." },
      { role: "agent", text: "Shipped." },
    ]);
  });

  it("follows Claude and Pi's active message trees and omits tool traffic", () => {
    const claude = parseHerdrSeatTranscript(
      "claude",
      [
        { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "Review it" } },
        {
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          message: { role: "assistant", content: [{ type: "text", text: "Reviewing." }] },
        },
        {
          type: "assistant",
          uuid: "tool",
          parentUuid: "a1",
          message: { role: "assistant", content: [{ type: "tool_use", name: "Read" }] },
        },
        {
          type: "user",
          uuid: "result",
          parentUuid: "tool",
          sourceToolAssistantUUID: "tool",
          message: { role: "user", content: [{ type: "tool_result", content: "secret" }] },
        },
        {
          type: "user",
          uuid: "notification",
          parentUuid: "result",
          promptSource: "system",
          message: { role: "user", content: "<task-notification>worker finished</task-notification>" },
        },
        {
          type: "user",
          uuid: "local-command",
          parentUuid: "notification",
          message: { role: "user", content: "<local-command-stdout>status</local-command-stdout>" },
        },
        {
          type: "user",
          uuid: "slash-command",
          parentUuid: "local-command",
          message: {
            role: "user",
            content: "<command-name>/clear</command-name>\n            <command-message>clear</command-message>",
          },
        },
        {
          type: "assistant",
          uuid: "a2",
          parentUuid: "slash-command",
          message: { role: "assistant", content: [{ type: "text", text: "Looks good." }] },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );
    const pi = parseHerdrSeatTranscript(
      "pi",
      [
        {
          type: "message",
          id: "u1",
          parentId: null,
          message: { role: "user", content: [{ type: "text", text: "Test it" }] },
        },
        {
          type: "message",
          id: "a1",
          parentId: "u1",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "hidden" },
              { type: "text", text: "Green." },
            ],
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );

    expect(claude.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "operator", text: "Review it" },
      { role: "agent", text: "Reviewing." },
      { role: "agent", text: "Looks good." },
    ]);
    expect(pi.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "operator", text: "Test it" },
      { role: "agent", text: "Green." },
    ]);
  });

  it("keeps Grok prompts and assistant text, not injected context or synthetic reminders", () => {
    const messages = parseHerdrSeatTranscript(
      "grok",
      [
        { type: "system", content: "hidden system prompt" },
        { type: "user", content: [{ type: "text", text: "injected context" }] },
        {
          type: "user",
          synthetic_reason: "system_reminder",
          content: [{ type: "text", text: "hidden reminder" }],
        },
        { type: "user", prompt_index: 0, content: [{ type: "text", text: "Fix it" }] },
        { type: "reasoning", summary: "hidden reasoning" },
        { type: "assistant", content: "Working.", tool_calls: [{ name: "shell" }] },
        { type: "tool_result", content: "hidden output" },
        { type: "assistant", content: "Fixed." },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );

    expect(messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "operator", text: "Fix it" },
      { role: "agent", text: "Working." },
      { role: "agent", text: "Fixed." },
    ]);
  });
});

describe("seat reply distillation", () => {
  it("uses only Claude's latest recap line and redacts it", () => {
    expect(
      distillHerdrSeatReply(
        "claude",
        "※ recap: Old reply\nraw tool scrollback\n※ recap: Shipped it with api_key=sk-not-for-chat",
      ),
    ).toBe("Shipped it with [REDACTED]");
  });

  it("extracts Codex's final answer between its response and timing boundaries", () => {
    expect(
      distillHerdrSeatReply(
        "codex",
        [
          "• Earlier progress update",
          "────────────────────────────────",
          "• Tests are green.",
          "  - Added the settled reply projection",
          "  - Kept raw scrollback out",
          "",
          "─ Worked for 2m 4s ───────────────",
          "",
          "› Ask Codex to do anything",
        ].join("\n"),
      ),
    ).toBe("Tests are green.\n- Added the settled reply projection\n- Kept raw scrollback out");
  });

  it("extracts Pi's last OSC 133 message zone without its terminal footer", () => {
    const start = "\u001B]133;A\u0007";
    const end = "\u001B]133;B\u0007\u001B]133;C\u0007";
    expect(
      distillHerdrSeatReply(
        "pi",
        `${end}${start}operator prompt\n${start} Reply line one\n${end} Reply line two\n~/dev/clankie\n12% context`,
      ),
    ).toBe("Reply line one\nReply line two");
  });

  it("fails soft for unknown or unframed harness output", () => {
    expect(distillHerdrSeatReply("gemini", "a complete-looking reply")).toBeUndefined();
    expect(distillHerdrSeatReply("codex", "raw scrollback without a final boundary")).toBeUndefined();
    expect(distillHerdrSeatReply("claude", "⏺ raw Claude scrollback")).toBeUndefined();
  });

  it("bounds a recognized reply to the public conversation limit", () => {
    const reply = distillHerdrSeatReply("claude", `※ recap: ${"x".repeat(20_000)}`);
    expect(reply).toHaveLength(OPERATOR_CONVERSATION_TEXT_MAX);
    expect(reply?.endsWith("…")).toBe(true);
  });
});

it("parses Herdr's agent response", () => {
  expect(
    parseHerdrAgentResult(
      JSON.stringify({
        result: {
          agent: {
            pane_id: "w18:p1",
            terminal_id: "term-potato",
            agent: "claude",
            agent_status: "working",
            terminal_title_stripped: "PStack analysis",
            agent_session: { source: "herdr:claude", kind: "id", value: "session-1" },
          },
        },
      }),
    ),
  ).toEqual({
    ...working,
    session: { source: "herdr:claude", kind: "id", value: "session-1" },
  });
});

it("parses Herdr's foreground agent process", () => {
  expect(
    parseHerdrForegroundProcessId(
      JSON.stringify({
        result: { process_info: { foreground_processes: [{ name: "grok", pid: 73347 }] } },
      }),
    ),
  ).toBe(73347);
});

describe("hiring a seat", () => {
  const hired: HerdrAgentSnapshot = {
    paneId: "w1C:p9",
    terminalId: "term-hired",
    agent: "codex",
    status: "idle",
    title: "Release prep",
  };

  async function storePath(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "clankie-herdr-spawn-"));
    roots.push(root);
    return join(root, "herdr-watches.json");
  }

  it("opens a tab in the directory, starts the harness, and returns the seat", async () => {
    const createTab = vi.fn((_options: { cwd: string; label: string }) => Promise.resolve("w1C:p9"));
    const startAgent = vi.fn(
      (_options: { name: string; kind: string; paneId: string }) => Promise.resolve(),
    );
    const runner: HerdrWatchRunner = {
      get: vi.fn(() => Promise.resolve(hired)),
      resolveTerminal: vi.fn(() => Promise.resolve(hired)),
      wait: vi.fn(() => new Promise<HerdrAgentSnapshot>(() => undefined)),
      createTab,
      startAgent,
    };
    const store = new HerdrWatchStore(await storePath(), { runner });

    const result = await store.spawnSeat({
      schemaVersion: 1,
      harness: "codex",
      title: "Release prep",
      workingDirectory: tmpdir(),
    });

    expect(result).toEqual({
      outcome: "spawned",
      seat: {
        seatId: "term-hired",
        harness: "codex",
        status: "idle",
        title: "Release prep",
        workingDirectory: tmpdir(),
      },
    });
    expect(createTab).toHaveBeenCalledWith({ cwd: tmpdir(), label: "Release prep" });
    expect(startAgent.mock.calls[0]?.[0]).toMatchObject({ kind: "codex", paneId: "w1C:p9" });
    store.close();
  });

  it("names a directory that is not there instead of opening a tab for it", async () => {
    const createTab = vi.fn((_options: { cwd: string; label: string }) => Promise.resolve("w1C:p9"));
    const runner: HerdrWatchRunner = {
      get: vi.fn(() => Promise.resolve(hired)),
      resolveTerminal: vi.fn(() => Promise.resolve(hired)),
      wait: vi.fn(() => new Promise<HerdrAgentSnapshot>(() => undefined)),
      createTab,
      startAgent: vi.fn(() => Promise.resolve()),
    };
    const store = new HerdrWatchStore(await storePath(), { runner });

    const result = await store.spawnSeat({
      schemaVersion: 1,
      harness: "claude",
      title: "Nowhere",
      workingDirectory: join(tmpdir(), "clankie-not-a-real-directory"),
    });

    expect(result).toMatchObject({ outcome: "failed", reason: "unknown_directory" });
    expect(createTab).not.toHaveBeenCalled();
    store.close();
  });

  it("closes the pane it opened when the harness never comes up", async () => {
    const closePane = vi.fn(() => Promise.resolve());
    const runner: HerdrWatchRunner = {
      get: vi.fn(() => Promise.resolve(hired)),
      resolveTerminal: vi.fn(() => Promise.resolve(hired)),
      wait: vi.fn(() => new Promise<HerdrAgentSnapshot>(() => undefined)),
      createTab: vi.fn(() => Promise.resolve("w1C:p9")),
      startAgent: vi.fn(() => Promise.reject(new Error("codex: command not found"))),
      closePane,
    };
    const store = new HerdrWatchStore(await storePath(), { runner });

    const result = await store.spawnSeat({
      schemaVersion: 1,
      harness: "codex",
      title: "Release prep",
      workingDirectory: tmpdir(),
    });

    // A failed hire leaves no empty tab behind for the operator to clean up.
    expect(closePane).toHaveBeenCalledWith("w1C:p9");
    expect(result).toMatchObject({ outcome: "failed", reason: "harness_unavailable" });
    store.close();
  });

  it("makes a herdr-legal agent name out of whatever the operator typed", () => {
    expect(herdrAgentName("Release prep!", "ab12")).toBe("release-prep-ab12");
    expect(herdrAgentName("  ", "ab12")).toBe("agent-ab12");
    // Leading non-letters are illegal in a herdr name, not just unusual.
    expect(herdrAgentName("2026 audit", "ab12")).toBe("audit-ab12");
    expect(herdrAgentName("x".repeat(80), "ab12")).toHaveLength(32);
  });
});
