import { Buffer } from "node:buffer";
import type { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  DiscordVoiceEvidenceSchema,
  type CaptainChannelTurnResult,
  type DiscordPresenceChannelTurnRequest,
  type DiscordVoiceEvidence,
} from "@clankie/protocol";
import {
  MAX_REALTIME_AUDIO_APPEND_BYTES,
  type RealtimeSessionCloseReason,
  type RealtimeTimers,
} from "../src/realtime-session.ts";
import { discordPcmToRealtimePcm, openAiPcmToDiscordPcm } from "../src/voice-audio.ts";
import type { VoiceFloorOptions } from "../src/voice-floor.ts";
import { DiscordVoiceIngress } from "../src/voice-ingress.ts";
import {
  CAPTAIN_UNREACHABLE_TEXT,
  DiscordVoiceSession,
  ENGAGED_HOLD_MS,
  ENGAGED_TICK_MS,
  type DiscordVoiceBriefingRequest,
  type JoinDiscordVoiceInput,
  type VoiceConversationOpenInput,
  type VoiceConversationPort,
  type VoiceTranscriptionHandlers,
  type VoiceTranscriptionPort,
} from "../src/voice-session.ts";

// ---------------------------------------------------------------------------
// @discordjs/voice and prism-media doubles. The media owner is the only
// component allowed to touch them, so the fakes live here rather than in a
// shared harness: a ready connection with DAVE, a player that goes idle when
// its resource's stream drains, and an opus "decoder" that passes PCM through
// so tests write raw 48 kHz stereo frames directly.
// ---------------------------------------------------------------------------

interface MockPlayer extends EventEmitter {
  state: { status: string };
  written: { ref: Buffer; copy: Buffer }[];
  stop(force?: boolean): boolean;
}

interface MockConnection extends EventEmitter {
  state: { status: string };
  receiver: { speaking: EventEmitter; subscribe: (userId: string, options: unknown) => PassThrough };
  captures: { userId: string; stream: PassThrough }[];
}

interface VoiceMockState {
  readonly players: MockPlayer[];
  readonly connections: MockConnection[];
}

vi.mock("@discordjs/voice", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  const { PassThrough: Stream } = await import("node:stream");

  interface Resource {
    stream: InstanceType<typeof Stream>;
  }

  class FakeAudioPlayer extends Emitter {
    public state: { status: string } = { status: "idle" };
    public written: { ref: Buffer; copy: Buffer }[] = [];
    private current: Resource | undefined;

    public play(resource: Resource): void {
      this.current = resource;
      this.setStatus("playing");
      resource.stream.on("data", (chunk: Buffer) => {
        this.written.push({ ref: chunk, copy: Buffer.from(chunk) });
      });
      resource.stream.on("end", () => {
        if (this.current === resource && this.state.status === "playing") this.setStatus("idle");
      });
    }

    public stop(_force?: boolean): boolean {
      if (this.state.status !== "idle") this.setStatus("idle");
      return true;
    }

    private setStatus(status: string): void {
      const previous = this.state;
      this.state = { status };
      this.emit("stateChange", previous, this.state);
    }
  }

  class FakeVoiceConnection extends Emitter {
    public state: {
      status: string;
      networking: { state: { code: string; dave: { protocolVersion: number } } };
    } = {
      status: "ready",
      networking: { state: { code: "ready", dave: { protocolVersion: 1 } } },
    };
    public captures: { userId: string; stream: InstanceType<typeof Stream> }[] = [];
    public receiver = {
      speaking: new Emitter(),
      subscribe: (userId: string, _options: unknown): InstanceType<typeof Stream> => {
        const stream = new Stream();
        this.captures.push({ userId, stream });
        return stream;
      },
    };

    public subscribe(_player: unknown): void {
      // The session wires the player to the connection; nothing to fake.
    }

    public destroy(): void {
      this.state = { ...this.state, status: "destroyed" };
    }
  }

  const players: FakeAudioPlayer[] = [];
  const connections: FakeVoiceConnection[] = [];

  const entersState = (
    target: { state: { status: string } } & InstanceType<typeof Emitter>,
    status: string,
    _timeoutMs: number,
  ): Promise<unknown> => {
    if (target.state.status === status) return Promise.resolve(target);
    return new Promise((resolve) => {
      const onChange = (_previous: { status: string }, next: { status: string }): void => {
        if (next.status === status) {
          target.off("stateChange", onChange);
          resolve(target);
        }
      };
      target.on("stateChange", onChange);
    });
  };

  return {
    AudioPlayerStatus: { Idle: "idle", Playing: "playing", Buffering: "buffering", Paused: "paused" },
    EndBehaviorType: { AfterSilence: "afterSilence" },
    NetworkingStatusCode: { Ready: "ready" },
    NoSubscriberBehavior: { Pause: "pause" },
    StreamType: { Raw: "raw" },
    VoiceConnectionStatus: { Ready: "ready", Destroyed: "destroyed", Disconnected: "disconnected" },
    createAudioPlayer: (): FakeAudioPlayer => {
      const player = new FakeAudioPlayer();
      players.push(player);
      return player;
    },
    createAudioResource: (
      stream: InstanceType<typeof Stream>,
      options: unknown,
    ): Resource & { options: unknown } => ({
      stream,
      options,
    }),
    entersState,
    joinVoiceChannel: (_options: unknown): FakeVoiceConnection => {
      const connection = new FakeVoiceConnection();
      connections.push(connection);
      return connection;
    },
    __voiceMock: { players, connections },
  };
});

vi.mock("prism-media", async () => {
  const { PassThrough: Stream } = await import("node:stream");
  class Decoder extends Stream {
    public constructor(_options?: unknown) {
      super();
    }
  }
  return { opus: { Decoder } };
});

import * as discordVoiceModule from "@discordjs/voice";

const voiceMock = (discordVoiceModule as unknown as { __voiceMock: VoiceMockState }).__voiceMock;

// ---------------------------------------------------------------------------
// Realtime port fakes: structural VoiceTranscriptionPort / VoiceConversationPort
// implementations that record every call and honor T2's zero-what-you-are-
// handed contract.
// ---------------------------------------------------------------------------

class FakeTranscription implements VoiceTranscriptionPort {
  public isOpen = true;
  public readonly appended: Buffer[] = [];
  public readonly handlers: VoiceTranscriptionHandlers;

