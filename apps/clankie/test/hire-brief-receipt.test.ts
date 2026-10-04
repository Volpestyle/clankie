import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { HarnessSeatAdapter, SeatControl } from "@clankie/agent-hosts";
import { HerdrWatchStore, type HerdrAgentSnapshot } from "../src/captain/herdr-watch.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test.each(["claude", "codex", "pi"] as const)(
  "%s refuses a brief without structured control even if a native transcript already contains it",
  async (harness) => {
    const root = await mkdtemp(join(tmpdir(), "hire-receipt-"));
    roots.push(root);
    const brief = `BRIEF_BEGIN\n${"A complete assignment with unicode café and 日本語.\n".repeat(90)}BRIEF_END`;
    const agent: HerdrAgentSnapshot = {
      paneId: "w1:p1",
      terminalId: "term-brief",
      agent: harness,
      status: "working",
      title: "Receipt test",
      session: { source: `herdr:${harness}`, kind: "path", value: "/unused/receipt.jsonl" },
    };
    const runner = {
      createTab: vi.fn(async () => agent.paneId),
      startAgent: vi.fn(async () => undefined),
      runInPane: vi.fn(async () => undefined),
      promptAgent: vi.fn(async () => undefined),
      closePane: vi.fn(async () => undefined),
      get: vi.fn(async () => agent),
      resolveTerminal: vi.fn(async () => agent),
      wait: vi.fn(async () => agent),
      transcript: vi.fn(async () => ({
        sessionKey: "prior-session",
        entries: [{ type: "message" as const, id: "old", role: "operator" as const, text: brief }],
      })),
    };
    const store = new HerdrWatchStore(join(root, "watches.json"), { runner });
    try {
      expect(
        await store.spawnSeat(
          { schemaVersion: 1, harness, title: "Receipt test", workingDirectory: root },
          undefined,
          brief,
        ),
      ).toMatchObject({
        outcome: "failed",
        reason: "harness_unavailable",
        control: { mode: "unavailable", reason: "adapter_unavailable" },
      });
      for (const effect of [
        runner.createTab,
        runner.startAgent,
        runner.runInPane,
        runner.promptAgent,
        runner.closePane,
        runner.transcript,
      ])
        expect(effect).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  },
);

test("a remote Codex hire is briefed and messaged through its fleet's own adapter (VUH-1527)", async () => {
  const root = await mkdtemp(join(tmpdir(), "remote-codex-hire-"));
  roots.push(root);
  const agent: HerdrAgentSnapshot = {
    paneId: "pc/w1:p1",
    terminalId: "pc/term-1",
    agent: "codex",
    status: "idle",
    title: "Remote",
    session: { source: "herdr:codex", kind: "id", value: "thread-1" },
  };
  const sent: string[] = [];
  const control: SeatControl = {
    ref: { harness: "codex", sessionId: "thread-1", paneId: "pc/w1:p1" },
    send: vi.fn(async (message: string) => {
      sent.push(message);
      return { outcome: "accepted" as const, messageId: "turn-2", state: "started" as const };
    }),
    status: async () => "idle",
    settled: async () => ({ type: "turn_completed", at: "now", ok: true }),
    interrupt: async () => false,
    close: async () => undefined,
  };
  const adapter: HarnessSeatAdapter = {
    harness: "codex",
    start: vi.fn(async () => ({ outcome: "started" as const, control })),
    attach: vi.fn(async (ref) =>
      ref.paneId === "pc/w1:p1" && ref.sessionId === "thread-1" ? control : undefined,
    ),
  };
  const remoteSeatAdapters = vi.fn(() => [adapter]);
  const runner = {
    createTab: vi.fn(async () => "pc/w1:p1"),
    startAgent: vi.fn(async () => undefined),
    runInPane: vi.fn(async () => undefined),
    promptAgent: vi.fn(async () => undefined),
    sendText: vi.fn(async () => undefined),
    get: vi.fn(async () => agent),
    resolveTerminal: vi.fn(async () => agent),
    wait: vi.fn(async () => agent),
  };
  const store = new HerdrWatchStore(join(root, "watches.json"), {
    remoteWorkspace: async () => true,
    remoteSeatAdapters,
    runner,
  });
  try {
    expect(
      await store.spawnSeat(
        {
          schemaVersion: 1,
          harness: "codex",
          title: "Remote",
          workingDirectory: "C:\\src\\app",
          fleet: "pc",
        },
        undefined,
        "Do the work",
      ),
    ).toMatchObject({ outcome: "spawned", control: { mode: "adapter" } });
    expect(remoteSeatAdapters).toHaveBeenCalledWith("pc");
    expect(adapter.start).toHaveBeenCalledWith(
      expect.objectContaining({ harness: "codex", cwd: "C:\\src\\app", brief: "Do the work" }),
      expect.objectContaining({ paneId: "pc/w1:p1" }),
    );
    expect(await store.deliverToSeat("pc/term-1", "Next step")).toMatchObject({ outcome: "delivered" });
    expect(sent).toEqual(["Next step"]);
    // Nothing reached the remote terminal as typed input.
    expect(runner.promptAgent).not.toHaveBeenCalled();
    expect(runner.sendText).not.toHaveBeenCalled();
    // A harness the fleet has no adapter for still refuses its brief.
    expect(
      await store.spawnSeat(
        {
          schemaVersion: 1,
          harness: "claude",
          title: "Remote",
          workingDirectory: "C:\\src\\app",
          fleet: "pc",
        },
        undefined,
        "Do the work",
      ),
    ).toMatchObject({ outcome: "failed", control: { mode: "unavailable", reason: "remote_fleet" } });
  } finally {
    store.close();
  }
});

