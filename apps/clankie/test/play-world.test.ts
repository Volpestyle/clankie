import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GbaDriverIo } from "@clankie/gba-emulator";
import type {
  EmbodimentAssignment,
  EmbodimentClaim,
  EmbodimentLifecycleReport,
  EmbodimentPlayNote,
  EmbodimentSession,
  WorldJoinRefusalReason,
} from "@clankie/protocol";
import { embodimentVenue } from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import { joinWorld as askJoinWorld, startPlay } from "../src/captain/play.ts";
import { createGbaPlayExecution } from "../src/play-execution.ts";
import { PlayHost } from "../src/play-host.ts";
import { SessionStatusSchema, WhoResultSchema } from "@pokeagent-mmo/world-protocol";
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
    io: fakeIo,
    framePng: () => frame,
    observeFrames: () => undefined,
    droppedFrameCount: () => 0,
    session: () =>
      Promise.resolve(
        SessionStatusSchema.parse({
          ok: true,
          worldId: "kanto",
          playerId: "player-1",
          sessionId: "world-session-1",
          gameId: "firered",
          displayName: "clankie",
          state: "playing",
          bodyGeneration: 1,
          frame: 1,
          startedAt: "2026-07-26T12:00:00.000Z",
        }),
      ),
    who: () => Promise.resolve(WhoResultSchema.parse({ ok: true, worldId: "kanto", players: [] })),
    close: () => Promise.resolve(),
    ...overrides,
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
    runnerId: "runner-local",
  };
}

function fakeClient(assignment: EmbodimentAssignment) {
  const assignments = [assignment];
  const reports: EmbodimentLifecycleReport[] = [];
  return {
    reports,
    claimEmbodiment(_claim: EmbodimentClaim): Promise<EmbodimentAssignment | undefined> {
      return Promise.resolve(assignments.shift());
    },
    reportEmbodiment(report: EmbodimentLifecycleReport): Promise<unknown> {
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
    CLANKIE_GBA_BODY_ROOT: join(root, "body"),
    CLANKIE_GBA_CHECKPOINT_DIR: join(root, "checkpoints"),
    CLANKIE_GBA_PLAY_JOURNAL_DIR: join(root, "gba-play"),
    CLANKIE_ACTIVITY_PRODUCER_URL: "ws://127.0.0.1:1/producer",
  };
}

describe("world play execution", () => {
  it("runs a world session against a fake body and never takes the local lock", async () => {
    let closed = 0;
    const body = fakeWorldBody({
      close: () => {
        closed += 1;
        return Promise.resolve();
      },
    });
    const client = fakeClient({ kind: "start", session: session("world") });
    const host = new PlayHost({
      client,
      runnerId: "runner-local",
      environmentIds: ["pokemon-firered"],
      execute: createGbaPlayExecution({
        logger: silentLogger,
        env: await playEnv(),
        createMind: buttonMasher,
        joinWorld: () => Promise.resolve({ outcome: "joined", body }),
      }),
      logger: silentLogger,
    });
    expect(await host.poll()).toBe(true);
    await host.settled();
    expect(client.reports.map((report) => report.state)).toEqual(["running", "stopped"]);
    expect(client.reports[1]?.receipt?.turnsTaken).toBe(2);
    expect(closed).toBe(1);
  });

  it("refuses each world-join reason without starting a local body", async () => {
    const reasons: WorldJoinRefusalReason[] = [
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
        runnerId: "runner-local",
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

  it("treats an omitted venue as local — the existing start_play path", () => {
    expect(embodimentVenue(session())).toBe("local");
    expect(embodimentVenue(session("world"))).toBe("world");
  });
});

describe("joinWorld captain ask", () => {
  it("submits a world venue and maps each join refusal onto join_refused", async () => {
    const reasons: WorldJoinRefusalReason[] = [
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

  it("leaves start_play's intent local and its refusal vocabulary intact", async () => {
    const intents: unknown[] = [];
    const note = await startPlay(
      {
        submitEmbodimentIntent: (intent) => {
          intents.push(intent);
          return Promise.resolve({ outcome: "refused", reason: "body_held" });
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
      reason: "body_held",
    });
  });
});
