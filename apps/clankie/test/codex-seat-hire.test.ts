import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createCodexSeatAdapter } from "../src/captain/codex-seat-adapter.ts";
import type { CodexSeatEvent } from "../src/captain/codex-app-server.ts";
import { HerdrWatchStore, type HerdrAgentSnapshot } from "../src/captain/herdr-watch.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "codex-hire-test-"));
  let event: (event: CodexSeatEvent) => void = () => undefined;
  const emit = (method: string, turn: Record<string, unknown>) =>
    event({ method, params: { threadId: "thread", turn } });
  const close = vi.fn(async () => undefined);
  const send = vi.fn(async () => {
    emit("turn/started", { id: "turn" });
    return { turnId: "turn", state: "started" as const };
  });
  const adapter = createCodexSeatAdapter({
    start: async (options) => {
      event = options.onEvent!;
      await options.startView(["--remote", "unix:///owned"]);
      return {
        threadId: "thread",
        viewArgs: ["--remote", "unix:///owned", "resume", "thread"],
        send,
        close,
        interrupt: async () => true,
      };
    },
    herdr: async () => undefined,
  });
  // The native TUI can still look idle while the app-server is working.
  const agent: HerdrAgentSnapshot = {
    paneId: "w1:p1",
    terminalId: "term_test",
    agent: "codex",
    status: "idle",
    title: "Test",
    session: { source: "herdr:codex", kind: "id", value: "thread" },
  };
  const promptAgent = vi.fn(async () => undefined);
  const runInPane = vi.fn(async () => undefined);
  const startAgent = vi.fn(async () => undefined);
  const wake = vi.fn(async () => undefined);
  const store = new HerdrWatchStore(join(root, "watches.json"), {
    seatAdapters: [adapter],
    runner: {
      createTab: async () => agent.paneId,
      startAgent,
      get: async () => agent,
      resolveTerminal: async () => agent,
      wait: async () => agent,
      runInPane,
      promptAgent,
      closePane: async () => undefined,
    },
    summariesPath: join(root, "summaries.json"),
  });
  store.start(wake);
  cleanups.push(async () => {
    store.close();
    await (await adapter.attach({ harness: "codex", sessionId: "thread", paneId: agent.paneId }))?.close();
    await rm(root, { recursive: true, force: true });
  });
  const hired = await store.spawnSeat(
    { schemaVersion: 1, harness: "codex", title: "Test", workingDirectory: root },
    undefined,
    "first brief",
  );
  expect(hired.outcome).toBe("spawned");
  return { store, agent, emit, close, send, promptAgent, runInPane, startAgent, wake };
}

it("hires, messages, and waits for Codex protocol completion even while the native view looks idle", async () => {
  const f = await fixture();
  expect(f.send).toHaveBeenCalledWith("first brief");
  expect(f.startAgent).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "codex",
      paneId: "w1:p1",
      args: ["--remote", "unix:///owned"],
    }),
  );
  expect(f.runInPane).not.toHaveBeenCalled();
  expect(await f.store.sendToSeat(f.agent.terminalId, "follow-up")).toBe(true);
  expect(f.send).toHaveBeenLastCalledWith("follow-up");
  expect(f.promptAgent).not.toHaveBeenCalled();
  await f.store.watch("global-default", f.agent.paneId, "harvest protocol completion");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(f.wake).not.toHaveBeenCalled();
  f.emit("turn/completed", {
    id: "turn",
    status: "completed",
    items: [{ type: "agentMessage", text: "protocol final" }],
  });
  await vi.waitFor(() => expect(f.wake).toHaveBeenCalled());
  expect(f.wake.mock.calls.flat().join(" ")).toContain("protocol final");
});

it("closing a hired pane also closes its protocol controller", async () => {
  const f = await fixture();
  expect(await f.store.closeSeat(f.agent.terminalId)).toBe(true);
  expect(f.close).toHaveBeenCalledTimes(1);
});
