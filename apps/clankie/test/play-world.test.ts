import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbodimentPlayNote, EmbodimentSession, WorldJoinRefusalReason } from "@clankie/protocol";
import type { ActivityFrameSink } from "@clankie/rendered-surface-client";
import { describe, expect, it } from "vitest";
import { joinWorld as askJoinWorld } from "../src/captain/play.ts";
import { createWorldPlayExecution } from "../src/play-execution-world.ts";
import { PlayHost, type EmbodimentAssignment, type EmbodimentLifecycleUpdate } from "../src/play-host.ts";
import { parseFreePlayJournal } from "@clankie/play";
import { fakeIo, fakeWorldBody } from "./world-body-fake.ts";

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

function fakeActivitySink(
  close: () => void,
  sequences?: { frames: number[]; overlays: number[] },
): ActivityFrameSink {
  return {
    publishFrame: (frame) => sequences?.frames.push(frame.sequence),
    publishAudio: () => undefined,
    publishOverlay: (overlay) => sequences?.overlays.push(overlay.sequence),
    publishStatus: () => undefined,
    droppedFrameCount: 0,
    droppedAudioPacketCount: 0,
    connected: false,
    close,
  };
}

function session(): EmbodimentSession {
  return {
    schemaVersion: 1,
    sessionId: "world-play-1",
    environmentId: "pokemon-firered",
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
    CLANKIE_GBA_PLAY_JOURNAL_DIR: join(root, "gba-play"),
    CLANKIE_ACTIVITY_PRODUCER_URL: "ws://127.0.0.1:1/producer",
  };
}

describe("world play execution", () => {
  it("refuses before touching the world when the owner has disabled play", async () => {
    const client = fakeClient({ kind: "start", session: session() });
    const host = new PlayHost({
      client,
      environmentIds: ["pokemon-firered"],
      execute: createWorldPlayExecution({
        logger: silentLogger,
        gameplay: { pokeagentMmoEnabled: false },
      }),
      logger: silentLogger,
    });

    expect(await host.poll()).toBe(true);
    await host.settled();
    expect(client.reports).toEqual([
      expect.objectContaining({ state: "refused", refusalReason: "environment_unavailable" }),
    ]);
  });

  it("runs a world session against a fake body and never takes the local lock", async () => {
    let closed = 0;
    let frame = 0;
    const body = fakeWorldBody({
      framePng: () => new Uint8Array([137, 80, 78, 71, (frame += 1)]),
      close: () => {
        closed += 1;
        return Promise.resolve();
      },
    });
    const client = fakeClient({ kind: "start", session: session() });
    const env = await playEnv();
    const sequences = { frames: [] as number[], overlays: [] as number[] };
    const host = new PlayHost({
      client,
      environmentIds: ["pokemon-firered"],
      execute: createWorldPlayExecution({
        logger: silentLogger,
        env,
        createMind: buttonMasher,
        joinWorld: () => Promise.resolve({ outcome: "joined", body }),
        createActivitySink: () => Promise.resolve(fakeActivitySink(() => undefined, sequences)),
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
    expect(sequences.frames).toEqual([1, 2]);
    expect(sequences.overlays).toEqual([1, 2]);
    expect(closed).toBe(1);
  });

  it("records turns when the hosted world session ends instead of wiping the receipt", async () => {
    let sessionEnded = false;
    const body = fakeWorldBody({
      ended: () => sessionEnded,
      io: {
        ...fakeIo,
        act: () => {
          sessionEnded = true;
          return Promise.resolve({
            schemaVersion: 1,
            actionId: "act-end",
            sessionId: "env-1",
            updatedAt: "2026-07-26T12:00:00.000Z",
            status: "failed",
            acceptedGoalVersion: 1,
            errorCode: "session_ended",
            message: "host restarted",
            retryable: false,
          });
        },
      },
    });
    const client = fakeClient({
      kind: "start",
      session: { ...session(), budget: { maxTurns: 2, maxDurationMs: 60_000 } },
    });
    const env = await playEnv();
    const host = new PlayHost({
      client,
      environmentIds: ["pokemon-firered"],
      execute: createWorldPlayExecution({
        logger: silentLogger,
        env,
        createMind: buttonMasher,
        joinWorld: () => Promise.resolve({ outcome: "joined", body }),
        createActivitySink: () => Promise.resolve(fakeActivitySink(() => undefined)),
      }),
      logger: silentLogger,
    });
    expect(await host.poll()).toBe(true);
    await host.settled();
    expect(client.reports.map((report) => report.state)).toEqual(["running", "stopped"]);
    expect(client.reports[1]?.receipt?.turnsTaken).toBeGreaterThan(0);
  });

  it("restores the game mind from the previous hosted-world sitting", async () => {
    const env = await playEnv();
    const first = fakeClient({
      kind: "start",
      session: { ...session(), budget: { maxTurns: 1 } },
    });
    const firstHost = new PlayHost({
      client: first,
      environmentIds: ["pokemon-firered"],
      execute: createWorldPlayExecution({
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
      ...session(),
      sessionId: "world-play-2",
      intentId: "intent-2",
      budget: { maxTurns: 1 },
    };
    const second = fakeClient({ kind: "start", session: secondSession });
    const secondHost = new PlayHost({
      client: second,
      environmentIds: ["pokemon-firered"],
      execute: createWorldPlayExecution({
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
    const client = fakeClient({ kind: "start", session: session() });
    const host = new PlayHost({
      client,
      environmentIds: ["pokemon-firered"],
      execute: createWorldPlayExecution({
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
      const client = fakeClient({ kind: "start", session: session() });
      const host = new PlayHost({
        client,
        environmentIds: ["pokemon-firered"],
        execute: createWorldPlayExecution({
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

  it("polls an accepted start through the lifecycle without changing its note", async () => {
    const intents: unknown[] = [];
    const accepted = session();
    const running: EmbodimentSession = { ...accepted, state: "running" };
    const note = await askJoinWorld(
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
    expect(intents[0]).not.toHaveProperty("venue");
    expect(note).toEqual({
      action: "joined",
      sessionId: running.sessionId,
      environmentId: running.environmentId,
    });
  });

  it("reports an already-active session as join_refused", async () => {
    const note = await askJoinWorld(
      {
        submitEmbodimentIntent: () => Promise.resolve({ outcome: "refused", reason: "play_session_active" }),
        getEmbodimentSession: () => Promise.resolve(undefined),
        getLiveEmbodimentSession: () => Promise.resolve(undefined),
      },
      { environmentId: "pokemon-firered", originLane: "discord_presence", requestedBy: "user-1" },
    );
    expect(note).toEqual({
      action: "join_refused",
      environmentId: "pokemon-firered",
      reason: "play_session_active",
    });
  });
});
