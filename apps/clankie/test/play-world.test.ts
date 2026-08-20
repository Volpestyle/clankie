import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GbaDriverIo } from "@clankie/gba-emulator";
import type { EmbodimentPlayNote, EmbodimentSession, WorldJoinRefusalReason } from "@clankie/protocol";
import { embodimentVenue } from "@clankie/protocol";
import type { ActivityFrameSink } from "@clankie/rendered-surface-client";
import { describe, expect, it } from "vitest";
import { joinWorld as askJoinWorld, startPlay } from "../src/captain/play.ts";
import { createGbaPlayExecution } from "../src/play-execution.ts";
import { PlayHost, type EmbodimentAssignment, type EmbodimentLifecycleUpdate } from "../src/play-host.ts";
import { parseFreePlayJournal } from "@clankie/gba-emulator";
import type { WorldBody } from "../src/world/body.ts";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const buttonMasher = () =>
  Promise.resolve({
    decide: () =>
      Promise.resolve({
        monologue: "pressing on",
        intent: "press a",
        action: { kind: "button_press" as const, button: "a" as const, holdFrames: 2 },
      }),
  });

const fakeIo: GbaDriverIo = {
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

function fakeWorldBody(overrides: Partial<WorldBody> = {}): WorldBody {
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
    ...overrides,
  };
}

function fakeActivitySink(close: () => void): ActivityFrameSink {
  return {
    publishFrame: () => undefined,
    publishAudio: () => undefined,
    publishOverlay: () => undefined,
    publishStatus: () => undefined,
    droppedFrameCount: 0,
    droppedAudioPacketCount: 0,
    connected: false,
    close,
  };
}

function session(venue?: "local" | "world"): EmbodimentSession {
  return {
    schemaVersion: 1,
    sessionId: "world-play-1",
    environmentId: "pokemon-firered",
    ...(venue === undefined ? {} : { venue }),
    state: "claimed",
    intentId: "intent-1",
    originLane: "discord_presence",
    requestedBy: "user-1",
    budget: { maxTurns: 2, maxDurationMs: 60_000 },
    requestedAt: "2026-07-26T12:00:00.000Z",
    updatedAt: "2026-07-26T12:00:01.000Z",
  };
}

function fakeClient(assignment: EmbodimentAssignment) {
  const assignments = [assignment];
  const reports: EmbodimentLifecycleUpdate[] = [];
  return {
    reports,
    claimEmbodiment(): Promise<EmbodimentAssignment | undefined> {
      return Promise.resolve(assignments.shift());
    },
    reportEmbodiment(report: EmbodimentLifecycleUpdate): Promise<unknown> {
      reports.push(report);
      return Promise.resolve({});
    },
    getLiveEmbodimentSession(): Promise<EmbodimentSession | undefined> {
      return Promise.resolve(undefined);
    },
  };
}

async function playEnv(): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(join(tmpdir(), "clankie-play-world-"));
  return {
    XDG_STATE_HOME: join(root, "state"),
    CLANKIE_GBA_CHECKPOINT_DIR: join(root, "checkpoints"),
    CLANKIE_GBA_PLAY_JOURNAL_DIR: join(root, "gba-play"),
    CLANKIE_ACTIVITY_PRODUCER_URL: "ws://127.0.0.1:1/producer",
  };
}

