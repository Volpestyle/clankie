import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPERATOR_CONVERSATION_TEXT_MAX } from "@clankie/protocol";
import {
  distillHerdrSeatReply,
  HerdrWatchStore,
  parseHerdrAgentResult,
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
          },
        },
      }),
    ),
  ).toEqual(working);
});
