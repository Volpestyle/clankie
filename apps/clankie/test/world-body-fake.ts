/** A hosted world body that answers without a world, shared by the play tests. */
import type { GbaDriverIo } from "@clankie/play";
import type { WorldBody } from "../src/world/body.ts";

export const fakeIo: GbaDriverIo = {
  observe: () => {
    throw new Error("no observation");
  },
  act: () =>
    Promise.resolve({
      schemaVersion: 1,
      actionId: "act-1",
      sessionId: "env-1",
      updatedAt: "2026-07-26T12:00:00.000Z",
      status: "completed",
      acceptedGoalVersion: 1,
      outcome: {},
    }),
  pause: () => Promise.resolve(),
  resume: () => Promise.resolve(),
};

export function fakeWorldBody(overrides: Partial<WorldBody> = {}): WorldBody {
  const frame = new Uint8Array([137, 80, 78, 71]);
  return {
    journeyId: "world:kanto:player:player-1",
    io: fakeIo,
    framePng: () => frame,
    observeFrames: () => undefined,
    droppedFrameCount: () => 0,
    drainAudio: () => [],
    droppedAudioPacketCount: () => 0,
    traceProvenance: () => ({
      body: "world",
      sessionId: "world-session-1",
      worldId: "kanto",
      bodyGeneration: 1,
      adapterVersion: 2,
    }),
    close: () => Promise.resolve(),
    sessionSnapshot: () => ({
      worldId: "kanto",
      playerId: "player-1",
      sessionId: "world-session-1",
      gameId: "firered",
    }),
    grantedOperationNames: () => ["play.observe", "play.act", "play.frame"],
    callWorld: () => Promise.resolve({ ok: false, code: "not_supported", message: "fake" }),
    ended: () => false,
    ...overrides,
  };
}