  public constructor(handlers: VoiceTranscriptionHandlers) {
    this.handlers = handlers;
  }

  public appendAudio(pcm: Buffer): void {
    if (!this.isOpen) {
      pcm.fill(0);
      throw new Error("Realtime session is closed");
    }
    this.appended.push(Buffer.from(pcm));
    pcm.fill(0);
  }

  public close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.handlers.onClose("closed");
  }

  public lose(reason: RealtimeSessionCloseReason): void {
    this.isOpen = false;
    this.handlers.onClose(reason);
  }
}

class FakeConversation implements VoiceConversationPort {
  public isOpen = true;
  public readonly appended: Buffer[] = [];
  public readonly textItems: string[] = [];
  public responseCreates = 0;
  public readonly truncations: { itemId: string; audioEndMs: number }[] = [];
  public readonly functionResults: { callId: string; output: string }[] = [];
  public readonly input: VoiceConversationOpenInput;

  public constructor(input: VoiceConversationOpenInput) {
    this.input = input;
  }

  public appendAudio(pcm: Buffer): void {
    if (!this.isOpen) {
      pcm.fill(0);
      throw new Error("Realtime session is closed");
    }
    this.appended.push(Buffer.from(pcm));
    pcm.fill(0);
  }

  public createTextItem(text: string): void {
    this.assertOpen();
    this.textItems.push(text);
  }

  public createResponse(): void {
    this.assertOpen();
    this.responseCreates += 1;
  }

  public truncate(itemId: string, audioEndMs: number): void {
    this.assertOpen();
    this.truncations.push({ itemId, audioEndMs });
  }

  public submitFunctionResult(callId: string, output: string): void {
    this.assertOpen();
    this.functionResults.push({ callId, output });
  }

  public close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.input.onClose("closed");
  }

  public lose(reason: RealtimeSessionCloseReason): void {
    this.isOpen = false;
    this.input.onClose(reason);
  }

  private assertOpen(): void {
    if (!this.isOpen) throw new Error("Realtime session is closed");
  }
}

class TestTimers implements RealtimeTimers {
  public readonly scheduled: {
    handle: number;
    delayMs: number;
    handler: () => void;
    cleared: boolean;
    fired: boolean;
  }[] = [];
  private nextHandle = 1;

  public setTimeout(handler: () => void, delayMs: number): unknown {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.scheduled.push({ handle, delayMs, handler, cleared: false, fired: false });
    return handle;
  }

  public clearTimeout(handle: unknown): void {
    const entry = this.scheduled.find((candidate) => candidate.handle === handle);
    if (entry !== undefined) entry.cleared = true;
  }

  public pending(): { delayMs: number }[] {
    return this.scheduled.filter((candidate) => !candidate.cleared && !candidate.fired);
  }

  public fire(delayMs: number): void {
    const entry = this.scheduled.find(
      (candidate) => !candidate.cleared && !candidate.fired && candidate.delayMs === delayMs,
    );
    if (entry === undefined) throw new Error(`No armed timer with delay ${delayMs.toString()}`);
    entry.fired = true;
    entry.handler();
  }
}

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

const GUILD = "12345";
const CHANNEL = "67890";
const OWNER = "1000";
const ALICE = "1111";
const BOB = "2222";
const MALLORY = "6666";

/** 350 ms of 48 kHz stereo s16le — the sustained-speech barge-in threshold. */
const BARGE_IN_SOURCE_BYTES = 67_200;

async function flush(rounds = 4): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function stereoPcm(bytes: number, fill = 1): Buffer {
  return Buffer.alloc(bytes, fill);
}

function pcmDelta(bytes: number, fill = 3): Buffer {
  return Buffer.alloc(bytes, fill);
}

const settledResult = (turnId: string, response: string): CaptainChannelTurnResult =>
  ({ state: "settled", captainSessionId: "session-1", turnId, response }) as CaptainChannelTurnResult;

interface HarnessOptions {
  readonly narrationMinIntervalMs?: number;
  readonly volitionDecider?: (roomText: string) => Promise<boolean>;
  readonly floorOverrides?: Partial<VoiceFloorOptions>;
  readonly captain?: (request: DiscordPresenceChannelTurnRequest) => Promise<CaptainChannelTurnResult>;
}

