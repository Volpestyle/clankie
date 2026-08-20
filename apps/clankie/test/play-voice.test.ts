import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbodimentSession } from "@clankie/protocol";
import {
  createPlayVoiceClient,
  createPlayVoiceListener,
  type PlayVoiceClient,
  type PlayVoiceListenerEvidence,
} from "@clankie/play-voice";
import type { ActivityFrameSink } from "@clankie/rendered-surface-client";
import { parseFreePlayJournal } from "@clankie/gba-emulator";
import { describe, expect, it, vi } from "vitest";
import { createGbaPlayExecution } from "../src/play-execution.ts";
import { PlayHost, type EmbodimentAssignment, type EmbodimentLifecycleUpdate } from "../src/play-host.ts";

/**
 * Asked play reports events and hears the room (ADR 0067 as amended by
 * [ADR 0074](../../../docs/adr/0074-the-room-hears-one-voice.md)).
 *
 * The seam itself is proven in `@clankie/play-voice`; what is under test
 * here is the wiring, and the wiring is exactly what ADR 0074 changed. These
 * assertions were inverted rather than relaxed: this file used to require that
 * his authored asides cross the seam, which is the defect that made a six-word
 * quip into seventeen seconds of speech. What must cross now is what happened,
 * and what must never cross is a sentence.
 */

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** Records what left the body, and can push what the room said back into it. */
function fakeVoice(
  options: { failNarrate?: boolean; roomSaysOnSubscribe?: string; roomListening?: boolean } = {},
) {
  const reported: string[] = [];
  const reportOptions: { readonly deliveryId?: string; readonly respond?: boolean }[] = [];
  const listeners = new Set<(utterance: string) => void>();
  let closed = false;
  const client: PlayVoiceClient = {
    narrate(text, narrationOptions) {
      if (options.failNarrate === true) {
        return Promise.reject(new Error("clankie_speech_unavailable: the Discord bridge is not reachable"));
      }
      reported.push(text);
      reportOptions.push(narrationOptions ?? {});
      return Promise.resolve();
    },
    subscribe(listener) {
      listeners.add(listener);
      // Deterministic stand-in for someone speaking mid-playthrough: delivered
      // the moment the seam is listening, so the test never races the loop.
      if (options.roomSaysOnSubscribe !== undefined) listener(options.roomSaysOnSubscribe);
      return () => listeners.delete(listener);
    },
    get roomListening() {
      return options.roomListening ?? true;
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
    reported,
    reportOptions,
    isClosed: () => closed,
    hasListeners: () => listeners.size > 0,
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

function fakeClient(
  assignment: EmbodimentAssignment,
  onReport?: (report: EmbodimentLifecycleUpdate) => void | Promise<void>,
) {
  const assignments = [assignment];
  const reports: EmbodimentLifecycleUpdate[] = [];
  return {
    reports,
    claimEmbodiment(): Promise<EmbodimentAssignment | undefined> {
      return Promise.resolve(assignments.shift());
    },
    async reportEmbodiment(report: EmbodimentLifecycleUpdate): Promise<unknown> {
      reports.push(report);
      await onReport?.(report);
      return {};
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
  };
}

async function playEnv(): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(join(tmpdir(), "clankie-play-voice-"));
  return {
    XDG_STATE_HOME: join(root, "state"),
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
            objective: "get out of the house",
            speak,
            reply: view.interjection === null ? null : `you said ${view.interjection}`,
            action: { kind: "button_press", button: "a", holdFrames: 2 },
          });
        },
      }),
  };
}