test("a granted remote workspace does not authorize terminal brief injection", async () => {
  const createTab = vi.fn(async () => "pc/w1:p1");
  const promptAgent = vi.fn(async () => undefined);
  const terminalInput = { promptAgent };
  const store = new HerdrWatchStore(join(tmpdir(), "remote-brief-safety.json"), {
    remoteWorkspace: async () => true,
    runner: {
      createTab,
      startAgent: vi.fn(async () => undefined),
      ...terminalInput,
      get: vi.fn(),
      resolveTerminal: vi.fn(),
      wait: vi.fn(),
    },
  });
  try {
    expect(
      await store.spawnSeat(
        { schemaVersion: 1, harness: "claude", title: "Remote", workingDirectory: "/remote", fleet: "pc" },
        undefined,
        "assignment",
      ),
    ).toMatchObject({
      outcome: "failed",
      reason: "harness_unavailable",
      control: { mode: "unavailable", reason: "remote_fleet" },
    });
    expect(createTab).not.toHaveBeenCalled();
    expect(promptAgent).not.toHaveBeenCalled();
  } finally {
    store.close();
  }
});

test("a removed/re-added fleet ID cannot reuse an adapter bound to its old target", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleet-adapter-revision-"));
  roots.push(root);
  let revision = 1;
  let target = "old-host";
  const delivered: string[] = [];
  const close = vi.fn(async () => {});
  const remoteSeatAdapters = vi.fn((): HarnessSeatAdapter[] => {
    const bound = target;
    const control: SeatControl = {
      ref: { harness: "codex", sessionId: "thread", paneId: "pc/w1:p1" },
      send: async () => {
        delivered.push(bound);
        return { outcome: "accepted", state: "started", messageId: bound };
      },
      status: async () => "idle",
      settled: async () => ({ type: "turn_completed", at: "now", ok: true }),
      interrupt: async () => false,
      close,
    };
    return [
      { harness: "codex", start: async () => ({ outcome: "started", control }), attach: async () => control },
    ];
  });
  const agent: HerdrAgentSnapshot = {
    paneId: "pc/w1:p1",
    terminalId: "pc/term",
    agent: "codex",
    status: "idle",
    title: "worker",
    session: { source: "herdr:codex", kind: "id", value: "thread" },
  };
  const store = new HerdrWatchStore(join(root, "watches.json"), {
    remoteSeatAdapters,
    fleetRevision: () => revision,
    runner: { get: async () => agent, resolveTerminal: async () => agent, wait: async () => agent },
  });
  try {
    expect(await store.deliverToSeat("pc/term", "first")).toMatchObject({ outcome: "delivered" });
    // No message/access occurs in the disconnected gap; the revision still invalidates the cache.
    revision += 2;
    target = "new-host";
    expect(await store.deliverToSeat("pc/term", "second")).toMatchObject({ outcome: "delivered" });
    expect(delivered).toEqual(["old-host", "new-host"]);
    expect(remoteSeatAdapters).toHaveBeenCalledTimes(2);
    expect(close).not.toHaveBeenCalled();
  } finally {
    store.close();
  }
});