function buildHarness(options: HarnessOptions = {}) {
  const clock = { now: 0 };
  const timers = new TestTimers();
  const evidence: DiscordVoiceEvidence[] = [];
  const transcriptions: FakeTranscription[] = [];
  const conversations: FakeConversation[] = [];
  const briefingCalls: DiscordVoiceBriefingRequest[] = [];
  const submitCalls: DiscordPresenceChannelTurnRequest[] = [];
  const ports = {
    failTranscriptionOpens: 0,
    openTranscription: (handlers: VoiceTranscriptionHandlers): Promise<VoiceTranscriptionPort> => {
      if (ports.failTranscriptionOpens > 0) {
        ports.failTranscriptionOpens -= 1;
        return Promise.reject(new Error("listener open refused"));
      }
      const transcription = new FakeTranscription(handlers);
      transcriptions.push(transcription);
      return Promise.resolve(transcription);
    },
    openConversation: (input: VoiceConversationOpenInput): Promise<VoiceConversationPort> => {
      const conversation = new FakeConversation(input);
      conversations.push(conversation);
      return Promise.resolve(conversation);
    },
  };
  const captain = options.captain ?? (() => Promise.resolve(settledResult("turn-1", "All good.")));
  const ingress = new DiscordVoiceIngress(
    {
      getHealth: () => Promise.resolve({ profileHash: "profile-1" }),
      submitDiscordCaptainChannelTurn: (request) => {
        submitCalls.push(request);
        return captain(request);
      },
    },
    { characterId: "clankie", credentialRef: "discord_bot", transportKind: "bot" },
  );
  const session = new DiscordVoiceSession({
    ingress,
    realtime: ports,
    briefing: (request) => {
      briefingCalls.push(request);
      return Promise.resolve({
        instructions: "Be Clankie, in the social register.",
        briefing: "Right now: tending the garden.",
      });
    },
    floor: {
      names: ["clankie"],
      replyPolicy: "addressed",
      chattiness: "balanced",
      decayWindowMs: 60_000,
      ...options.floorOverrides,
    },
    ...(options.volitionDecider === undefined ? {} : { volitionDecider: options.volitionDecider }),
    ...(options.narrationMinIntervalMs === undefined
      ? {}
      : { narrationMinIntervalMs: options.narrationMinIntervalMs }),
    presenceSessionId: () => "presence-1",
    emit: (event) => {
      // Every emission must be protocol-valid, including the fastPath/turnId
      // invariant — the schema is the reviewer here.
      DiscordVoiceEvidenceSchema.parse(event);
      evidence.push(event);
      return Promise.resolve();
    },
    clock: () => clock.now,
    timers,
  });
  let itemSequence = 0;
  const harness = {
    session,
    clock,
    timers,
    evidence,
    transcriptions,
    conversations,
    briefingCalls,
    submitCalls,
    ports,
    connection: (): MockConnection => at(voiceMock.connections, -1),
    player: (): MockPlayer => at(voiceMock.players, -1),
    transcription: (): FakeTranscription => at(transcriptions, -1),
    conversation: (): FakeConversation => at(conversations, -1),
    ofType: <T extends DiscordVoiceEvidence["type"]>(type: T): Extract<DiscordVoiceEvidence, { type: T }>[] =>
      evidence.filter((event): event is Extract<DiscordVoiceEvidence, { type: T }> => event.type === type),
    join: async () => {
      await session.join({
        guildId: GUILD,
        channelId: CHANNEL,
        invokingUserId: OWNER,
        adapterCreator: (() => ({
          sendPayload: () => true,
          destroy: () => undefined,
        })) as unknown as JoinDiscordVoiceInput["adapterCreator"],
      });
    },
    consent: async (userId: string) => {
      await session.setConsent(GUILD, CHANNEL, userId, true);
    },
    startCapture: (userId: string): { userId: string; stream: PassThrough } => {
      harness.connection().receiver.speaking.emit("start", userId);
      return at(harness.connection().captures, -1);
    },
    transcribe: (text: string): void => {
      itemSequence += 1;
      harness
        .transcription()
        .handlers.onTranscript({ itemId: `item_${itemSequence.toString()}`, text, final: true });
    },
    /** One short spoken utterance: capture opens, PCM flows, capture ends, the transcript lands. */
    say: async (userId: string, text: string): Promise<void> => {
      const capture = harness.startCapture(userId);
      capture.stream.write(stereoPcm(3_840));
      await flush();
      capture.stream.end();
      await flush();
      harness.transcribe(text);
      await flush();
    },
  };
  return harness;
}

function at<T>(items: readonly T[], index: number): T {
  const item = items.at(index);
  if (item === undefined) throw new Error("Expected an element and found none");
  return item;
}

async function joinedHarness(options: HarnessOptions = {}) {
  const harness = buildHarness(options);
  await harness.join();
  return harness;
}

