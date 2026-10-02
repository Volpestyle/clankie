import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
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

test("a granted remote workspace does not authorize terminal brief injection", async () => {
  const createTab = vi.fn(async () => "pc/w1:p1");
  const promptAgent = vi.fn(async () => undefined);
  const store = new HerdrWatchStore(join(tmpdir(), "remote-brief-safety.json"), {
    remoteWorkspace: async () => true,
    runner: {
      createTab,
      startAgent: vi.fn(async () => undefined),
      promptAgent,
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
