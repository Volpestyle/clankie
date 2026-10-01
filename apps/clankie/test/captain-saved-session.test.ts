import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import type { SavedAgentSession } from "../src/agent-sessions.ts";
import { HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import * as census from "../src/captain/herdr-census.ts";

it("native continuation goes through one hire/adoption path and preserves the existing seat identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "captain-native-resume-"));
  const session: SavedAgentSession = {
    ref: "local:10000000-0000-4000-8000-000000000001",
    host: "local",
    sessionId: "10000000-0000-4000-8000-000000000001",
    workingDirectory: root,
    file: { harness: "claude", path: join(root, "history.jsonl"), size: 1, mtimeMs: 1 },
  };
  vi.spyOn(HerdrWatchStore.prototype, "start").mockImplementation(() => {});
  const track = vi.spyOn(HerdrWatchStore.prototype, "trackSeat").mockImplementation(() => {});
  vi.spyOn(census, "readFleet").mockResolvedValue({ seats: [] });
  const spawn = vi.spyOn(HerdrWatchStore.prototype, "spawnSeat").mockResolvedValue({
    outcome: "spawned",
    seat: {
      seatId: "term_existing",
      paneId: "w1:p1",
      subject: "original-worker",
      occupantId: session.sessionId,
      harness: "claude",
      status: "idle",
      title: "Original worker",
      workingDirectory: root,
    },
  });
  const resolve = vi.fn(async () => session);
  const captain = createCaptain(
    {
      ...({} as CaptainDeps),
      agentSessions: {
        list: async () => ({ sessions: [], errors: [] }),
        read: async () => {
          throw new Error("must not import history");
        },
        resolve,
      },
    },
    {
      repoRoot: root,
      stateDir: root,
      settings: new SettingsStore(join(root, "settings.json")),
    },
  );
  try {
    const seat = {
      schemaVersion: 1 as const,
      harness: "claude" as const,
      title: "Resume claude",
      workingDirectory: root,
      resume: session.ref,
    };
    const result = await captain.serveOperatorConversation({
      schemaVersion: 1,
      op: "spawn_seat",
      seat,
      brief: "continue",
    });
    expect(result).toMatchObject({
      op: "spawn_seat",
      result: {
        outcome: "spawned",
        seat: { seatId: "term_existing", occupantId: session.sessionId, title: "Original worker" },
      },
    });
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith(seat, undefined, "continue", session);
    expect(track).toHaveBeenCalledWith("term_existing");
    for (const bad of [
      { ...seat, harness: "codex" as const },
      { ...seat, workingDirectory: "/other" },
      { ...seat, fleet: "remote" },
    ]) {
      expect(
        await captain.serveOperatorConversation({ schemaVersion: 1, op: "spawn_seat", seat: bad }),
      ).toMatchObject({ result: { outcome: "failed", reason: "not_ready" } });
    }
    expect(spawn).toHaveBeenCalledOnce();
  } finally {
    await captain.close();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});
