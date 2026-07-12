import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  compactionContextWindow,
  contextBudget,
  contextPercent,
  shouldCompact,
} from "../lib/session/context-budget.ts";
import { openCaptainSessionLedger } from "../lib/session/ledger.ts";
import { stableProjectId } from "../lib/session/project-identity.ts";
import { normalizeTokenUsage } from "../lib/session/token-usage.ts";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const repoRoot = join(import.meta.dirname, "../../..");
const PROJECT_ID = "a".repeat(40);
const NOW = "2026-07-11T12:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("captain context policy", () => {
  it("reserves min(20k, max output) and triggers at the usable boundary", () => {
    const smallOutput = contextBudget(128_000, 8_192);
    expect(smallOutput).toEqual({ context: 128_000, reserved: 8_192, usable: 119_808 });
    expect(shouldCompact(119_807, smallOutput)).toBe(false);
    expect(shouldCompact(119_808, smallOutput)).toBe(true);
    expect(compactionContextWindow(smallOutput)).toBe(119_807);

    const largeOutput = contextBudget(400_000, 128_000);
    expect(largeOutput).toEqual({ context: 400_000, reserved: 20_000, usable: 380_000 });
    expect(contextPercent(100_000, largeOutput)).toBe(25);
  });

  it("tracks all token axes without inventing missing reasoning usage", () => {
    expect(
      normalizeTokenUsage({
        inputTokens: 120,
        outputTokens: 30,
        reasoningTokens: 12,
        cacheReadTokens: 80,
        cacheWriteTokens: 4,
      }),
    ).toEqual({
      input: 120,
      output: 30,
      reasoning: 12,
      cache: { read: 80, write: 4 },
    });
    expect(normalizeTokenUsage({ inputTokens: 7 })).toEqual({
      input: 7,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    });
  });
});

describe("captain session ledger", () => {
  it("replays exact accounting and compaction state after a process-style reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "captain-ledger-"));
    roots.push(root);
    const path = join(root, "private", "captain.sqlite");
    const budget = contextBudget(400_000, 128_000);
    const ledger = await openCaptainSessionLedger(PROJECT_ID, path);
    await ledger.recordStarted("session-1", "session.started", NOW, "turn-1");
    await ledger.recordTurnStarted("session-1", "turn:turn-1", NOW, "turn-1");
    await ledger.recordModelSelection({
      sessionId: "session-1",
      eventKey: "model:turn-1:0",
      occurredAt: NOW,
      turnId: "turn-1",
      modelRef: "openai-codex/gpt-5.5",
      budget,
    });
    await ledger.recordUsage({
      sessionId: "session-1",
      eventKey: "usage:turn-1:0",
      occurredAt: NOW,
      turnId: "turn-1",
      usage: normalizeTokenUsage({
        inputTokens: 379_999,
        outputTokens: 1_024,
        reasoningTokens: 512,
        cacheReadTokens: 200_000,
        cacheWriteTokens: 256,
      }),
    });
    await ledger.recordCompaction({
      sessionId: "session-1",
      eventKey: "requested:turn-1:4",
      occurredAt: NOW,
      turnId: "turn-1",
      phase: "requested",
      usageInputTokens: 380_000,
    });
    await ledger.recordCompaction({
      sessionId: "session-1",
      eventKey: "completed:turn-1:5",
      occurredAt: NOW,
      turnId: "turn-1",
      phase: "completed",
    });
    await ledger.recordBoundary({
      sessionId: "session-1",
      eventKey: "waiting:turn-1",
      occurredAt: NOW,
      turnId: "turn-1",
      state: "waiting",
    });
    const before = await ledger.snapshot("session-1");
    expect(await ledger.verify()).toEqual({ valid: true, count: 7 });
    ledger.close();

    const reopened = await openCaptainSessionLedger(PROJECT_ID, path);
    expect(await reopened.snapshot("session-1")).toEqual(before);
    expect(before).toMatchObject({
      projectId: PROJECT_ID,
      sessionId: "session-1",
      state: "waiting",
      modelRef: "openai-codex/gpt-5.5",
      budget,
      usage: {
        input: 379_999,
        output: 1_024,
        reasoning: 512,
        cache: { read: 200_000, write: 256 },
      },
      lastInputTokens: 379_999,
      compactions: { requested: 1, completed: 1 },
      lastTurnId: "turn-1",
    });
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    reopened.close();
  });

  it("deduplicates a replayed usage checkpoint and rejects conflicting reuse", async () => {
    const root = await mkdtemp(join(tmpdir(), "captain-ledger-idempotent-"));
    roots.push(root);
    const ledger = await openCaptainSessionLedger(PROJECT_ID, join(root, "captain.sqlite"));
    const checkpoint = {
      sessionId: "session-replay",
      eventKey: "usage:turn-1:0",
      occurredAt: NOW,
      turnId: "turn-1",
      usage: normalizeTokenUsage({ inputTokens: 100, outputTokens: 10 }),
    };
    await ledger.recordUsage(checkpoint);
    await ledger.recordUsage(checkpoint);
    expect((await ledger.snapshot("session-replay"))?.usage).toEqual({
      input: 100,
      output: 10,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    });
    await ledger.recordTurnStarted("session-replay", "turn:turn-2", "2026-07-11T12:01:00.000Z", "turn-2");
    expect((await ledger.snapshot("session-replay"))?.state).toBe("active");
    await expect(
      ledger.recordUsage({
        ...checkpoint,
        usage: normalizeTokenUsage({ inputTokens: 101, outputTokens: 10 }),
      }),
    ).rejects.toThrow("already exists with different content");
    ledger.close();
  });
});

describe("stable project identity", () => {
  it("matches the repository root commit and supports an explicit validated identity", async () => {
    const { stdout } = await execFileAsync("git", ["rev-list", "--max-parents=0", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(await stableProjectId(repoRoot, {})).toBe(stdout.trim());
    expect(await stableProjectId("/not-consulted", { CLANKIE_CAPTAIN_PROJECT_ID: PROJECT_ID })).toBe(
      PROJECT_ID,
    );
    await expect(stableProjectId(repoRoot, { CLANKIE_CAPTAIN_PROJECT_ID: "unsafe/path" })).rejects.toThrow(
      "root-commit hash",
    );
  });
});