/** Join, consent alice, and wake him with an addressed utterance. */
async function engagedHarness(options: HarnessOptions = {}) {
  const harness = await joinedHarness(options);
  await harness.consent(ALICE);
  await harness.say(ALICE, "hey clankie you there");
  return harness;
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("lifecycle", () => {
  it("joins with DAVE, opens the dormant listener, and reports the two-tier status", async () => {
    const harness = await joinedHarness();
    expect(harness.transcriptions).toHaveLength(1);
    expect(harness.session.status()).toMatchObject({
      active: true,
      guildId: GUILD,
      channelId: CHANNEL,
      daveProtocolVersion: 1,
      consentedParticipantCount: 1,
      activeCaptureCount: 0,
      floorState: "dormant",
      engaged: false,
    });
    expect(harness.evidence.map((event) => event.type)).toEqual(["joined", "consent"]);
  });

  it("an asked join (no invoker) opts in nobody until explicit opt-in", async () => {
    const harness = buildHarness();
    await harness.session.join({
      guildId: GUILD,
      channelId: CHANNEL,
      adapterCreator: (() => ({
        sendPayload: () => true,
        destroy: () => undefined,
      })) as unknown as JoinDiscordVoiceInput["adapterCreator"],
    });
    expect(harness.session.status().consentedParticipantCount).toBe(0);
    // No auto-granted consent means no consent evidence either.
    expect(harness.evidence.map((event) => event.type)).toEqual(["joined"]);
    // The asker consents like everyone else: speaking before opt-in is never
    // subscribed, and opting in restores the ordinary path.
    harness.connection().receiver.speaking.emit("start", OWNER);
    expect(harness.connection().captures).toHaveLength(0);
    await harness.consent(OWNER);
    expect(harness.session.status().consentedParticipantCount).toBe(1);
    harness.connection().receiver.speaking.emit("start", OWNER);
    expect(harness.connection().captures).toHaveLength(1);
  });

  it("fails the join when the listener cannot open, and leaves cleanly", async () => {
    const harness = buildHarness();
    harness.ports.failTranscriptionOpens = 1;
    await expect(harness.join()).rejects.toThrow("listener open refused");
    expect(harness.session.status().active).toBe(false);
    expect(harness.connection().state.status).toBe("destroyed");
    expect(harness.evidence.map((event) => event.type)).toEqual(["left"]);
  });

  it("leave closes both sessions with reason closed, cancels timers, and zeroes the ring", async () => {
    const harness = await engagedHarness();
    const transcription = harness.transcription();
    const conversation = harness.conversation();
    await harness.session.leave();
    expect(transcription.isOpen).toBe(false);
    expect(conversation.isOpen).toBe(false);
    expect(harness.ofType("failed")).toHaveLength(0);
    expect(harness.ofType("left")).toHaveLength(1);
    expect(harness.timers.pending()).toHaveLength(0);
    // A rejoin engages with a clean ring: nothing from the earlier call may
    // seed the new session.
    await harness.join();
    await harness.consent(ALICE);
    await harness.say(ALICE, "clankie fresh start");
    const seed = at(harness.conversation().textItems, 0);
    expect(seed).toContain("fresh start");
    expect(seed).not.toContain("you there");
  });

  it("ignores listener callbacks that arrive after leave", async () => {
    const harness = await joinedHarness();
    const transcription = harness.transcription();
    await harness.session.leave();
    const evidenceCount = harness.evidence.length;
    transcription.handlers.onTranscript({ itemId: "item_stale", text: "hey clankie", final: true });
    transcription.handlers.onClose("socket");
    await flush();
    expect(harness.conversations).toHaveLength(0);
    expect(harness.evidence).toHaveLength(evidenceCount);
    expect(harness.timers.pending()).toHaveLength(0);
  });
});

describe("consent boundary", () => {
  // Required mission evidence (criterion 3): unconsented audio is dropped
  // before the socket boundary because the user is never subscribed at all.
  it("never subscribes an unconsented participant, so appendAudio is never called", async () => {
    const harness = await joinedHarness();
    harness.connection().receiver.speaking.emit("start", MALLORY);
    await flush();
    expect(harness.connection().captures).toHaveLength(0);
    expect(harness.session.status().activeCaptureCount).toBe(0);
    expect(harness.transcription().appended).toHaveLength(0);
  });

  it("revoking consent mid-capture destroys the capture and stops appends", async () => {
    const harness = await joinedHarness();
    await harness.consent(BOB);
    const capture = harness.startCapture(BOB);
    capture.stream.on("error", () => undefined);
    capture.stream.write(stereoPcm(3_840));
    await flush();
    expect(harness.transcription().appended).toHaveLength(1);
    await harness.session.setConsent(GUILD, CHANNEL, BOB, false);
    await flush();
    expect(capture.stream.destroyed).toBe(true);
    try {
      capture.stream.write(stereoPcm(3_840));
    } catch {
      // Writing into a destroyed capture may throw; the point is below.
    }
    await flush();
    expect(harness.transcription().appended).toHaveLength(1);
    // Revocation is not a capture failure: no failed evidence is emitted.
    expect(harness.ofType("failed")).toHaveLength(0);
  });

  it("leaving the channel revokes consent and destroys the capture", async () => {
    const harness = await joinedHarness();
    await harness.consent(BOB);
    const capture = harness.startCapture(BOB);
    capture.stream.on("error", () => undefined);
    harness.session.memberChannelChanged(GUILD, BOB, "99999");
    await flush();
    expect(capture.stream.destroyed).toBe(true);
    expect(harness.session.status().consentedParticipantCount).toBe(1);
  });
});

describe("audio path", () => {
  it("streams converted audio to the listener as it arrives, zeroes the source, and receipts the utterance", async () => {
    const harness = await joinedHarness();
    await harness.consent(ALICE);
    const chunk = stereoPcm(BARGE_IN_SOURCE_BYTES, 2);
    const expected = discordPcmToRealtimePcm(Buffer.from(chunk));
    const capture = harness.startCapture(ALICE);
    capture.stream.write(chunk);
    await flush();
    // Streaming, not utterance-batched: the append happened before the
    // capture closed.
    expect(harness.transcription().appended).toHaveLength(1);
    expect(at(harness.transcription().appended, 0).equals(expected)).toBe(true);
    expect(chunk.equals(Buffer.alloc(chunk.byteLength))).toBe(true);
    capture.stream.end();
    await flush();
    const utterances = harness.ofType("utterance");
    expect(utterances).toHaveLength(1);
    expect(utterances[0]).toMatchObject({ userId: ALICE, durationMs: 350 });
    expect(utterances[0]?.deliveryId.length).toBeGreaterThan(0);
  });

  it("slices oversized converted buffers to the realtime append cap", async () => {
    const harness = await joinedHarness();
    await harness.consent(ALICE);
    const capture = harness.startCapture(ALICE);
    // 1 920 000 source bytes convert to 480 000 mono bytes — two capped slices.
    capture.stream.write(stereoPcm(1_920_000));
    await flush();
    const appended = harness.transcription().appended;
    expect(appended.map((buffer) => buffer.byteLength)).toEqual([
      MAX_REALTIME_AUDIO_APPEND_BYTES,
      MAX_REALTIME_AUDIO_APPEND_BYTES,
    ]);
  });

  it("feeds the engaged conversation a copy of the room audio, but not during the hold window", async () => {
    const harness = await engagedHarness();
    const conversation = harness.conversation();
    const heardWhileEngaged = conversation.appended.length;
    const capture = harness.startCapture(ALICE);
    capture.stream.write(stereoPcm(3_840, 4));
    await flush();
    expect(conversation.appended.length).toBe(heardWhileEngaged + 1);
    expect(at(conversation.appended, -1).equals(at(harness.transcription().appended, -1))).toBe(true);
    capture.stream.end();
    await flush();
    // Release the floor; the session stays warm but stops hearing the room.
    await harness.say(ALICE, "thanks clankie");
    const heardAtRelease = conversation.appended.length;
    const listenerHeard = harness.transcription().appended.length;
    const idleCapture = harness.startCapture(ALICE);
    idleCapture.stream.write(stereoPcm(3_840, 5));
    await flush();
    expect(conversation.appended.length).toBe(heardAtRelease);
    expect(harness.transcription().appended.length).toBe(listenerHeard + 1);
  });
});

describe("floor decisions", () => {
  it("an addressed wake briefs, opens, seeds ring then briefing, announces the speaker, and responds", async () => {
    const harness = await engagedHarness();
    expect(harness.ofType("floor")).toEqual([
      { type: "floor", guildId: GUILD, channelId: CHANNEL, state: "engaged", reason: "addressed" },
    ]);
    expect(harness.briefingCalls).toEqual([
      { guildId: GUILD, channelId: CHANNEL, consentedUserIds: [OWNER, ALICE] },
    ]);
    const conversation = harness.conversation();
    expect(conversation.input.instructions).toBe("Be Clankie, in the social register.");
    expect(conversation.textItems).toEqual([
      `Recent room transcript:\n${ALICE}: hey clankie you there`,
      "Right now: tending the garden.",
      `Speaker: ${ALICE}`,
    ]);
    expect(conversation.responseCreates).toBe(1);
    expect(harness.session.status()).toMatchObject({ floorState: "engaged", engaged: true });
  });

  it("the floor holder continuing gets another response without reopening or re-briefing", async () => {
    const harness = await engagedHarness();
    await harness.say(ALICE, "how are the tests going");
    expect(harness.conversations).toHaveLength(1);
    expect(harness.briefingCalls).toHaveLength(1);
    expect(harness.conversation().responseCreates).toBe(2);
  });

  // Required mission evidence: no response path exists without a floor
  // decision — dormant crosstalk opens nothing and creates nothing.
  it("dormant crosstalk never opens a conversation session and never creates a response", async () => {
    const harness = await joinedHarness();
    await harness.consent(BOB);
    await harness.say(BOB, "nice weather this weekend maybe");
    expect(harness.conversations).toHaveLength(0);
    // Volition still accounts the suppressed offer (no decider configured).
    expect(harness.ofType("volition")).toEqual([
      { type: "volition", guildId: GUILD, channelId: CHANNEL, offered: 1, taken: 0, suppressed: 1 },
    ]);
    expect(harness.ofType("floor")).toHaveLength(0);
  });

  it("explicit release goes dormant, keeps the session warm, and closes it when the hold expires", async () => {
    const harness = await engagedHarness();
    const conversation = harness.conversation();
    await harness.say(ALICE, "thanks clankie");
    expect(at(harness.ofType("floor"), -1)).toMatchObject({ state: "dormant", reason: "released" });
    expect(conversation.isOpen).toBe(true);
    expect(harness.session.status()).toMatchObject({ floorState: "dormant", engaged: true });
    harness.timers.fire(ENGAGED_HOLD_MS);
    await flush();
    expect(conversation.isOpen).toBe(false);
    expect(harness.session.status().engaged).toBe(false);
    expect(harness.ofType("failed")).toHaveLength(0);
  });

  it("a wake inside the hold window reuses the held session instead of paying setup again", async () => {
    const harness = await engagedHarness();
    await harness.say(ALICE, "thanks clankie");
    await harness.say(ALICE, "clankie actually one more thing");
    expect(harness.conversations).toHaveLength(1);
    expect(harness.briefingCalls).toHaveLength(1);
    expect(harness.conversation().responseCreates).toBe(2);
    expect(at(harness.ofType("floor"), -1)).toMatchObject({ state: "engaged", reason: "addressed" });
  });

  it("decay fires from the timer tick with no phrase at all", async () => {
    const harness = await engagedHarness();
    expect(harness.timers.pending().map((timer) => timer.delayMs)).toContain(ENGAGED_TICK_MS);
    harness.clock.now = 61_000;
    harness.timers.fire(ENGAGED_TICK_MS);
    await flush();
    expect(at(harness.ofType("floor"), -1)).toMatchObject({ state: "dormant", reason: "decay" });
    expect(harness.session.status().floorState).toBe("dormant");
    // The warm session now sits behind the hold window.
    expect(harness.timers.pending().map((timer) => timer.delayMs)).toContain(ENGAGED_HOLD_MS);
  });
});

describe("volition", () => {
  it("a taken offer engages on the provoking speaker and is accounted", async () => {
    const decider = vi.fn((roomText: string) => {
      expect(roomText).toContain(`${BOB}: the garden bot has been quiet`);
      return Promise.resolve(true);
    });
    const harness = await joinedHarness({ volitionDecider: decider });
    await harness.consent(BOB);
    await harness.say(BOB, "the garden bot has been quiet");
    expect(decider).toHaveBeenCalledTimes(1);
    expect(harness.ofType("floor")).toEqual([
      { type: "floor", guildId: GUILD, channelId: CHANNEL, state: "engaged", reason: "volition" },
    ]);
    expect(harness.ofType("volition")).toEqual([
      { type: "volition", guildId: GUILD, channelId: CHANNEL, offered: 1, taken: 1, suppressed: 0 },
    ]);
    expect(harness.conversations).toHaveLength(1);
    expect(harness.conversation().responseCreates).toBe(1);
    expect(harness.conversation().textItems).toContain(`Speaker: ${BOB}`);
  });

  it("a decider error counts as suppressed and does not crash the session", async () => {
    const harness = await joinedHarness({
      volitionDecider: () => Promise.reject(new Error("volition model unavailable")),
    });
    await harness.consent(BOB);
    await harness.say(BOB, "someone should check the deploy");
    expect(harness.ofType("volition")).toEqual([
      { type: "volition", guildId: GUILD, channelId: CHANNEL, offered: 1, taken: 0, suppressed: 1 },
    ]);
    expect(harness.conversations).toHaveLength(0);
    // Still alive: an addressed wake works afterwards.
    await harness.consent(ALICE);
    await harness.say(ALICE, "hey clankie");
    expect(harness.conversations).toHaveLength(1);
  });
});

describe("speaker attribution", () => {
  it("attributes transcripts to the most recent active gateway span and announces speaker changes", async () => {
    const harness = await joinedHarness();
    await harness.consent(ALICE);
    await harness.consent(BOB);
    // Alice spoke and finished; bob is still talking when the transcript
    // lands, so bob is the span holder overlapping its arrival.
    const alice = harness.startCapture(ALICE);
    alice.stream.write(stereoPcm(3_840));
    await flush();
    alice.stream.end();
    await flush();
    harness.startCapture(BOB).stream.write(stereoPcm(3_840));
    await flush();
    harness.transcribe("hey clankie what do you think");
    await flush();
    expect(harness.conversation().textItems).toContain(`Speaker: ${BOB}`);
    // A new speaker opening a capture while engaged is announced out of band.
    harness.startCapture(ALICE);
    await flush();
    expect(at(harness.conversation().textItems, -1)).toBe(`Speaker: ${ALICE}`);
  });
});

describe("fast path responses", () => {
  it("measures toFirstAudioMs and playbackMs, reports waking then continuing, and zeroes playback buffers", async () => {
    const harness = await joinedHarness();
    await harness.consent(ALICE);
    harness.clock.now = 1_000;
    await harness.say(ALICE, "hey clankie you there");
    const conversation = harness.conversation();
    expect(conversation.responseCreates).toBe(1);
    harness.clock.now = 1_120;
    const delta = pcmDelta(480);
    const expectedPlayback = openAiPcmToDiscordPcm(Buffer.from(delta));
    conversation.input.onAudioDelta(delta, "item_1");
    // Delta zeroing is the session's duty once it converted the audio.
    expect(delta.equals(Buffer.alloc(480))).toBe(true);
    await flush();
    harness.clock.now = 1_150;
    conversation.input.onResponseDone({
      responseId: "resp_1",
      status: "completed",
      audioBytes: 480,
      textCharacters: 0,
    });
    await flush();
    const first = at(harness.ofType("response"), 0);
    expect(first).toMatchObject({
      fastPath: true,
      state: "settled",
      wake: "waking",
      handoffMs: 0,
      toFirstAudioMs: 120,
      playbackMs: 30,
    });
    expect(first.turnId).toBeUndefined();
    const written = at(harness.player().written, 0);
    expect(written.copy.equals(expectedPlayback)).toBe(true);
    expect(written.ref.equals(Buffer.alloc(written.ref.byteLength))).toBe(true);

    // The next turn in the same exchange is a continuing response.
    harness.clock.now = 2_000;
    await harness.say(ALICE, "and how are the tests");
    harness.clock.now = 2_100;
    conversation.input.onAudioDelta(pcmDelta(480), "item_2");
    await flush();
    harness.clock.now = 2_130;
    conversation.input.onResponseDone({
      responseId: "resp_2",
      status: "completed",
      audioBytes: 480,
      textCharacters: 0,
    });
    await flush();
    expect(at(harness.ofType("response"), 1)).toMatchObject({
      fastPath: true,
      wake: "continuing",
      toFirstAudioMs: 100,
      playbackMs: 30,
    });
  });
});

describe("ability path", () => {
  // Required mission evidence: two ask_clankie calls serialize on the turn
  // queue, and their spoken results never talk over each other.
  it("serializes ask_clankie through the unchanged captain lane with evidence", async () => {
    const resolvers: ((result: CaptainChannelTurnResult) => void)[] = [];
    const harness = await joinedHarness({
      captain: () =>
        new Promise<CaptainChannelTurnResult>((resolve) => {
          resolvers.push(resolve);
        }),
    });
    await harness.consent(ALICE);
    harness.clock.now = 1_000;
    await harness.say(ALICE, "hey clankie check on the deploy");
    const conversation = harness.conversation();
    conversation.input.onFunctionCall({
      callId: "call_1",
      name: "ask_clankie",
      argumentsJson: '{"request":"check the deploy status"}',
    });
    conversation.input.onFunctionCall({
      callId: "call_2",
      name: "ask_clankie",
      argumentsJson: '{"request":"and restart the runner"}',
    });
    // The function-call response itself settles with no audio.
    conversation.input.onResponseDone({
      responseId: "resp_fn",
      status: "completed",
      audioBytes: 0,
      textCharacters: 0,
    });
    await flush();
    // Serialized: the second handoff waits for the first to finish.
    expect(harness.submitCalls).toHaveLength(1);
    expect(at(harness.submitCalls, 0).trigger).toMatchObject({
      kind: "voice_event",
      guildId: GUILD,
      channelId: CHANNEL,
      actorId: ALICE,
      body: "check the deploy status",
    });
    harness.clock.now = 1_200;
    at(resolvers, 0)(settledResult("turn-1", "Deploy is green."));
    await flush();
    expect(conversation.functionResults).toEqual([{ callId: "call_1", output: "Deploy is green." }]);
    expect(harness.submitCalls).toHaveLength(2);
    harness.clock.now = 1_300;
    at(resolvers, 1)(settledResult("turn-2", "Runner restarted."));
    await flush();
    expect(at(conversation.functionResults, 1)).toEqual({ callId: "call_2", output: "Runner restarted." });

    // Their spoken results play and receipt in order.
    conversation.input.onAudioDelta(pcmDelta(480), "item_r1");
    await flush();
    conversation.input.onResponseDone({
      responseId: "resp_r1",
      status: "completed",
      audioBytes: 480,
      textCharacters: 0,
    });
    await flush();
    conversation.input.onAudioDelta(pcmDelta(480), "item_r2");
    await flush();
    conversation.input.onResponseDone({
      responseId: "resp_r2",
      status: "completed",
      audioBytes: 480,
      textCharacters: 0,
    });
    await flush();
    const responses = harness.ofType("response");
    expect(responses.map((event) => event.turnId)).toEqual(["turn-1", "turn-2"]);
    expect(responses[0]).toMatchObject({ fastPath: false, state: "settled", wake: "waking", handoffMs: 200 });
    // Both calls came from the same waking response, so both spoken results
    // carry that decision's wake classification.
    expect(responses[1]).toMatchObject({ fastPath: false, state: "settled", wake: "waking", handoffMs: 100 });
  });

  // Required mission evidence (criterion 4): approval-shaped outcomes speak
  // only the authenticated-surface handoff — ambient voice cannot approve.
  it("keeps the authenticated-surface handoff for approval-shaped results", async () => {
    const harness = await joinedHarness({
      captain: () =>
        Promise.resolve({
          state: "waiting_user",
          captainSessionId: "session-1",
          turnId: "turn-9",
          prompt: "Approve secret operation launch-codes?",
          approvalRequired: true,
        } as CaptainChannelTurnResult),
    });
    await harness.consent(ALICE);
    await harness.say(ALICE, "hey clankie merge the release");
    const conversation = harness.conversation();
    conversation.input.onFunctionCall({
      callId: "call_1",
      name: "ask_clankie",
      argumentsJson: '{"request":"merge the release"}',
    });
    conversation.input.onResponseDone({
      responseId: "resp_fn",
      status: "completed",
      audioBytes: 0,
      textCharacters: 0,
    });
    await flush();
    const result = at(conversation.functionResults, 0);
    expect(result.output).toBe("I need you to continue that request on the authenticated operator surface.");
    expect(result.output).not.toContain("secret");
    conversation.input.onAudioDelta(pcmDelta(480), "item_r1");
    await flush();
    conversation.input.onResponseDone({
      responseId: "resp_r1",
      status: "completed",
      audioBytes: 480,
      textCharacters: 0,
    });
    await flush();
    expect(at(harness.ofType("response"), 0)).toMatchObject({
      fastPath: false,
      turnId: "turn-9",
      state: "waiting_user",
    });
  });

  it("answers a captain failure with the fixed sentence and keeps the queue alive", async () => {
    let calls = 0;
    const harness = await joinedHarness({
      captain: () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error("captain exploded: secret detail"));
        return Promise.resolve(settledResult("turn-2", "Back online."));
      },
    });
    await harness.consent(ALICE);
    await harness.say(ALICE, "hey clankie do the thing");
    const conversation = harness.conversation();
    conversation.input.onFunctionCall({
      callId: "call_1",
      name: "ask_clankie",
      argumentsJson: '{"request":"do the thing"}',
    });
    await flush();
    expect(at(conversation.functionResults, 0).output).toBe(CAPTAIN_UNREACHABLE_TEXT);
    expect(harness.ofType("failed")).toEqual([
      {
        type: "failed",
        guildId: GUILD,
        channelId: CHANNEL,
        stage: "captain_handoff",
        code: "voice_captain_handoff_failed",
      },
    ]);
    // The queue is not hung: the next call reaches the captain and speaks.
    conversation.input.onFunctionCall({
      callId: "call_2",
      name: "ask_clankie",
      argumentsJson: '{"request":"try again"}',
    });
    await flush();
    expect(at(conversation.functionResults, 1)).toEqual({ callId: "call_2", output: "Back online." });
  });

  it("rejects malformed ask_clankie arguments without hanging", async () => {
    const harness = await engagedHarness();
    const conversation = harness.conversation();
    conversation.input.onFunctionCall({ callId: "call_1", name: "ask_clankie", argumentsJson: "not json" });
    await flush();
    expect(harness.submitCalls).toHaveLength(0);
    expect(at(conversation.functionResults, 0).output).toBe(CAPTAIN_UNREACHABLE_TEXT);
    expect(at(harness.ofType("failed"), 0)).toMatchObject({
      stage: "captain_handoff",
      code: "voice_ask_clankie_arguments_invalid",
    });
  });

  it("speaks the fixed sentence on a failed captain outcome and receipts only the failure", async () => {
    const harness = await joinedHarness({
      captain: () =>
        Promise.resolve({
          state: "failed",
          captainSessionId: "session-1",
          turnId: "turn-1",
          code: "captain_session_failed",
        } as CaptainChannelTurnResult),
    });
    await harness.consent(ALICE);
    await harness.say(ALICE, "hey clankie check the queue");
    const conversation = harness.conversation();
    conversation.input.onFunctionCall({
      callId: "call_1",
      name: "ask_clankie",
      argumentsJson: '{"request":"check the queue"}',
    });
    await flush();
    // The model gets the fixed sentence so the exchange can close; no
    // response receipt exists for a turn that never produced one, so the
    // fastPath/turnId invariant is never in play.
    expect(at(conversation.functionResults, 0).output).toBe(CAPTAIN_UNREACHABLE_TEXT);
    expect(at(harness.ofType("failed"), 0)).toMatchObject({
      stage: "captain_handoff",
      code: "captain_session_failed",
    });
    expect(harness.ofType("response")).toHaveLength(0);
  });

  it("a silent captain outcome says nothing, receipts nothing, and leaves the session healthy", async () => {
    let calls = 0;
    const harness = await joinedHarness({
      captain: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve({
            state: "silent",
            captainSessionId: "session-1",
            turnId: "turn-1",
          } as CaptainChannelTurnResult);
        }
        return Promise.resolve(settledResult("turn-2", "Still here."));
      },
    });
    await harness.consent(ALICE);
    await harness.say(ALICE, "hey clankie whats new");
    const conversation = harness.conversation();
    conversation.input.onFunctionCall({
      callId: "call_1",
      name: "ask_clankie",
      argumentsJson: '{"request":"whats new"}',
    });
    await flush();
    // Deliberate silence: no function result, no response receipt, no
    // failure — deciding to stay quiet must not cost a response.
    expect(conversation.functionResults).toHaveLength(0);
    expect(harness.ofType("response")).toHaveLength(0);
    expect(harness.ofType("failed")).toHaveLength(0);
    // The turn queue is not wedged: the next ask_clankie round-trips.
    conversation.input.onFunctionCall({
      callId: "call_2",
      name: "ask_clankie",
      argumentsJson: '{"request":"still there?"}',
    });
    await flush();
    expect(at(conversation.functionResults, 0)).toEqual({ callId: "call_2", output: "Still here." });
  });
});

