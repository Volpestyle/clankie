import type { EmbodimentIntent, EmbodimentSession, EmbodimentSubmitResult } from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import { defaultPlayBudget, startPlay, stopPlay, type PlayPorts } from "../lib/play.ts";

function session(partial: Partial<EmbodimentSession>): EmbodimentSession {
  return {
    schemaVersion: 1,
    sessionId: "session-1",
    environmentId: "pokemon-firered",
    state: "requested",
    intentId: "intent-1",
    originLane: "discord_presence",
    requestedBy: "user-1",
    budget: { maxTurns: 40, maxDurationMs: 60_000 },
    requestedAt: "2026-07-26T12:00:00.000Z",
    updatedAt: "2026-07-26T12:00:01.000Z",
    ...partial,
  };
}

interface FakePortsOptions {
  submit?: EmbodimentSubmitResult;
  /** Successive session reads; the last repeats. */
  reads?: (EmbodimentSession | undefined)[];
  live?: EmbodimentSession;
}

function ports(options: FakePortsOptions) {
  const intents: EmbodimentIntent[] = [];
  const reads = [...(options.reads ?? [])];
  const fake: PlayPorts = {
    submitEmbodimentIntent(intent) {
      intents.push(intent);
      return Promise.resolve(
        options.submit ?? { outcome: "accepted", session: session({ intentId: intent.intentId }) },
      );
    },
    getEmbodimentSession() {
      return Promise.resolve(reads.length > 1 ? reads.shift() : reads[0]);
    },
    getLiveEmbodimentSession() {
      return Promise.resolve(options.live);
    },
  };
  return { fake, intents };
}

const ask = { originLane: "discord_presence", requestedBy: "user-1" } as const;
const fast = { waitMs: 200, pollMs: 5 } as const;

describe("startPlay", () => {
  it("says started only after the runner reports running, with lineage", async () => {
    const { fake, intents } = ports({
      reads: [
        session({ state: "claimed", runnerId: "runner-local" }),
        session({ state: "running", runnerId: "runner-local", resumedFromCheckpointId: "checkpoint-8" }),
      ],
    });
    const note = await startPlay(fake, { environmentId: "pokemon-firered", ...ask, ...fast });
    expect(note).toEqual({
      action: "started",
      sessionId: "session-1",
      environmentId: "pokemon-firered",
      resumedFromCheckpointId: "checkpoint-8",
    });
    expect(intents[0]).toMatchObject({ kind: "start", originLane: "discord_presence" });
  });

  it("relays a control-plane refusal as the typed reason", async () => {
    const { fake } = ports({ submit: { outcome: "refused", reason: "body_held" } });
    const note = await startPlay(fake, { environmentId: "pokemon-firered", ...ask, ...fast });
    expect(note).toEqual({ action: "start_refused", environmentId: "pokemon-firered", reason: "body_held" });
  });

  it("relays a runner-side refusal seen while waiting", async () => {
    const { fake } = ports({
      reads: [session({ state: "refused", refusalReason: "body_held" })],
    });
    const note = await startPlay(fake, { environmentId: "pokemon-firered", ...ask, ...fast });
    expect(note).toEqual({ action: "start_refused", environmentId: "pokemon-firered", reason: "body_held" });
  });

  it("returns pending when the bounded wait elapses, never a false started", async () => {
    const { fake } = ports({ reads: [session({ state: "requested" })] });
    const note = await startPlay(fake, { environmentId: "pokemon-firered", ...ask, ...fast });
    expect(note.action).toBe("pending");
  });
});

describe("stopPlay", () => {
  it("refuses not_playing when nothing is live", async () => {
    const { fake, intents } = ports({});
    const note = await stopPlay(fake, { ...ask, ...fast });
    expect(note).toEqual({ action: "stop_refused", reason: "not_playing" });
    expect(intents).toHaveLength(0);
  });

  it("stops the live session and reports the minted checkpoint", async () => {
    const { fake, intents } = ports({
      live: session({ state: "running", runnerId: "runner-local" }),
      submit: { outcome: "stop_requested", session: session({ state: "running", runnerId: "runner-local" }) },
      reads: [
        session({ state: "stopping", runnerId: "runner-local" }),
        session({ state: "stopped", runnerId: "runner-local", checkpointId: "checkpoint-9" }),
      ],
    });
    const note = await stopPlay(fake, { ...ask, ...fast });
    expect(note).toEqual({ action: "stopped", sessionId: "session-1", checkpointId: "checkpoint-9" });
    expect(intents[0]).toMatchObject({ kind: "stop", sessionId: "session-1" });
  });

  it("returns pending when the stop has not landed inside the wait", async () => {
    const { fake } = ports({
      live: session({ state: "running", runnerId: "runner-local" }),
      submit: { outcome: "stop_requested", session: session({ state: "running", runnerId: "runner-local" }) },
      reads: [session({ state: "running", runnerId: "runner-local" })],
    });
    const note = await stopPlay(fake, { ...ask, ...fast });
    expect(note.action).toBe("pending");
  });
});

describe("defaultPlayBudget", () => {
  it("defaults to no cap and honors env-set bounds", () => {
    // The owner's default: play until asked to stop.
    expect(defaultPlayBudget({})).toEqual({});
    expect(
      defaultPlayBudget({ CLANKIE_PLAY_MAX_TURNS: "12", CLANKIE_PLAY_MAX_DURATION_MS: "60000" }),
    ).toEqual({ maxTurns: 12, maxDurationMs: 60_000 });
    expect(defaultPlayBudget({ CLANKIE_PLAY_MAX_TURNS: "-3" })).toEqual({});
  });
});
