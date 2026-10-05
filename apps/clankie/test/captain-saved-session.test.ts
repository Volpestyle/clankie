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
  const spawn = vi
    .spyOn(HerdrWatchStore.prototype, "spawnSeat")
    .mockImplementation(async (_seat, _subject, _brief, _resume, _authority, adopt, flushAdoption) => {
      const result = {
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
      } as const;
      adopt?.(result);
      await flushAdoption?.().catch(() => {});
      return result;
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
      conversationId: "global-default",
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
    expect(spawn).toHaveBeenCalledWith(
      seat,
      undefined,
      expect.stringContaining("continue\n\nWorking preferences for this assignment:"),
      session,
      expect.objectContaining({ owner: { conversationId: "global-default" } }),
      expect.any(Function),
      expect.any(Function),
    );
    expect(track).toHaveBeenCalledWith("term_existing");
    for (const bad of [
      { ...seat, harness: "codex" as const },
      { ...seat, workingDirectory: "/other" },
      { ...seat, fleet: "remote" },
    ]) {
      expect(
        await captain.serveOperatorConversation({
          schemaVersion: 1,
          op: "spawn_seat",
          conversationId: "global-default",
          seat: bad,
        }),
      ).toMatchObject({ result: { outcome: "failed", reason: "not_ready" } });
    }
    expect(spawn).toHaveBeenCalledOnce();
  } finally {
    await captain.close();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});

it("passes a human fallback into native hire and preserves the owner rename on a repeated adoption", async () => {
  const root = mkdtempSync(join(tmpdir(), "captain-hire-name-"));
  vi.spyOn(HerdrWatchStore.prototype, "start").mockImplementation(() => {});
  vi.spyOn(HerdrWatchStore.prototype, "trackSeat").mockImplementation(() => {});
  vi.spyOn(census, "readFleet").mockResolvedValue({ seats: [] });
  const spawn = vi
    .spyOn(HerdrWatchStore.prototype, "spawnSeat")
    .mockImplementation(async (request, _subject, _brief, _resume, _authority, adopt, flushAdoption) => {
      const result = {
        outcome: "spawned",
        seat: {
          seatId: "term_worker",
          paneId: "w1:p1",
          subject: "worker",
          occupantId: `session-${"a".repeat(64)}`,
          harness: "codex",
          status: "idle",
          title: request.title,
          workingDirectory: root,
        },
      } as const;
      adopt?.(result);
      await flushAdoption?.().catch(() => {});
      return result;
    });
  const captain = createCaptain({} as CaptainDeps, {
    repoRoot: root,
    stateDir: root,
    settings: new SettingsStore(join(root, "settings.json")),
  });
  try {
    const request = {
      schemaVersion: 1,
      op: "spawn_seat",
      conversationId: "global-default",
      seat: {
        schemaVersion: 1,
        harness: "codex",
        title: "fleet:pc/vuh1381-canary",
        workingDirectory: root,
        role: "builder",
      },
    } as const;
    const first = await captain.serveOperatorConversation(request);
    if (first.op !== "spawn_seat" || first.result.outcome !== "spawned") throw new Error("Expected hire");
    expect(spawn.mock.calls[0]![0].title).toMatch(/^(Ari|Mei|Noor|Ravi|Sora|Zuri)$/u);
    expect(first.result.seat.title).toBe(spawn.mock.calls[0]![0].title);
    const personaId = first.result.seat.personaId!;
    let finishImage!: (png: string) => void;
    const image = new Promise<string>((resolve) => {
      finishImage = resolve;
    });
    const avatarSave = image.then((avatarPngBase64) =>
      captain.serveOperatorConversation({
        schemaVersion: 1,
        op: "update_persona",
        persona: { schemaVersion: 1, personaId, avatarPngBase64 },
      }),
    );
    await captain.serveOperatorConversation({
      schemaVersion: 1,
      op: "update_persona",
      persona: { schemaVersion: 1, personaId, name: "美咲" },
    });
    finishImage(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    );
    const baked = await avatarSave;
    expect(baked).toMatchObject({
      persona: { personaId, name: "美咲", avatarRevision: expect.stringMatching(/^[a-f0-9]{64}$/u) },
    });
    if (baked.op !== "update_persona" || baked.persona.conversationId === undefined)
      throw new Error("Expected persona thread");
    expect(
      await captain.serveOperatorConversation({
        schemaVersion: 1,
        op: "get",
        conversationId: baked.persona.conversationId,
      }),
    ).toMatchObject({ conversation: { title: "美咲" } });
    const again = await captain.serveOperatorConversation(request);
    expect(again).toMatchObject({ result: { seat: { personaId, seatId: "term_worker", title: "美咲" } } });
    const personas = await captain.serveOperatorConversation({ schemaVersion: 1, op: "personas" });
    expect(personas).toMatchObject({
      personas: [expect.objectContaining({ personaId, name: "美咲", role: "builder" })],
    });
  } finally {
    await captain.close();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});