describe("barge-in", () => {
  async function playingHarness() {
    const harness = await engagedHarness();
    const conversation = harness.conversation();
    harness.clock.now = 5_000;
    conversation.input.onAudioDelta(pcmDelta(480), "item_play");
    await flush();
    expect(harness.player().state.status).toBe("playing");
    return { harness, conversation };
  }

  it("sustained speech from the floor holder truncates deliberately at the played offset", async () => {
    const { harness, conversation } = await playingHarness();
    harness.clock.now = 5_400;
    const capture = harness.startCapture(ALICE);
    capture.stream.write(stereoPcm(BARGE_IN_SOURCE_BYTES));
    await flush();
    expect(conversation.truncations).toEqual([{ itemId: "item_play", audioEndMs: 400 }]);
    expect(harness.player().state.status).toBe("idle");
    expect(harness.ofType("interrupted")).toEqual([
      { type: "interrupted", guildId: GUILD, channelId: CHANNEL, userId: ALICE, phase: "playing" },
    ]);
  });

  it("a re-address from any consented speaker truncates and moves the floor", async () => {
    const { harness, conversation } = await playingHarness();
    await harness.consent(BOB);
    harness.clock.now = 5_250;
    const capture = harness.startCapture(BOB);
    capture.stream.write(stereoPcm(3_840));
    await flush();
    harness.transcribe("clankie hold on a second");
    await flush();
    expect(conversation.truncations).toEqual([{ itemId: "item_play", audioEndMs: 250 }]);
    expect(at(harness.ofType("interrupted"), 0)).toMatchObject({ userId: BOB });
    // The re-address is also a floor decision: he answers bob next.
    expect(conversation.responseCreates).toBe(2);
  });

  // Required mission evidence: crosstalk between other people lets him finish.
  it("crosstalk from a non-holder that does not address him never truncates", async () => {
    const { harness, conversation } = await playingHarness();
    await harness.consent(BOB);
    const capture = harness.startCapture(BOB);
    capture.stream.write(stereoPcm(BARGE_IN_SOURCE_BYTES));
    await flush();
    harness.transcribe("no I meant the blue one");
    await flush();
    expect(conversation.truncations).toHaveLength(0);
    expect(harness.ofType("interrupted")).toHaveLength(0);
    expect(harness.player().state.status).toBe("playing");
    expect(conversation.responseCreates).toBe(1);
  });
});