async function play(options: {
  voice?: PlayVoiceClient;
  mind: () => Promise<{ decide: (view: { interjection: string | null }) => Promise<unknown> }>;
  voiceAgent?: () => Promise<{ decide: () => Promise<unknown> } | undefined>;
  turns?: number;
  onReport?: (report: EmbodimentLifecycleUpdate) => void | Promise<void>;
}) {
  const client = fakeClient({ kind: "start", session: session(options.turns ?? 2) }, options.onReport);
  const env = await playEnv();
  const host = new PlayHost({
    client,
    environmentIds: ["pokemon-firered"],
    execute: createGbaPlayExecution({
      logger: silentLogger,
      env,
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
  return Object.assign(client, { env });
}

describe("asked play voice", () => {
  it("reports what happened, and never a sentence to say", async () => {
    const voice = fakeVoice();
    const mind = talkingMind("this desk has beaten me twice now");
    const client = await play({ voice: voice.client, mind: mind.create });

    // Something crossed the seam...
    expect(voice.reported.length).toBeGreaterThan(0);
    // ...and it was never his authored line. The persona in the room composes
    // the words; handing it finished speech is the ADR 0074 defect.
    expect(voice.reported).not.toContain("this desk has beaten me twice now");
    expect(client.reports.map((report) => report.state)).toEqual(["running", "stopped"]);
    const journalDir = client.env["CLANKIE_GBA_PLAY_JOURNAL_DIR"] as string;
    const journalFile = readdirSync(journalDir).find((name) => name.endsWith(".jsonl")) as string;
    const lines = parseFreePlayJournal(readFileSync(join(journalDir, journalFile), "utf8"));
    expect(lines[1]).toMatchObject({
      speechDeliveryId: expect.any(String),
      narrationEvent: expect.stringContaining("thought=still going"),
    });
    expect(JSON.stringify(lines[1])).not.toContain("this desk has beaten me twice now");
  });

  it("keeps the room situated without speaking on turns his volition passed over", async () => {
    const voice = fakeVoice();
    const mind = talkingMind(null);
    const client = await play({ voice: voice.client, mind: mind.create });

    expect(voice.reported).not.toHaveLength(0);
    expect(voice.reported.join("\n")).toContain("thought=still going");
    expect(voice.reportOptions.every((options) => options.respond === false)).toBe(true);
    const journalDir = client.env["CLANKIE_GBA_PLAY_JOURNAL_DIR"] as string;
    const journalFile = readdirSync(journalDir).find((name) => name.endsWith(".jsonl")) as string;
    const lines = parseFreePlayJournal(readFileSync(join(journalDir, journalFile), "utf8"));
    expect(lines.filter((line) => line.kind === "turn").every((line) => !("speechDeliveryId" in line))).toBe(
      true,
    );
  });

  it("carries thought, outcome, goal, and next intent as one game-side experience", async () => {
    const voice = fakeVoice();
    const mind = talkingMind("this desk has beaten me twice now");
    await play({ voice: voice.client, mind: mind.create });

    expect(voice.reported.join("\n")).toContain("thought=still going");
    expect(voice.reported.join("\n")).toContain("observed=");
    expect(voice.reported.join("\n")).toContain("goal=get out of the house");
    expect(voice.reported.join("\n")).toContain("next=press a");
    expect(voice.reportOptions.some((options) => options.respond === true)).toBe(true);
  });

  it("hears the room, and leaves the answer to the room", async () => {
    const voice = fakeVoice({ roomSaysOnSubscribe: "how's it going?" });
    const mind = talkingMind(null);
    await play({ voice: voice.client, mind: mind.create });

    // What the room said still reaches his turn — the player needs to know it
    // was spoken to even though it no longer answers out loud (ADR 0074).
    expect(mind.heard).toContain("how's it going?");
    // The answer is the realtime session's to compose: it already heard the
    // same audio, so a reply authored here would be a second answer.
    expect(voice.reported).not.toContain("you said how's it going?");
  });

  it("consumes a post-start room transcript on the next turn through the production loopback seam", async () => {
    const evidence: PlayVoiceListenerEvidence[] = [];
    const narrated: string[] = [];
    const listener = createPlayVoiceListener({
      token: "clankie_play_voice_loopback_test",
      narrate: (event) => {
        narrated.push(event);
        return Promise.resolve();
      },
      room: () => ({ listening: true }),
      emit: (event) => {
        evidence.push(event);
      },
    });
    const port = await listener.listen(0);
    const voice = createPlayVoiceClient({
      url: `ws://127.0.0.1:${String(port)}/play`,
      token: "clankie_play_voice_loopback_test",
      reconnectDelayMs: 10,
    });
    try {
      await vi.waitFor(() => {
        expect(voice.connected).toBe(true);
        expect(voice.roomListening).toBe(true);
      });
      // Every turn reaches the room as experience; volition decides whether
      // that update also asks the room persona to speak.
      const mind = talkingMind("that ledge is going to be a problem");
      let deliveredAfterRunning = false;
      let acknowledgeTranscript!: () => void;
      const transcriptDelivered = new Promise<void>((resolve) => {
        acknowledgeTranscript = resolve;
      });
      const stopAcknowledging = voice.subscribe(() => acknowledgeTranscript());
      await play({
        voice,
        mind: mind.create,
        onReport: async (report) => {
          if (report.state !== "running" || deliveredAfterRunning) return;
          deliveredAfterRunning = true;
          listener.publishUtterance("james: check the path above you");
          await transcriptDelivered;
        },
      });
      stopAcknowledging();

      expect(deliveredAfterRunning).toBe(true);
      expect(mind.heard[0]).toBe("james: check the path above you");
      expect(narrated.length).toBeGreaterThan(0);
      expect(evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "play_transcript_delivery",
            attachedCount: 1,
            deliveredCount: 1,
          }),
          expect.objectContaining({ type: "play_narration_submission", attachedCount: 1 }),
        ]),
      );
      expect(JSON.stringify(evidence)).not.toContain("check the path");
    } finally {
      voice.close();
      await listener.close();
    }
  });

  it("does not consult the voice agent while a room is listening", async () => {
    let consulted = 0;
    const voice = fakeVoice({ roomListening: true });
    await play({
      voice: voice.client,
      mind: talkingMind(null).create,
      voiceAgent: () =>
        Promise.resolve({
          decide: () => {
            consulted += 1;
            return Promise.resolve({ speak: "a second voice in the same room", reply: null });
          },
        }),
    });

    // One author per surface: the room composes, so this half of him is not
    // asked and its line never reaches the seam.
    expect(consulted).toBe(0);
    expect(voice.reported).not.toContain("a second voice in the same room");
  });

  it("still consults the voice agent when nobody is listening", async () => {
    let consulted = 0;
    const voice = fakeVoice({ roomListening: false });
    await play({
      voice: voice.client,
      mind: talkingMind(null).create,
      voiceAgent: () =>
        Promise.resolve({
          decide: () => {
            consulted += 1;
            return Promise.resolve({ speak: "talking to the overlay", reply: null });
          },
        }),
    });

    // ADR 0056 keeps its agent and its surfaces; it only loses the room.
    expect(consulted).toBeGreaterThan(0);
    // With no room there is nothing to report to, so nothing crosses the seam.
    expect(voice.reported).toEqual([]);
  });

  it("keeps playing when the bridge will not take his report", async () => {
    const voice = fakeVoice({ failNarrate: true });
    const mind = talkingMind("nobody can hear this");
    const client = await play({ voice: voice.client, mind: mind.create });

    expect(voice.reported).toEqual([]);
    // A rejected event is not a failed playthrough: he is watchable, just silent.
    expect(client.reports.map((report) => report.state)).toEqual(["running", "stopped"]);
    expect(client.reports[1]?.receipt).toMatchObject({ outcome: "budget_exhausted", turnsTaken: 2 });
  });

  it("plays silently when the seam was never bootstrapped", async () => {
    const mind = talkingMind("into the void");
    const client = await play({ mind: mind.create });

    expect(client.reports.map((report) => report.state)).toEqual(["running", "stopped"]);
    expect(client.reports[1]?.receipt).toMatchObject({ turnsTaken: 2 });
  });

  it("closes the activity sink and emulator session when voice client creation throws", async () => {
    const client = fakeClient({ kind: "start", session: session(1) });
    const env = await playEnv();
    const closeSink = vi.fn();
    const host = new PlayHost({
      client,
      environmentIds: ["pokemon-firered"],
      execute: createGbaPlayExecution({
        logger: silentLogger,
        env,
        createMind: talkingMind(null).create,
        createActivitySink: () => Promise.resolve(fakeActivitySink(closeSink)),
        createVoice: () => Promise.reject(new Error("play voice broker failed")),
      }),
      logger: silentLogger,
    });

    await host.poll();
    await host.settled();

    expect(client.reports).toEqual([expect.objectContaining({ state: "failed" })]);
    expect(closeSink).toHaveBeenCalledOnce();
    expect(readdirSync(join(env.XDG_STATE_HOME as string, "clankie", "gba-runtime"))).toEqual([]);
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
