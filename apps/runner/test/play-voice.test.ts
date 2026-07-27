import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EmbodimentAssignment,
  EmbodimentClaim,
  EmbodimentLifecycleReport,
  EmbodimentSession,
} from "@clankie/protocol";
import type { PossessorVoiceClient } from "@clankie/possessor-voice";
import { describe, expect, it } from "vitest";
import { createGbaPlayExecution } from "../src/play-execution.ts";
import { PlayHost } from "../src/play-host.ts";

/**
 * Asked play speaks and hears through the possessor seam (ADR 0067).
 *
 * The seam itself is proven in `@clankie/possessor-voice`; what is under test
 * here is the wiring: that his own words leave the playthrough, that the room's
 * words reach it, and that neither is load-bearing for play continuing.
 */

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** Records what left the body, and can push what the room said back into it. */
function fakeVoice(options: { failSay?: boolean; roomSaysOnSubscribe?: string } = {}) {
  const said: string[] = [];
  const listeners = new Set<(utterance: string) => void>();
  let closed = false;
  const client: PossessorVoiceClient = {
    say(text) {
      if (options.failSay === true) {
        return Promise.reject(new Error("clankie_speech_unavailable: the Discord bridge is not reachable"));
      }
      said.push(text);
      return Promise.resolve();
    },
    subscribe(listener) {
      listeners.add(listener);
      // Deterministic stand-in for someone speaking mid-playthrough: delivered
      // the moment the seam is listening, so the test never races the loop.
      if (options.roomSaysOnSubscribe !== undefined) listener(options.roomSaysOnSubscribe);
      return () => listeners.delete(listener);
    },
    get connected() {
      return !closed;
    },
    close() {
      closed = true;
      listeners.clear();
    },
  };
  return {
    client,
    said,
    isClosed: () => closed,
    hasListeners: () => listeners.size > 0,
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

function session(maxTurns: number): EmbodimentSession {
  return {
    schemaVersion: 1,
    sessionId: "voice-1",
    environmentId: "pokemon-firered",
    state: "claimed",
    intentId: "intent-1",
    originLane: "discord_presence",
    requestedBy: "user-1",
    budget: { maxTurns, maxDurationMs: 60_000 },
    requestedAt: "2026-07-26T12:00:00.000Z",
    updatedAt: "2026-07-26T12:00:01.000Z",
    runnerId: "runner-local",
  };
}

async function playEnv(): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(join(tmpdir(), "clankie-play-voice-"));
  return {
    CLANKIE_GBA_BODY_ROOT: join(root, "body"),
    CLANKIE_GBA_CHECKPOINT_DIR: join(root, "checkpoints"),
    // Without this override the execution journals into the operator's real
    // ~/.local/state/clankie/gba-play (ADR 0068) — test runs must not.
    CLANKIE_GBA_PLAY_JOURNAL_DIR: join(root, "gba-play"),
    // Deliberately unreachable: watching is not what this file is about.
    CLANKIE_ACTIVITY_PRODUCER_URL: "ws://127.0.0.1:1/producer",
  };
}

/** A mind that says the given line every turn, and echoes what it was told. */
function talkingMind(speak: string | null) {
  const heard: (string | null)[] = [];
  return {
    heard,
    create: () =>
      Promise.resolve({
        decide: (view: { interjection: string | null }) => {
          heard.push(view.interjection);
          return Promise.resolve({
            monologue: "still going",
            intent: "press a",
            speak,
            reply: view.interjection === null ? null : `you said ${view.interjection}`,
            action: { kind: "button_press", button: "a", holdFrames: 2 },
          });
        },
      }),
  };
}

async function play(options: {
  voice?: PossessorVoiceClient;
  mind: () => Promise<{ decide: (view: { interjection: string | null }) => Promise<unknown> }>;
  voiceAgent?: () => Promise<{ decide: () => Promise<unknown> } | undefined>;
  turns?: number;
}) {
  const client = fakeClient({ kind: "start", session: session(options.turns ?? 2) });
  const host = new PlayHost({
    client,
    runnerId: "runner-local",
    environmentIds: ["pokemon-firered"],
    execute: createGbaPlayExecution({
      logger: silentLogger,
      env: await playEnv(),
      createMind: options.mind as () => Promise<never>,
      createVoice: () => Promise.resolve(options.voice),
      ...(options.voiceAgent === undefined
        ? {}
        : { createVoiceAgent: options.voiceAgent as () => Promise<never> }),
    }),
    logger: silentLogger,
  });
  await host.poll();
  await host.settled();
  return client;
}

describe("asked play voice", () => {
  it("says his asides into the room he is playing in", async () => {
    const voice = fakeVoice();
    const mind = talkingMind("this desk has beaten me twice now");
    const client = await play({ voice: voice.client, mind: mind.create });

    expect(voice.said).toContain("this desk has beaten me twice now");
    // The playthrough still ran and reported normally.
    expect(client.reports.map((report) => report.state)).toEqual(["running", "stopped"]);
  });

  it("hears the room, and answers what was said", async () => {
    const voice = fakeVoice({ roomSaysOnSubscribe: "how's it going?" });
    const mind = talkingMind(null);
    await play({ voice: voice.client, mind: mind.create });

    // What the room said reached his turn as an interjection...
    expect(mind.heard).toContain("how's it going?");
    // ...and his answer went back out to the room.
    expect(voice.said).toContain("you said how's it going?");
  });

  it("carries the voice agent's line, not only the player's own aside", async () => {
    // ADR 0056: the player model asked to act and remark in one call stays
    // near-silent, so a transport fed only by its `speak` field carries almost
    // nothing. The half of him that talks is what fills this pipe.
    const voice = fakeVoice();
    const mind = talkingMind(null);
    await play({
      voice: voice.client,
      mind: mind.create,
      voiceAgent: () =>
        Promise.resolve({
          // Both keys always present: `reply: null` is how he stays quiet, and
          // an omitted key fails the schema rather than defaulting.
          decide: () =>
            Promise.resolve({
              speak: "okay that bookshelf is just a wall with ambitions",
              reply: null,
            }),
        }),
    });

    expect(voice.said).toContain("okay that bookshelf is just a wall with ambitions");
  });

  it("keeps playing when the bridge will not take his words", async () => {
    const voice = fakeVoice({ failSay: true });
    const mind = talkingMind("nobody can hear this");
    const client = await play({ voice: voice.client, mind: mind.create });

    expect(voice.said).toEqual([]);
    // A rejected line is not a failed playthrough: he is watchable, just silent.
    expect(client.reports.map((report) => report.state)).toEqual(["running", "stopped"]);
    expect(client.reports[1]?.receipt).toMatchObject({ outcome: "budget_exhausted", turnsTaken: 2 });
  });

  it("plays silently when the seam was never bootstrapped", async () => {
    const mind = talkingMind("into the void");
    const client = await play({ mind: mind.create });

    expect(client.reports.map((report) => report.state)).toEqual(["running", "stopped"]);
    expect(client.reports[1]?.receipt).toMatchObject({ turnsTaken: 2 });
  });

  it("lets go of the room when the playthrough ends", async () => {
    const voice = fakeVoice();
    const mind = talkingMind(null);
    await play({ voice: voice.client, mind: mind.create });

    // A session that kept its subscription would hear rooms it is not in.
    expect(voice.isClosed()).toBe(true);
    expect(voice.hasListeners()).toBe(false);
  });
});