describe("reconnect", () => {
  it("a lost listener emits failed evidence and reopens with bounded backoff, resetting on success", async () => {
    const harness = await joinedHarness();
    harness.transcription().lose("socket");
    expect(harness.ofType("failed")).toEqual([
      {
        type: "failed",
        guildId: GUILD,
        channelId: CHANNEL,
        stage: "transcription_session",
        code: "voice_listener_lost",
      },
    ]);
    expect(harness.timers.pending().map((timer) => timer.delayMs)).toContain(1_000);
    // First retry fails; the next is scheduled at twice the delay.
    harness.ports.failTranscriptionOpens = 1;
    harness.timers.fire(1_000);
    await flush();
    expect(harness.transcriptions).toHaveLength(1);
    expect(harness.timers.pending().map((timer) => timer.delayMs)).toContain(2_000);
    harness.timers.fire(2_000);
    await flush();
    expect(harness.transcriptions).toHaveLength(2);
    // The new listener is his ears again.
    await harness.consent(ALICE);
    harness.startCapture(ALICE).stream.write(stereoPcm(3_840));
    await flush();
    expect(harness.transcription().appended).toHaveLength(1);
    // Success reset the backoff: a later loss starts back at one second.
    harness.transcription().lose("error");
    expect(harness.timers.pending().map((timer) => timer.delayMs)).toContain(1_000);
  });

  it("a conversation lost mid-engagement emits failed evidence and reopens lazily on the next wake", async () => {
    const harness = await engagedHarness();
    harness.conversation().lose("error");
    await flush();
    expect(at(harness.ofType("failed"), 0)).toMatchObject({
      stage: "conversation_session",
      code: "voice_conversation_lost",
    });
    expect(harness.session.status().engaged).toBe(false);
    // The floor holder keeps talking: the session reopens with fresh setup.
    await harness.say(ALICE, "are you still with me");
    expect(harness.conversations).toHaveLength(2);
    expect(harness.briefingCalls).toHaveLength(2);
    expect(harness.conversation().responseCreates).toBe(1);
  });
});

