/**
 * Composition-level proof that the bridge's real port wiring — environment
 * config, `createVoiceRealtimePorts`, and `createVoiceBriefingProvider` over a
 * `ClankieApiClient` — drives `DiscordVoiceSession` through the dormant→engaged
 * wake path end-to-end offline: transcript in → addressed → conversation
 * session opened with control-plane briefing instructions → `response.create`
 * sent. Only the transports are faked (Discord media, realtime sockets, HTTP
 * fetch); everything between them is the production code.
 */

import { Buffer } from "node:buffer";
import type { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { DiscordVoiceEvidenceSchema, type DiscordVoiceEvidence } from "@clankie/protocol";
import { ClankieApiClient } from "@clankie/api-client";

interface MockConnection extends EventEmitter {
  state: { status: string };
  receiver: { speaking: EventEmitter; subscribe: (userId: string, options: unknown) => PassThrough };
  captures: { userId: string; stream: PassThrough }[];
}

interface VoiceMockState {
  readonly connections: MockConnection[];
}

vi.mock("@discordjs/voice", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  const { PassThrough: Stream } = await import("node:stream");

  class FakeAudioPlayer extends Emitter {
    public state: { status: string } = { status: "idle" };
    public play(_resource: unknown): void {
      this.state = { status: "playing" };
    }
    public stop(_force?: boolean): boolean {
      this.state = { status: "idle" };
      return true;
    }
  }

  class FakeVoiceConnection extends Emitter {
    public state = {
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

  const connections: FakeVoiceConnection[] = [];
  return {
    AudioPlayerStatus: { Idle: "idle", Playing: "playing" },
    EndBehaviorType: { AfterSilence: "afterSilence" },
    NetworkingStatusCode: { Ready: "ready" },
    NoSubscriberBehavior: { Pause: "pause" },
    StreamType: { Raw: "raw" },
    VoiceConnectionStatus: { Ready: "ready", Destroyed: "destroyed" },
    createAudioPlayer: (): FakeAudioPlayer => new FakeAudioPlayer(),
    createAudioResource: (stream: unknown): { stream: unknown } => ({ stream }),
    entersState: (target: { state: { status: string } }): Promise<unknown> => Promise.resolve(target),
    joinVoiceChannel: (_options: unknown): FakeVoiceConnection => {
      const connection = new FakeVoiceConnection();
      connections.push(connection);
      return connection;
    },
    __voiceMock: { connections },
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
import {
  ADDRESSED_OFFER_TURN_ITEM,
  DiscordVoiceIngress,
  DiscordVoiceSession,
  type RealtimeSocket,
  type RealtimeSocketFactory,
  type RealtimeTimers,
} from "@clankie/discord-presence-core";
import {
  createVoiceBriefingProvider,
  createVoiceRealtimePorts,
  parseVoiceRealtimeEnv,
} from "../src/voice-composition.ts";

const voiceMock = (discordVoiceModule as unknown as { __voiceMock: VoiceMockState }).__voiceMock;

class FakeRealtimeSocket implements RealtimeSocket {
  public readonly sent: string[] = [];
  public readonly binary: Buffer[] = [];
  public readonly url: string;
  public readonly headers: Readonly<Record<string, string>>;
  private readonly messageHandlers: ((data: string) => void)[] = [];
  private readonly closeHandlers: (() => void)[] = [];

  public constructor(url: string, headers: Readonly<Record<string, string>>) {
    this.url = url;
    this.headers = headers;
  }

  public send(data: string | Uint8Array): void {
    if (typeof data === "string") this.sent.push(data);
    else this.binary.push(Buffer.from(data));
  }

  public close(): void {
    for (const handler of this.closeHandlers) handler();
  }

  public onMessage(handler: (data: string) => void): void {
    this.messageHandlers.push(handler);
  }

  public onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  public onError(): void {
    // Transport errors are not exercised here.
  }

  public serverEvent(event: Record<string, unknown>): void {
    for (const handler of this.messageHandlers) handler(JSON.stringify(event));
  }

  public frames(): Record<string, unknown>[] {
    return this.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>);
  }
}

class TestTimers implements RealtimeTimers {
  private nextHandle = 1;
  public setTimeout(_handler: () => void, _delayMs: number): unknown {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    return handle;
  }
  public clearTimeout(_handle: unknown): void {
    // Timers never fire in this test; the wake path is event-driven.
  }
}

async function flush(rounds = 6): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const GUILD = "222222222222222222";
const CHANNEL = "333333333333333333";
const OWNER = "444444444444444444";

describe("bridge realtime wiring (dormant → engaged, offline)", () => {
  it("wakes on an addressed transcript and opens the engaged session with the briefing", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const socketFactory: RealtimeSocketFactory = (url, headers) => {
      const socket = new FakeRealtimeSocket(url, headers);
      sockets.push(socket);
      return Promise.resolve(socket);
    };
    const timers = new TestTimers();
    // The bridge's real env parsing, with deliberately non-default truncation
    // so the assertion below proves explicit pass-through, not a runtime default.
    const config = parseVoiceRealtimeEnv({
      CLANKIE_VOICE_TRUNCATION_RETENTION: "0.6",
      CLANKIE_VOICE_POST_INSTRUCTIONS_TOKEN_LIMIT: "15000",
    });
    const briefingRequests: unknown[] = [];
    const voiceApi = new ClankieApiClient({
      baseUrl: "http://127.0.0.1:9",
      captainToken: "voice-bridge-token",
      fetchImpl: ((url: URL | RequestInfo, init?: RequestInit) => {
        expect(String(url)).toBe("http://127.0.0.1:9/v1/discord/voice-briefing");
        briefingRequests.push(JSON.parse(String(init?.body)));
        return Promise.resolve(
          new Response(
            JSON.stringify({
              schemaVersion: 1,
              instructions: "Be Clankie, in the social register, on the realtime surface.",
              briefing: "Right now: tending the garden.",
              refreshedAt: "2026-07-25T17:00:00.000Z",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }) as typeof fetch,
    });
    const evidence: DiscordVoiceEvidence[] = [];
    const clock = { now: 0 };
    const session = new DiscordVoiceSession({
      ingress: new DiscordVoiceIngress(voiceApi, {
        characterId: "clankie",
        credentialRef: "discord_bot",
        transportKind: "bot",
      }),
      realtime: createVoiceRealtimePorts({ apiKey: "brokered-openai-key", config, socketFactory, timers }),
      briefing: createVoiceBriefingProvider(voiceApi),
      floor: { names: ["clankie"], replyPolicy: "addressed", chattiness: "balanced" },
      presenceSessionId: () => "presence-1",
      emit: (event) => {
        DiscordVoiceEvidenceSchema.parse(event);
        evidence.push(event);
        return Promise.resolve();
      },
      clock: () => clock.now,
      timers,
    });

    await session.join({
      guildId: GUILD,
      channelId: CHANNEL,
      invokingUserId: OWNER,
      adapterCreator: (() => ({ sendPayload: () => true, destroy: () => undefined })) as never,
    });

    // Join probes the transcription boundary over the brokered key. Actual
    // listeners are then opened per authenticated Discord speaker.
    expect(sockets).toHaveLength(1);
    const probe = sockets[0] as FakeRealtimeSocket;
    expect(probe.headers.authorization).toBe("Bearer brokered-openai-key");
    expect(probe.url).toContain("intent=transcription");
    const listenerUpdate = probe.frames()[0] as {
      type: string;
      session: { type: string; audio: { input: { transcription: { model: string } } } };
    };
    expect(listenerUpdate.type).toBe("session.update");
    expect(listenerUpdate.session.type).toBe("transcription");
    expect(listenerUpdate.session.audio.input.transcription.model).toBe("gpt-realtime-whisper");

    // One consented utterance: capture opens (gateway attribution span), PCM
    // streams into the listener, then the final transcript addresses him.
    const connection = voiceMock.connections[voiceMock.connections.length - 1] as MockConnection;
    connection.receiver.speaking.emit("start", OWNER);
    await flush();
    const listener = sockets[1] as FakeRealtimeSocket;
    const capture = connection.captures[connection.captures.length - 1];
    capture?.stream.write(Buffer.alloc(3_840, 1));
    await flush();
    capture?.stream.end();
    await flush();
    expect(listener.frames().some((frame) => frame.type === "input_audio_buffer.append")).toBe(true);
    listener.serverEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_1",
      transcript: "clankie, you there?",
    });
    await flush();

    // The wake opened the engaged session on the conversation model...
    expect(sockets).toHaveLength(3);
    const engaged = sockets[2] as FakeRealtimeSocket;
    expect(engaged.headers.authorization).toBe("Bearer brokered-openai-key");
    expect(engaged.url).toContain("model=gpt-realtime-2.1");
    const frames = engaged.frames();
    const sessionUpdate = frames.find((frame) => frame.type === "session.update") as {
      session: {
        instructions: string;
        audio: { input: { turn_detection: { create_response: boolean; interrupt_response: boolean } } };
        tools: { name: string }[];
        truncation: { type: string; retention_ratio: number; post_instructions_token_limit: number };
      };
    };
    // ...with the control-plane-composed instructions (the briefing provider's
    // fetch, not anything bridge-authored)...
    expect(sessionUpdate.session.instructions).toBe(
      "Be Clankie, in the social register, on the realtime surface.",
    );
    // ...group-room turn-taking (no auto-response, no auto-interrupt)...
    expect(sessionUpdate.session.audio.input.turn_detection.create_response).toBe(false);
    expect(sessionUpdate.session.audio.input.turn_detection.interrupt_response).toBe(false);
    // ...ask_clankie stays the privileged tool; music tools are local to the call...
    expect(sessionUpdate.session.tools.map((tool) => tool.name)).toEqual([
      "ask_clankie",
      "look_at_screen",
      "youtube_search",
      "music_play",
      "music_queue",
      "music_skip",
      "music_pause",
      "music_resume",
      "music_stop",
      "music_now",
    ]);
    // ...and the explicitly configured truncation, never unbounded defaults.
    expect(sessionUpdate.session.truncation).toEqual({
      type: "retention_ratio",
      retention_ratio: 0.6,
      post_instructions_token_limit: 15_000,
    });

    // The briefing was requested for exactly the consented ids.
    expect(briefingRequests).toEqual([
      { schemaVersion: 1, guildId: GUILD, channelId: CHANNEL, consentedUserIds: [OWNER] },
    ]);

    // Seeding order: the gateway-attributed transcript ring, then the briefing
    // projection and explicit response decision.
    const textItems = frames
      .filter((frame) => frame.type === "conversation.item.create")
      .map((frame) => (frame as { item: { content: { text: string }[] } }).item.content[0]?.text ?? "");
    expect(textItems[0]).toContain("Recent room transcript (JSONL;");
    expect(textItems[0]).toContain(JSON.stringify({ speakerId: OWNER, text: "clankie, you there?" }));
    expect(textItems[1]).toBe("Right now: tending the garden.");
    expect(textItems[2]).toBe(ADDRESSED_OFFER_TURN_ITEM);
    expect(textItems).toHaveLength(3);
    expect(frames.some((frame) => frame.type === "response.create")).toBe(true);

    // The wake is receipt-visible: floor evidence reports engaged/addressed.
    expect(evidence.filter((event) => event.type === "floor")).toMatchObject([
      { type: "floor", guildId: GUILD, channelId: CHANNEL, state: "engaged", reason: "addressed" },
    ]);

    await session.leave();
  });

  it("speaks through ElevenLabs when the external voice is configured (ADR 0070)", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const socketFactory: RealtimeSocketFactory = (url, headers) => {
      const socket = new FakeRealtimeSocket(url, headers);
      sockets.push(socket);
      return Promise.resolve(socket);
    };
    const timers = new TestTimers();
    const config = parseVoiceRealtimeEnv({
      CLANKIE_VOICE_TTS_PROVIDER: "elevenlabs",
      CLANKIE_VOICE_ELEVENLABS_VOICE_ID: "voice_abc123",
      CLANKIE_VOICE_ELEVENLABS_MODEL_ID: "eleven_flash_v2_5",
    });
    const voiceApi = new ClankieApiClient({
      baseUrl: "http://127.0.0.1:9",
      captainToken: "voice-bridge-token",
      fetchImpl: (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              schemaVersion: 1,
              instructions: "Be Clankie, in the social register, on the realtime surface.",
              briefing: "Right now: tending the garden.",
              refreshedAt: "2026-07-25T17:00:00.000Z",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        )) as typeof fetch,
    });
    const evidence: DiscordVoiceEvidence[] = [];
    const clock = { now: 0 };
    const session = new DiscordVoiceSession({
      ingress: new DiscordVoiceIngress(voiceApi, {
        characterId: "clankie",
        credentialRef: "discord_bot",
        transportKind: "bot",
      }),
      realtime: createVoiceRealtimePorts({
        apiKey: "brokered-openai-key",
        elevenLabsApiKey: "brokered-elevenlabs-key",
        config,
        socketFactory,
        timers,
      }),
      briefing: createVoiceBriefingProvider(voiceApi),
      floor: { names: ["clankie"], replyPolicy: "addressed", chattiness: "balanced" },
      presenceSessionId: () => "presence-1",
      emit: (event) => {
        DiscordVoiceEvidenceSchema.parse(event);
        evidence.push(event);
        return Promise.resolve();
      },
      clock: () => clock.now,
      timers,
    });

    await session.join({
      guildId: GUILD,
      channelId: CHANNEL,
      invokingUserId: OWNER,
      adapterCreator: (() => ({ sendPayload: () => true, destroy: () => undefined })) as never,
    });

    // Wake him with an addressed transcript.
    const connection = voiceMock.connections[voiceMock.connections.length - 1] as MockConnection;
    connection.receiver.speaking.emit("start", OWNER);
    await flush();
    const listener = sockets[1] as FakeRealtimeSocket;
    listener.serverEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_1",
      transcript: "clankie, you there?",
    });
    await flush(12);

    // The engaged pair opened: text-modality realtime ears plus the
    // ElevenLabs mouth, each over its own brokered key.
    expect(sockets).toHaveLength(4);
    const engaged = sockets[2] as FakeRealtimeSocket;
    const mouth = sockets[3] as FakeRealtimeSocket;
    expect(engaged.headers.authorization).toBe("Bearer brokered-openai-key");
    expect(engaged.url).toContain("model=gpt-realtime-2.1");
    const engagedUpdate = engaged.frames().find((frame) => frame.type === "session.update") as {
      session: { output_modalities: string[]; audio: { input?: unknown; output?: unknown } };
    };
    expect(engagedUpdate.session.output_modalities).toEqual(["text"]);
    expect(engagedUpdate.session.audio.input).toBeDefined();
    expect(engagedUpdate.session.audio.output).toBeUndefined();
    expect(mouth.headers).toEqual({ "xi-api-key": "brokered-elevenlabs-key" });
    expect(mouth.url).toContain("/voice_abc123/multi-stream-input");
    expect(mouth.url).toContain("model_id=eleven_flash_v2_5");
    expect(mouth.url).toContain("output_format=pcm_24000");

    // Model text streams into one TTS context per item, then flushes and closes on done.
    engaged.serverEvent({
      type: "response.output_text.delta",
      response_id: "resp_1",
      item_id: "item_say",
      delta: "Right here.",
    });
    await flush(12);
    engaged.serverEvent({ type: "response.done", response: { id: "resp_1", status: "completed" } });
    await flush(12);
    expect(mouth.frames()).toEqual([
      { text: " ", context_id: "item_say" },
      { text: "Right here.", context_id: "item_say" },
      { context_id: "item_say", flush: true },
      { context_id: "item_say", close_context: true },
    ]);

    // Synthesized PCM plays back through the unchanged path, and the receipt
    // cut for the turn is the ordinary fast-path response receipt.
    clock.now = 120;
    mouth.serverEvent({ audio: Buffer.from([1, 0, 2, 0]).toString("base64"), contextId: "item_say" });
    mouth.serverEvent({ isFinal: true, contextId: "item_say" });
    await flush(12);
    const responses = evidence.filter((event) => event.type === "response");
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ fastPath: true, wake: "waking", toFirstAudioMs: 120 });

    // Nothing spoken or heard ever reached a frame with the wrong key on it.
    for (const socket of [engaged, mouth]) {
      for (const raw of socket.sent) {
        expect(raw).not.toContain("brokered-openai-key");
        expect(raw).not.toContain("brokered-elevenlabs-key");
      }
    }

    await session.leave();
  });

  it("composes xAI streaming STT and Grok Voice behind the shared ports", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const config = parseVoiceRealtimeEnv({
      CLANKIE_VOICE_REALTIME_PROVIDER: "xai",
      CLANKIE_VOICE_REALTIME_MODEL: "grok-voice-think-fast-2.0",
      CLANKIE_VOICE_REALTIME_VOICE: "eve",
      CLANKIE_VOICE_XAI_REASONING_EFFORT: "none",
    });
    const ports = createVoiceRealtimePorts({
      apiKey: "brokered-xai-key",
      config,
      timers: new TestTimers(),
      socketFactory: (url, headers) => {
        const socket = new FakeRealtimeSocket(url, headers);
        sockets.push(socket);
        return Promise.resolve(socket);
      },
    });

    const listener = await ports.openTranscription({
      onTranscript: () => undefined,
      onClose: () => undefined,
      onError: () => undefined,
    });
    expect(sockets[0]?.url).toContain("wss://api.x.ai/v1/stt");
    sockets[0]?.serverEvent({ type: "transcript.created" });
    listener.appendAudio(Buffer.from([1, 0, 2, 0]));
    expect(sockets[0]?.binary[0]).toEqual(Buffer.from([1, 0, 2, 0]));

    await ports.openConversation({
      instructions: "Be Clankie.",
      onAudioDelta: (pcm) => pcm.fill(0),
      onFunctionCall: () => undefined,
      onResponseDone: () => undefined,
      onClose: () => undefined,
      onError: () => undefined,
    });
    expect(sockets[1]?.url).toContain("wss://api.x.ai/v1/realtime");
    expect(sockets[1]?.frames()[0]).toMatchObject({
      type: "session.update",
      session: { voice: "eve", reasoning: { effort: "none" }, turn_detection: null },
    });
  });
});
