import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
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