describe("world play execution", () => {
  it("refuses each disabled play venue before touching its body", async () => {
    for (const venue of [undefined, "world"] as const) {
      const client = fakeClient({ kind: "start", session: session(venue) });
      const host = new PlayHost({
        client,
        environmentIds: ["pokemon-firered"],
        execute: createGbaPlayExecution({
          logger: silentLogger,
          gameplay: {
            pokemonEmulatorEnabled: venue === "world",
            pokeagentMmoEnabled: venue !== "world",
          },
        }),
        logger: silentLogger,
      });

      expect(await host.poll()).toBe(true);
      await host.settled();
      expect(client.reports).toEqual([
        expect.objectContaining({ state: "refused", refusalReason: "environment_unavailable" }),
      ]);
    }
  });

  it("runs a world session against a fake body and never takes the local lock", async () => {
    let closed = 0;
    const body = fakeWorldBody({
      close: () => {
        closed += 1;
        return Promise.resolve();
      },
    });
    const client = fakeClient({ kind: "start", session: session("world") });
    const env = await playEnv();
    const host = new PlayHost({
      client,
      environmentIds: ["pokemon-firered"],
      execute: createGbaPlayExecution({
        logger: silentLogger,
        env,
        createMind: buttonMasher,
        joinWorld: () => Promise.resolve({ outcome: "joined", body }),
      }),
      logger: silentLogger,
    });
    expect(await host.poll()).toBe(true);
    await host.settled();
    expect(client.reports.map((report) => report.state)).toEqual(["running", "stopped"]);
    expect(client.reports[1]?.receipt?.turnsTaken).toBe(2);
    const journalDir = env["CLANKIE_GBA_PLAY_JOURNAL_DIR"] as string;
    const journalFile = readdirSync(journalDir).find((name) => name.endsWith(".jsonl")) as string;
    const lines = parseFreePlayJournal(readFileSync(join(journalDir, journalFile), "utf8"));
    expect(lines[0]).toMatchObject({
      schemaVersion: 3,
      journeyId: body.journeyId,
      environmentId: "pokemon-firered",
      venue: "world",
    });
    expect(lines[1]).toMatchObject({
      schemaVersion: 2,
      evidence: {
        decision: {
          provenance: {
            body: "world",
            bodyGeneration: 1,
            adapterVersion: 2,
          },
        },
        actionResult: { source: "environment", result: { status: "completed" } },
      },
    });
    expect(closed).toBe(1);
  });

  it("restores the game mind from the previous hosted-world sitting", async () => {
    const env = await playEnv();
    const first = fakeClient({
      kind: "start",
      session: { ...session("world"), budget: { maxTurns: 1 } },
    });
    const firstHost = new PlayHost({
      client: first,
      environmentIds: ["pokemon-firered"],
      execute: createGbaPlayExecution({
        logger: silentLogger,
        env,
        createMind: () =>
          Promise.resolve({
            decide: () =>
              Promise.resolve({
                monologue: "remembering the route",
                intent: "press a",
                notes: "the Mart clerk has Oak's Parcel",
                objective: "return to Oak",
                action: { kind: "button_press" as const, button: "a" as const, holdFrames: 2 },
              }),
          }),
        joinWorld: () => Promise.resolve({ outcome: "joined", body: fakeWorldBody() }),
      }),
      logger: silentLogger,
    });
    await firstHost.poll();
    await firstHost.settled();

    const seen: { notes: string | null; objective: string | null }[] = [];
    const secondSession = {
      ...session("world"),
      sessionId: "world-play-2",
      intentId: "intent-2",
      budget: { maxTurns: 1 },
    };
    const second = fakeClient({ kind: "start", session: secondSession });
    const secondHost = new PlayHost({
      client: second,
      environmentIds: ["pokemon-firered"],
      execute: createGbaPlayExecution({
        logger: silentLogger,
        env,
        createMind: () =>
          Promise.resolve({
            decide: (view) => {
              seen.push({ notes: view.notes, objective: view.objective });
              return Promise.resolve({
                monologue: "continuing",
                intent: "press a",
                action: { kind: "button_press" as const, button: "a" as const, holdFrames: 2 },
              });
            },
          }),
        joinWorld: () => Promise.resolve({ outcome: "joined", body: fakeWorldBody() }),
      }),
      logger: silentLogger,
    });
    await secondHost.poll();
    await secondHost.settled();

    expect(seen[0]).toEqual({
      notes: "the Mart clerk has Oak's Parcel",
      objective: "return to Oak",
    });
  });

  it("releases the hosted seat, listeners, and activity sink when voice client creation throws", async () => {
    let bodyClosed = 0;
    let sinkClosed = 0;
    const observers: Array<(() => void) | null> = [];
    const body = fakeWorldBody({
      observeFrames: (observer) => observers.push(observer),
      close: () => {
        bodyClosed += 1;
        return Promise.resolve();
      },
    });
    const client = fakeClient({ kind: "start", session: session("world") });
    const host = new PlayHost({
      client,
      environmentIds: ["pokemon-firered"],
      execute: createGbaPlayExecution({
        logger: silentLogger,
        env: await playEnv(),
        createMind: buttonMasher,
        joinWorld: () => Promise.resolve({ outcome: "joined", body }),
        createActivitySink: () => Promise.resolve(fakeActivitySink(() => (sinkClosed += 1))),
        createVoice: () => Promise.reject(new Error("play voice client failed")),
      }),
      logger: silentLogger,
    });

    await host.poll();
    await host.settled();

    expect(client.reports).toEqual([expect.objectContaining({ state: "failed" })]);
    expect(observers).toEqual([null]);
    expect(sinkClosed).toBe(1);
    expect(bodyClosed).toBe(1);
  });

  it("refuses each world-join reason without starting a local body", async () => {
    const reasons: WorldJoinRefusalReason[] = [
      "play_session_active",
      "no_credential",
      "world_unreachable",
      "world_refused",
      "region_not_hosted",
      "world_full",
    ];
    for (const reason of reasons) {
      const client = fakeClient({ kind: "start", session: session("world") });
      const host = new PlayHost({
        client,
        environmentIds: ["pokemon-firered"],
        execute: createGbaPlayExecution({
          logger: silentLogger,
          env: await playEnv(),
          createMind: buttonMasher,
          joinWorld: () => Promise.resolve({ outcome: "refused", reason }),
        }),
        logger: silentLogger,
      });
      expect(await host.poll()).toBe(true);
      await host.settled();
      expect(client.reports).toEqual([expect.objectContaining({ state: "refused", refusalReason: reason })]);
    }
  });

  it("treats an omitted venue as local — the existing pokeagent_start_solo path", () => {
    expect(embodimentVenue(session())).toBe("local");
    expect(embodimentVenue(session("world"))).toBe("world");
  });
});