describe("transcript ring", () => {
  it("caps the seed to the recent window", async () => {
    const harness = await joinedHarness({ floorOverrides: { volition: { maxPerHour: 0 } } });
    await harness.consent(ALICE);
    for (let line = 0; line < 35; line += 1) {
      await harness.say(ALICE, `line-${line.toString()} of idle chatter`);
    }
    await harness.say(ALICE, "hey clankie summarize that");
    const seed = at(harness.conversation().textItems, 0);
    expect(seed.startsWith("Recent room transcript:\n")).toBe(true);
    expect(seed).toContain("line-34");
    expect(seed).not.toContain("line-0 ");
    expect(seed.split("\n")).toHaveLength(31);
  });
});

describe("possessor narration and hearing (ADR 0064)", () => {
  it("refuses to narrate when he is not in a voice channel", async () => {
    const harness = buildHarness();
    await expect(harness.session.narrate("walked into a wall")).rejects.toThrow(
      /voice_narration_not_in_channel/u,
    );
  });

  it("refuses an empty report rather than seeding nothing", async () => {
    const harness = await joinedHarness();
    await expect(harness.session.narrate("   ")).rejects.toThrow(/voice_narration_empty/u);
  });

  it("seeds the report as context and lets the persona compose the words", async () => {
    const harness = await joinedHarness();
    await harness.session.narrate("walked into a wall by the lab");
    await flush();

    const conversation = harness.conversation();
    // The possessor's text is seeded, never queued as speech to synthesize.
    const seeded = conversation.textItems.filter((item) => item.includes("walked into a wall by the lab"));
    expect(seeded).toHaveLength(1);
    expect(at(seeded, 0)).toBe("While playing, Clankie just: walked into a wall by the lab");
    // A response was requested; what he actually says is the model's.
    expect(conversation.responseCreates).toBe(1);
  });

  it("keeps seeding but stops responding inside the narration interval", async () => {
    const harness = await joinedHarness({ narrationMinIntervalMs: 10_000 });
    await harness.session.narrate("left the lab");
    await flush();
    expect(harness.conversation().responseCreates).toBe(1);

    harness.clock.now += 1_000;
    await harness.session.narrate("took one step north");
    await harness.session.narrate("took another step north");
    await flush();

    const conversation = harness.conversation();
    // Every step is still seeded — he must not narrate a past he never saw.
    expect(conversation.textItems.filter((item) => item.startsWith("While playing,"))).toHaveLength(3);
    // But the room is not monologued at.
    expect(conversation.responseCreates).toBe(1);

    harness.clock.now += 10_000;
    await harness.session.narrate("found a pokeball");
    await flush();
    expect(harness.conversation().responseCreates).toBe(2);
  });

  it("pushes attributed room lines to a subscribed possessor", async () => {
    const harness = await joinedHarness({ floorOverrides: { volition: { maxPerHour: 0 } } });
    await harness.consent(ALICE);
    const heard: string[] = [];
    const unsubscribe = harness.session.subscribeTranscript((line) => heard.push(line));

    await harness.say(ALICE, "go left instead");
    expect(heard).toEqual([`${ALICE}: go left instead`]);

    unsubscribe();
    await harness.say(ALICE, "no seriously go left");
    expect(heard).toHaveLength(1);
  });

  it("never pushes what an unconsented participant said", async () => {
    const harness = await joinedHarness({ floorOverrides: { volition: { maxPerHour: 0 } } });
    const heard: string[] = [];
    harness.session.subscribeTranscript((line) => heard.push(line));

    // Mallory never consented, so no capture opens and no transcript exists.
    harness.connection().receiver.speaking.emit("start", MALLORY);
    await flush();
    expect(harness.connection().captures.some((capture) => capture.userId === MALLORY)).toBe(false);
    expect(heard).toEqual([]);
  });

  it("survives a subscriber that throws", async () => {
    const harness = await joinedHarness({ floorOverrides: { volition: { maxPerHour: 0 } } });
    await harness.consent(ALICE);
    const heard: string[] = [];
    harness.session.subscribeTranscript(() => {
      throw new Error("possessor died mid-line");
    });
    harness.session.subscribeTranscript((line) => heard.push(line));

    await harness.say(ALICE, "still listening");
    expect(heard).toEqual([`${ALICE}: still listening`]);
  });
});

describe("possessor narration bursts (ADR 0064)", () => {
  it("lets only one un-awaited report in a burst reach a response", async () => {
    const harness = await joinedHarness({ narrationMinIntervalMs: 10_000 });
    // A play loop fires and forgets; nothing awaits between these.
    const reports = [
      harness.session.narrate("stepped north"),
      harness.session.narrate("stepped north again"),
      harness.session.narrate("bumped the fence"),
    ];
    await Promise.all(reports);
    await flush();

    const conversation = harness.conversation();
    expect(conversation.textItems.filter((item) => item.startsWith("While playing,"))).toHaveLength(3);
    expect(conversation.responseCreates).toBe(1);
  });
});
