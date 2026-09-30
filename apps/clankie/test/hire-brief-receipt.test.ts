import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  HerdrWatchStore,
  type HerdrAgentSnapshot,
  type HerdrWatchRunner,
} from "../src/captain/herdr-watch.ts";

const brief = `BRIEF_BEGIN\n${"A complete assignment with unicode café and 日本語.\n".repeat(90)}BRIEF_END`;
const request = {
  schemaVersion: 1 as const,
  harness: "claude" as const,
  title: "Receipt test",
  workingDirectory: tmpdir(),
};

let accountHome: string;
beforeEach(() => {
  accountHome = mkdtempSync(join(tmpdir(), "hire-receipt-account-"));
  writeFileSync(join(accountHome, "auth.json"), "synthetic presence only");
  vi.stubEnv("CODEX_HOME", accountHome);
  vi.stubEnv("CLANKIE_SETTINGS_FILE", join(accountHome, "settings.json"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(accountHome, { recursive: true, force: true });
});
vi.mock("../../../packages/settings/src/codex-rate-limits.ts", () => ({
  readCodexRateLimits: vi.fn(async () => null),
}));

function fixture(harness = "claude") {
  const agent: HerdrAgentSnapshot = {
    paneId: "w1:p1",
    terminalId: "term-brief",
    agent: harness,
    status: "working",
    title: "Receipt test",
    session: { source: `herdr:${harness}`, kind: "path", value: "/unused/receipt.jsonl" },
  };
  const runner: HerdrWatchRunner = {
    createTab: vi.fn(async () => agent.paneId),
    startAgent: vi.fn(async () => undefined),
    promptAgent: vi.fn(async () => undefined),
    closePane: vi.fn(async () => undefined),
    get: vi.fn(async () => agent),
    resolveTerminal: vi.fn(async () => agent),
    wait: vi.fn(async () => agent),
    transcript: vi.fn(async () => ({
      sessionKey: "fresh",
      entries: [{ type: "message" as const, id: "receipt", role: "operator" as const, text: brief }],
    })),
  };
  const store = new HerdrWatchStore(join(tmpdir(), "unused-brief-receipt-watch.json"), { runner });
  return { runner, store };
}

test.each(["claude", "codex"] as const)(
  "%s reports a long brief delivered only after its complete transcript receipt",
  async (harness) => {
    vi.useFakeTimers();
    const { runner, store } = fixture(harness);
    let ready!: () => void;
    vi.mocked(runner.startAgent!).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          ready = resolve;
        }),
    );
    vi.mocked(runner.transcript!).mockResolvedValueOnce(undefined);
    const pending = store.spawnSeat({ ...request, harness }, undefined, brief);
    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(runner.promptAgent).not.toHaveBeenCalled();
      ready();
      await vi.advanceTimersByTimeAsync(1000);
      expect(await pending).toMatchObject({ outcome: "spawned" });
      expect(runner.promptAgent).toHaveBeenCalledExactlyOnceWith("w1:p1", brief);
      expect(runner.transcript).toHaveBeenCalledTimes(2);
      expect(runner.closePane).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  },
);

test.each(["tail only", "prefix only", "no transcript", "assistant echo"])(
  "%s never becomes a delivered hire",
  async (mode) => {
    vi.useFakeTimers();
    const { runner, store } = fixture();
    vi.mocked(runner.transcript!).mockResolvedValue(
      mode === "no transcript"
        ? undefined
        : {
            sessionKey: "fresh",
            entries: [
              {
                type: "message",
                id: "receipt",
                role: mode === "assistant echo" ? "agent" : "operator",
                text:
                  mode === "tail only"
                    ? brief.slice(4096)
                    : mode === "prefix only"
                      ? brief.slice(0, -20)
                      : brief,
              },
            ],
          },
    );
    try {
      const pending = store.spawnSeat(request, undefined, brief);
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await pending).toMatchObject({
        outcome: "failed",
        reason: "not_ready",
        detail: expect.stringContaining("brief_delivery_unverified"),
      });
      expect(runner.promptAgent).toHaveBeenCalledTimes(1);
      expect(runner.closePane).toHaveBeenCalledExactlyOnceWith("w1:p1");
    } finally {
      store.close();
    }
  },
);

test("a blocked startup gets no brief and only its own pane is closed", async () => {
  const { runner, store } = fixture();
  vi.mocked(runner.startAgent!).mockRejectedValue(new Error("agent_not_ready: blocked"));
  try {
    expect(await store.spawnSeat(request, undefined, brief)).toMatchObject({
      outcome: "failed",
      reason: "not_ready",
    });
    expect(runner.promptAgent).not.toHaveBeenCalled();
    expect(runner.closePane).toHaveBeenCalledExactlyOnceWith("w1:p1");
  } finally {
    store.close();
  }
});

test("Claude's native long-paste envelope is a complete receipt", async () => {
  const { runner, store } = fixture();
  vi.mocked(runner.transcript!).mockResolvedValue({
    sessionKey: "fresh",
    entries: [
      {
        type: "message",
        id: "receipt",
        role: "operator",
        text: `<pasted_content id="8c89">\n${brief}\n</pasted_content id="8c89">`,
      },
    ],
  });
  try {
    expect(await store.spawnSeat(request, undefined, brief)).toMatchObject({ outcome: "spawned" });
  } finally {
    store.close();
  }
});

test("Codex's folder-trust screen is not input readiness even when Herdr calls it ready", async () => {
  const { runner, store } = fixture("codex");
  runner.read = vi.fn(async () => "Trust this folder?\n› 1. Trust and continue\n  2. Quit");
  try {
    expect(await store.spawnSeat({ ...request, harness: "codex" }, undefined, brief)).toMatchObject({
      outcome: "failed",
      reason: "not_ready",
      detail: expect.stringContaining("folder trust"),
    });
    expect(runner.promptAgent).not.toHaveBeenCalled();
    expect(runner.closePane).toHaveBeenCalledExactlyOnceWith("w1:p1");
  } finally {
    store.close();
  }
});