describe("joinWorld captain ask", () => {
  it("submits a world venue and maps each join refusal onto join_refused", async () => {
    const reasons: WorldJoinRefusalReason[] = [
      "play_session_active",
      "no_credential",
      "world_unreachable",
      "world_refused",
      "region_not_hosted",
      "world_full",
    ];
    for (const reason of reasons) {
      const note = await askJoinWorld(
        {
          submitEmbodimentIntent: () => Promise.resolve({ outcome: "refused", reason }),
          getEmbodimentSession: () => Promise.resolve(undefined),
          getLiveEmbodimentSession: () => Promise.resolve(undefined),
        },
        { environmentId: "pokemon-firered", originLane: "discord_presence", requestedBy: "user-1" },
      );
      expect(note).toEqual({
        action: "join_refused",
        environmentId: "pokemon-firered",
        reason,
      } satisfies EmbodimentPlayNote);
    }
  });

  it("polls accepted local and world starts through the same lifecycle without changing their notes", async () => {
    for (const candidate of [
      { ask: startPlay, venue: undefined, action: "started" },
      { ask: askJoinWorld, venue: "world", action: "joined" },
    ] as const) {
      const intents: unknown[] = [];
      const accepted = session(candidate.venue);
      const running: EmbodimentSession = {
        ...accepted,
        state: "running",
        resumedFromCheckpointId: "checkpoint-8",
      };
      const note = await candidate.ask(
        {
          submitEmbodimentIntent: (intent) => {
            intents.push(intent);
            return Promise.resolve({ outcome: "accepted", session: accepted });
          },
          getEmbodimentSession: () => Promise.resolve(running),
          getLiveEmbodimentSession: () => Promise.resolve(running),
        },
        { environmentId: "pokemon-firered", originLane: "discord_presence", requestedBy: "user-1" },
      );
      if (candidate.venue === undefined) expect(intents[0]).not.toHaveProperty("venue");
      else expect(intents[0]).toMatchObject({ venue: candidate.venue });
      expect(note).toEqual(
        candidate.action === "joined"
          ? { action: "joined", sessionId: running.sessionId, environmentId: running.environmentId }
          : {
              action: "started",
              sessionId: running.sessionId,
              environmentId: running.environmentId,
              resumedFromCheckpointId: "checkpoint-8",
            },
      );
    }
  });

  it("leaves pokeagent_start_solo's intent local and reports an active local session", async () => {
    const intents: unknown[] = [];
    const note = await startPlay(
      {
        submitEmbodimentIntent: (intent) => {
          intents.push(intent);
          return Promise.resolve({ outcome: "refused", reason: "play_session_active" });
        },
        getEmbodimentSession: () => Promise.resolve(undefined),
        getLiveEmbodimentSession: () => Promise.resolve(undefined),
      },
      { environmentId: "pokemon-firered", originLane: "discord_presence", requestedBy: "user-1" },
    );
    expect(intents).toEqual([expect.objectContaining({ kind: "start", environmentId: "pokemon-firered" })]);
    expect(intents[0]).not.toHaveProperty("venue");
    expect(note).toEqual({
      action: "start_refused",
      environmentId: "pokemon-firered",
      reason: "play_session_active",
    });
  });
});
