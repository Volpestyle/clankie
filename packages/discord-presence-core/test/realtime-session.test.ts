import { ManualTimers } from "./manual-timers.ts";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  MAX_REALTIME_AUDIO_APPEND_BYTES,
  MAX_REALTIME_RESPONSE_AUDIO_BYTES,
  MAX_REALTIME_RESPONSE_TEXT_CHARACTERS,
  MAX_REALTIME_TEXT_ITEM_CHARACTERS,
  openRealtimeConversationSession,
  openRealtimeTranscriptionSession,
  openXaiStreamingTranscriptionSession,
  type RealtimeConversationSession,
  type RealtimeConversationSessionOptions,
  type RealtimeFunctionCall,
  type RealtimeResponseMeta,
  type RealtimeSessionCloseReason,
  type RealtimeSocket,
  type RealtimeTranscriptEvent,
  type RealtimeTranscriptionSession,
  type RealtimeTranscriptionSessionOptions,
} from "../src/realtime-session.ts";

class FakeRealtimeSocket implements RealtimeSocket {
  public readonly sentRaw: string[] = [];
  public readonly sentBinary: Buffer[] = [];
  public closed = false;
  public onSend: ((frame: Record<string, unknown>) => void) | undefined;
  private readonly messageHandlers: ((data: string) => void)[] = [];
  private readonly closeHandlers: (() => void)[] = [];
  private readonly errorHandlers: ((error: unknown) => void)[] = [];

  public send(data: string | Uint8Array): void {
    if (typeof data === "string") {
      this.sentRaw.push(data);
      this.onSend?.(JSON.parse(data) as Record<string, unknown>);
    } else this.sentBinary.push(Buffer.from(data));
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.closeHandlers) handler();
  }

  public onMessage(handler: (data: string) => void): void {
    this.messageHandlers.push(handler);
  }

  public onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  public onError(handler: (error: unknown) => void): void {
    this.errorHandlers.push(handler);
  }

  public emit(frame: Record<string, unknown>): void {
    const raw = JSON.stringify(frame);
    for (const handler of this.messageHandlers) handler(raw);
  }

  public emitError(error: unknown): void {
    for (const handler of this.errorHandlers) handler(error);
  }
}

function frames(socket: FakeRealtimeSocket): Record<string, unknown>[] {
  return socket.sentRaw.map((raw) => JSON.parse(raw) as Record<string, unknown>);
}

function framesOfType(socket: FakeRealtimeSocket, type: string): Record<string, unknown>[] {
  return frames(socket).filter((frame) => frame.type === type);
}

interface ConversationEvents {
  readonly audio: { pcm: Buffer; itemId: string }[];
  readonly transcripts: RealtimeTranscriptEvent[];
  readonly done: RealtimeResponseMeta[];
  readonly calls: RealtimeFunctionCall[];
  readonly closes: RealtimeSessionCloseReason[];
  readonly errors: string[];
}

async function openConversation(overrides: Partial<RealtimeConversationSessionOptions> = {}): Promise<{
  session: RealtimeConversationSession;
  socket: FakeRealtimeSocket;
  timers: ManualTimers;
  factory: { url: string; headers: Record<string, string> }[];
  events: ConversationEvents;
}> {
  const socket = new FakeRealtimeSocket();
  const timers = new ManualTimers();
  const factory: { url: string; headers: Record<string, string> }[] = [];
  const events: ConversationEvents = {
    audio: [],
    transcripts: [],
    done: [],
    calls: [],
    closes: [],
    errors: [],
  };
  const session = await openRealtimeConversationSession({
    apiKey: "sk-test-secret",
    instructions: "Be Clankie, in the social register.",
    socketFactory: (url, headers) => {
      factory.push({ url, headers: { ...headers } });
      return Promise.resolve(socket);
    },
    timers,
    onAudioDelta: (pcm, itemId) => events.audio.push({ pcm: Buffer.from(pcm), itemId }),
    onTranscript: (event) => events.transcripts.push(event),
    onResponseDone: (meta) => events.done.push(meta),
    onFunctionCall: (call) => events.calls.push(call),
    onClose: (reason) => events.closes.push(reason),
    onError: (message) => events.errors.push(message),
    ...overrides,
  });
  return { session, socket, timers, factory, events };
}

async function openTranscription(overrides: Partial<RealtimeTranscriptionSessionOptions> = {}): Promise<{
  session: RealtimeTranscriptionSession;
  socket: FakeRealtimeSocket;
  timers: ManualTimers;
  factory: { url: string; headers: Record<string, string> }[];
  transcripts: RealtimeTranscriptEvent[];
  closes: RealtimeSessionCloseReason[];
}> {
  const socket = new FakeRealtimeSocket();
  const timers = new ManualTimers();
  const factory: { url: string; headers: Record<string, string> }[] = [];
  const transcripts: RealtimeTranscriptEvent[] = [];
  const closes: RealtimeSessionCloseReason[] = [];
  const session = await openRealtimeTranscriptionSession({
    apiKey: "sk-test-secret",
    socketFactory: (url, headers) => {
      factory.push({ url, headers: { ...headers } });
      return Promise.resolve(socket);
    },
    timers,
    onTranscript: (event) => transcripts.push(event),
    onClose: (reason) => closes.push(reason),
    ...overrides,
  });
  return { session, socket, timers, factory, transcripts, closes };
}

describe("realtime conversation session", () => {
  it("opens with VAD that can neither create nor interrupt a response, and the local tool set", async () => {
    const { socket } = await openConversation();
    const update = frames(socket)[0];
    expect(update).toMatchObject({
      type: "session.update",
      session: {
        type: "realtime",
        model: "gpt-realtime-2.1",
        output_modalities: ["audio"],
        instructions: "Be Clankie, in the social register.",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24_000 },
            turn_detection: {
              type: "server_vad",
              create_response: false,
              interrupt_response: false,
            },
          },
          output: {
            format: { type: "audio/pcm", rate: 24_000 },
            voice: "marin",
          },
        },
        truncation: {
          type: "retention_ratio",
          retention_ratio: 0.7,
          post_instructions_token_limit: 12_000,
        },
      },
    });
    const tools = (update as { session?: { tools?: { name?: string; description?: string }[] } } | undefined)
      ?.session?.tools;
    expect(tools?.map((tool) => tool.name)).toEqual([
      "ask_clankie",
      "voice_leave",
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
    expect(tools?.find((tool) => tool.name === "ask_clankie")?.description).toContain(
      "you choose to remember",
    );
    expect(tools?.find((tool) => tool.name === "ask_clankie")?.description).toContain("your own route");
    expect(tools?.find((tool) => tool.name === "ask_clankie")?.description).toContain(
      "web browsing and research",
    );
  });

  // Required mission evidence: no server event — speech boundaries, committed
  // audio, transcripts, item lifecycle — may ever produce a response on its
  // own. Only an explicit createResponse() sends response.create.
  it("never sends response.create except through an explicit createResponse call", async () => {
    const { session, socket } = await openConversation();
    socket.emit({ type: "session.updated", session: {} });
    socket.emit({ type: "input_audio_buffer.speech_started", audio_start_ms: 120, item_id: "item_1" });
    socket.emit({ type: "input_audio_buffer.speech_stopped", audio_end_ms: 900, item_id: "item_1" });
    socket.emit({ type: "input_audio_buffer.committed", item_id: "item_1" });
    socket.emit({ type: "conversation.item.created", item: { id: "item_1", type: "message" } });
    socket.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_1",
      transcript: "hey clankie, you there?",
    });
    session.appendAudio(Buffer.alloc(480));
    expect(framesOfType(socket, "response.create")).toHaveLength(0);

    session.createResponse();
    expect(framesOfType(socket, "response.create")).toHaveLength(1);
  });

  it("zeroes the caller's audio buffer on every path out of appendAudio", async () => {
    const { session, socket } = await openConversation();
    const pcm = Buffer.from([1, 0, 2, 0, 3, 0]);
    const encoded = pcm.toString("base64");
    session.appendAudio(pcm);
    expect(pcm.equals(Buffer.alloc(6))).toBe(true);
    expect(frames(socket).at(-1)).toMatchObject({ type: "input_audio_buffer.append", audio: encoded });

    const odd = Buffer.from([1, 0, 2]);
    expect(() => {
      session.appendAudio(odd);
    }).toThrow("whole s16le samples");
    expect(odd.equals(Buffer.alloc(3))).toBe(true);

    const oversized = Buffer.alloc(MAX_REALTIME_AUDIO_APPEND_BYTES + 2, 7);
    expect(() => {
      session.appendAudio(oversized);
    }).toThrow("chunk byte limit");
    expect(oversized.equals(Buffer.alloc(oversized.byteLength))).toBe(true);
  });

  it("surfaces response audio per item and fails closed past the per-response byte cap", async () => {
    const { socket, events } = await openConversation();
    const smallPcm = Buffer.from([1, 0, 2, 0]);
    socket.emit({
      type: "response.output_audio.delta",
      response_id: "resp_1",
      item_id: "item_a",
      delta: smallPcm.toString("base64"),
    });
    expect(events.audio).toHaveLength(1);
    expect(events.audio[0]?.itemId).toBe("item_a");
    expect(events.audio[0]?.pcm.equals(smallPcm)).toBe(true);
    socket.emit({
      type: "response.output_audio_transcript.done",
      item_id: "item_a",
      transcript: "Yep, I’m here.",
    });
    expect(events.transcripts).toEqual([{ itemId: "item_a", text: "Yep, I’m here.", final: true }]);

    // A new response resets the accounting: two large responses that are each
    // under the cap must both play.
    const nearCap = Buffer.alloc(MAX_REALTIME_RESPONSE_AUDIO_BYTES - 10_000).toString("base64");
    socket.emit({ type: "response.output_audio.delta", response_id: "resp_2", item_id: "b", delta: nearCap });
    socket.emit({ type: "response.done", response: { id: "resp_2", status: "completed" } });
    socket.emit({ type: "response.output_audio.delta", response_id: "resp_3", item_id: "c", delta: nearCap });
    expect(events.errors).toHaveLength(0);

    // One more delta pushes resp_3 past the cap: report, close, stop surfacing.
    const audioBefore = events.audio.length;
    socket.emit({
      type: "response.output_audio.delta",
      response_id: "resp_3",
      item_id: "c",
      delta: Buffer.alloc(20_000).toString("base64"),
    });
    expect(events.audio).toHaveLength(audioBefore);
    expect(events.errors).toEqual(["Realtime response audio exceeded the byte limit"]);
    expect(events.closes).toEqual(["error"]);
    expect(socket.closed).toBe(true);
  });

  it("completes the ask_clankie round trip with function_call_output then response.create", async () => {
    const { session, socket, events } = await openConversation();
    socket.emit({
      type: "response.output_item.done",
      response_id: "resp_1",
      item: {
        type: "function_call",
        call_id: "call_1",
        name: "ask_clankie",
        arguments: '{"request":"what are you working on?"}',
      },
    });
    expect(events.calls).toEqual([
      { callId: "call_1", name: "ask_clankie", argumentsJson: '{"request":"what are you working on?"}' },
    ]);

    session.submitFunctionResult("call_1", "Reviewing the voice runtime PR.");
    const tail = frames(socket).slice(-2);
    expect(tail[0]).toMatchObject({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: "call_1",
        output: "Reviewing the voice runtime PR.",
      },
    });
    expect(tail[1]).toMatchObject({ type: "response.create" });
  });

  it("seeds a play still as an input_image item", async () => {
    const { session, socket } = await openConversation();
    session.createImageItem("abc");
    expect(frames(socket).at(-1)).toMatchObject({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: "data:image/png;base64,abc" }],
      },
    });
  });

  it("truncates deliberately with the given item id and audio offset", async () => {
    const { session, socket } = await openConversation();
    session.truncate("item_9", 1_250);
    expect(frames(socket).at(-1)).toMatchObject({
      type: "conversation.item.truncate",
      item_id: "item_9",
      content_index: 0,
      audio_end_ms: 1_250,
    });
    expect(() => {
      session.truncate("item_9", -1);
    }).toThrow("non-negative");
    expect(() => {
      session.truncate("item_9", 10.5);
    }).toThrow("non-negative");
  });

  it("enforces the session lifetime cap under the injected clock", async () => {
    const { session, socket, timers, events } = await openConversation({ maxLifetimeMs: 30_000 });
    expect(timers.scheduled[0]?.delayMs).toBe(30_000);
    expect(session.isOpen).toBe(true);

    timers.fire();
    expect(socket.closed).toBe(true);
    expect(events.closes).toEqual(["lifetime"]);
    expect(session.isOpen).toBe(false);
    expect(() => {
      session.createResponse();
    }).toThrow("closed");

    // Audio offered to a closed session is still zeroed before the throw.
    const late = Buffer.from([9, 0, 9, 0]);
    expect(() => {
      session.appendAudio(late);
    }).toThrow("closed");
    expect(late.equals(Buffer.alloc(4))).toBe(true);
  });

  it("sends bounded user text items and instruction updates", async () => {
    const { session, socket } = await openConversation();
    session.createTextItem("James now has the floor.");
    expect(frames(socket).at(-1)).toMatchObject({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "James now has the floor." }],
      },
    });
    expect(() => {
      session.createTextItem("x".repeat(MAX_REALTIME_TEXT_ITEM_CHARACTERS + 1));
    }).toThrow("character limit");
    expect(() => {
      session.createTextItem("   ");
    }).toThrow("non-empty");

    session.updateInstructions("Be Clankie, refreshed.");
    expect(frames(socket).at(-1)).toMatchObject({
      type: "session.update",
      session: { type: "realtime", instructions: "Be Clankie, refreshed." },
    });
  });

  it("reports content-free response metadata", async () => {
    const { socket, events } = await openConversation();
    const pcm = Buffer.from([1, 0, 2, 0]);
    socket.emit({
      type: "response.output_audio.delta",
      response_id: "resp_1",
      item_id: "item_a",
      delta: pcm.toString("base64"),
    });
    socket.emit({
      type: "response.done",
      response: { id: "resp_1", status: "completed", usage: { input_tokens: 100, output_tokens: 42 } },
    });
    expect(events.done).toEqual([
      {
        responseId: "resp_1",
        status: "completed",
        audioBytes: 4,
        textCharacters: 0,
        inputTokens: 100,
        outputTokens: 42,
      },
    ]);
  });

  it("opens without a model mouth in text modality and surfaces bounded text deltas", async () => {
    const texts: { delta: string; itemId: string }[] = [];
    const { socket, events } = await openConversation({
      outputModality: "text",
      onTextDelta: (delta, itemId) => texts.push({ delta, itemId }),
    });
    const update = frames(socket)[0] as {
      session?: { output_modalities?: string[]; audio?: { output?: unknown; input?: unknown } };
    };
    expect(update.session?.output_modalities).toEqual(["text"]);
    // The ears are unchanged; only the mouth is gone (ADR 0070).
    expect(update.session?.audio?.input).toBeDefined();
    expect(update.session?.audio?.output).toBeUndefined();

    socket.emit({
      type: "response.output_text.delta",
      response_id: "resp_1",
      item_id: "item_a",
      delta: "Sure — ",
    });
    socket.emit({
      type: "response.output_text.delta",
      response_id: "resp_1",
      item_id: "item_a",
      delta: "give me a second.",
    });
    expect(texts).toEqual([
      { delta: "Sure — ", itemId: "item_a" },
      { delta: "give me a second.", itemId: "item_a" },
    ]);

    socket.emit({
      type: "response.done",
      response: { id: "resp_1", status: "completed", usage: { input_tokens: 10, output_tokens: 8 } },
    });
    expect(events.done).toEqual([
      {
        responseId: "resp_1",
        status: "completed",
        audioBytes: 0,
        textCharacters: "Sure — give me a second.".length,
        inputTokens: 10,
        outputTokens: 8,
      },
    ]);
  });

  it("fails closed past the per-response text cap, with per-response reset", async () => {
    const texts: string[] = [];
    const { socket, events } = await openConversation({
      outputModality: "text",
      onTextDelta: (delta) => texts.push(delta),
    });
    const nearCap = "x".repeat(MAX_REALTIME_RESPONSE_TEXT_CHARACTERS - 10);
    socket.emit({ type: "response.output_text.delta", response_id: "resp_1", item_id: "a", delta: nearCap });
    socket.emit({ type: "response.done", response: { id: "resp_1", status: "completed" } });
    socket.emit({ type: "response.output_text.delta", response_id: "resp_2", item_id: "b", delta: nearCap });
    expect(events.errors).toHaveLength(0);

    const surfacedBefore = texts.length;
    socket.emit({
      type: "response.output_text.delta",
      response_id: "resp_2",
      item_id: "b",
      delta: "y".repeat(20),
    });
    expect(texts).toHaveLength(surfacedBefore);
    expect(events.errors).toEqual(["Realtime response text exceeded the character limit"]);
    expect(events.closes).toEqual(["error"]);
    expect(socket.closed).toBe(true);
  });

  it("requires a text sink before taking the mouth away", async () => {
    const attempt = openConversation({ outputModality: "text" });
    const failure = await attempt.then(
      () => "unexpectedly opened",
      (error: unknown) => String(error),
    );
    expect(failure).toContain("onTextDelta");
  });

  it("keeps the api key in connection headers and out of frames and errors", async () => {
    const { session, socket, factory } = await openConversation();
    expect(factory[0]?.headers).toEqual({ authorization: "Bearer sk-test-secret" });
    expect(factory[0]?.url).toContain("model=gpt-realtime-2.1");

    session.createTextItem("hello");
    session.createResponse();
    socket.emitError(new Error("transport blew up"));
    for (const raw of socket.sentRaw) expect(raw).not.toContain("sk-test-secret");

    const rejectingFactory: { url: string }[] = [];
    const attempt = openRealtimeConversationSession({
      apiKey: "sk-test-secret",
      instructions: "Be Clankie.",
      baseUrl: "ws://example.com/v1/realtime",
      socketFactory: (url) => {
        rejectingFactory.push({ url });
        return Promise.resolve(new FakeRealtimeSocket());
      },
      onAudioDelta: () => undefined,
    });
    const failure = await attempt.then(
      () => "unexpectedly opened",
      (error: unknown) => String(error),
    );
    expect(failure).toContain("WSS unless it is loopback");
    expect(failure).not.toContain("sk-test-secret");
    expect(rejectingFactory).toHaveLength(0);
  });

  it("allows a loopback ws endpoint for local doubles", async () => {
    const { factory } = await openConversation({ baseUrl: "ws://127.0.0.1:8787/realtime" });
    expect(factory[0]?.url).toContain("ws://127.0.0.1:8787/realtime");
  });

  it("closes idempotently and reports the first reason only", async () => {
    const { session, socket, events } = await openConversation();
    session.close();
    session.close();
    expect(socket.closed).toBe(true);
    expect(events.closes).toEqual(["closed"]);
  });
});

describe("realtime transcription session", () => {
  it("opens as a transcription session and surfaces deltas and completions", async () => {
    const { socket, factory, transcripts } = await openTranscription();
    expect(factory[0]?.url).toContain("intent=transcription");
    expect(frames(socket)[0]).toMatchObject({
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24_000 },
            transcription: { model: "gpt-realtime-whisper", language: "en" },
            turn_detection: null,
          },
        },
      },
    });

    socket.emit({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "item_1",
      delta: "hey ",
    });
    socket.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_1",
      transcript: "hey clankie",
    });
    expect(transcripts).toEqual([
      { itemId: "item_1", text: "hey ", final: false },
      { itemId: "item_1", text: "hey clankie", final: true },
    ]);
  });

  it("bounds surfaced transcript text", async () => {
    const { socket, transcripts } = await openTranscription();
    socket.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_1",
      transcript: "y".repeat(5_000),
    });
    expect(transcripts[0]?.text).toHaveLength(2_000);
    expect(transcripts[0]?.final).toBe(true);
  });

  it("never sends response.create or conversation.item.create, whatever it hears", async () => {
    const { session, socket, transcripts } = await openTranscription();
    const pcm = Buffer.from([1, 0, 2, 0]);
    session.appendAudio(pcm);
    session.commitAudio();
    expect(pcm.equals(Buffer.alloc(4))).toBe(true);

    socket.emit({ type: "input_audio_buffer.speech_started", audio_start_ms: 0, item_id: "item_1" });
    socket.emit({ type: "input_audio_buffer.speech_stopped", audio_end_ms: 700, item_id: "item_1" });
    socket.emit({ type: "input_audio_buffer.committed", item_id: "item_1" });
    socket.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_1",
      transcript: "clankie, are you around?",
    });
    expect(transcripts).toHaveLength(1);

    expect(framesOfType(socket, "response.create")).toHaveLength(0);
    expect(framesOfType(socket, "conversation.item.create")).toHaveLength(0);
    const sentTypes = new Set(frames(socket).map((frame) => frame.type));
    expect([...sentTypes].sort()).toEqual([
      "input_audio_buffer.append",
      "input_audio_buffer.commit",
      "session.update",
    ]);
  });

  it("enforces the lifetime cap and reports the socket closing from the far side", async () => {
    const first = await openTranscription({ maxLifetimeMs: 15_000 });
    expect(first.timers.scheduled[0]?.delayMs).toBe(15_000);
    first.timers.fire();
    expect(first.socket.closed).toBe(true);
    expect(first.closes).toEqual(["lifetime"]);

    const second = await openTranscription();
    second.socket.close();
    expect(second.closes).toEqual(["socket"]);
    expect(second.session.isOpen).toBe(false);
  });
});

describe("xAI voice sessions", () => {
  it("buffers then streams raw PCM after STT readiness and emits utterance-final transcripts", async () => {
    const socket = new FakeRealtimeSocket();
    const transcripts: RealtimeTranscriptEvent[] = [];
    const calls: { url: string; headers: Readonly<Record<string, string>> }[] = [];
    const session = await openXaiStreamingTranscriptionSession({
      apiKey: "xai-secret",
      socketFactory: (url, headers) => {
        calls.push({ url, headers });
        return Promise.resolve(socket);
      },
      timers: new ManualTimers(),
      onTranscript: (event) => transcripts.push(event),
    });
    const pcm = Buffer.from([1, 0, 2, 0]);
    session.appendAudio(pcm);
    expect(pcm.equals(Buffer.alloc(4))).toBe(true);
    expect(socket.sentBinary).toHaveLength(0);
    expect(calls[0]?.url).toContain("wss://api.x.ai/v1/stt");
    expect(calls[0]?.url).toContain("sample_rate=24000");
    expect(calls[0]?.headers).toEqual({ authorization: "Bearer xai-secret" });

    socket.emit({ type: "transcript.created" });
    expect(socket.sentBinary[0]).toEqual(Buffer.from([1, 0, 2, 0]));
    socket.emit({
      type: "transcript.partial",
      text: "hey clankie",
      is_final: true,
      speech_final: true,
    });
    expect(transcripts).toEqual([{ itemId: "xai-stt-1", text: "hey clankie", final: true }]);
  });

  it("configures Grok for explicit text turns and handles xAI function-call events", async () => {
    const calls: RealtimeFunctionCall[] = [];
    const { socket, factory } = await openConversation({
      provider: "xai",
      baseUrl: "wss://api.x.ai/v1/realtime",
      model: "grok-voice-think-fast-2.0",
      voice: "eve",
      reasoningEffort: "none",
      onFunctionCall: (call) => calls.push(call),
    });
    expect(factory[0]?.url).toContain("model=grok-voice-think-fast-2.0");
    expect(frames(socket)[0]).toMatchObject({
      type: "session.update",
      session: {
        voice: "eve",
        reasoning: { effort: "none" },
        turn_detection: null,
        audio: { output: { format: { type: "audio/pcm", rate: 24_000 } } },
      },
    });
    socket.emit({
      type: "response.function_call_arguments.done",
      call_id: "call_xai",
      name: "ask_clankie",
      arguments: '{"request":"what are you doing?"}',
    });
    expect(calls).toEqual([
      {
        callId: "call_xai",
        name: "ask_clankie",
        argumentsJson: '{"request":"what are you doing?"}',
      },
    ]);
  });
});

it.each(["openai", "xai"] as const)(
  "queues overlapping %s responses without waiting for captain tool results",
  async (provider) => {
    const { session, socket } = await openConversation({ provider });
    session.createResponse();
    session.createResponse();
    expect(framesOfType(socket, "response.create")).toHaveLength(1);
    // A tool-calling response is complete even while its handoff is unresolved.
    socket.emit({ type: "response.created", response: { id: "ask" } });
    socket.emit({ type: "response.done", response: { id: "ask", status: "completed" } });
    expect(framesOfType(socket, "response.create")).toHaveLength(2);
    session.submitFunctionResult("ask-call", "Alice's answer");
    expect(framesOfType(socket, "response.create")).toHaveLength(2);
    socket.emit({ type: "response.created", response: { id: "banter" } });
    socket.emit({ type: "response.done", response: { id: "banter", status: "completed" } });
    expect(framesOfType(socket, "response.create")).toHaveLength(3);
    session.createResponse();
    session.close();
    socket.emit({ type: "response.done", response: { id: "answer", status: "completed" } });
    expect(framesOfType(socket, "response.create")).toHaveLength(3);
  },
);

it.each(["openai", "xai"] as const)(
  "drops stale %s response requests but retains their tool results",
  async (provider) => {
    const { session, socket } = await openConversation({ provider });
    let revision = 0;
    session.createResponse();
    session.submitFunctionResult("old", "Useful context", () => revision === 0);
    for (let index = 1; index <= 3; index += 1) {
      revision = index;
      session.createResponse(`turn ${index}`, () => revision === index);
    }
    socket.emit({ type: "response.created", response: { id: "first" } });
    socket.emit({ type: "response.done", response: { id: "first", status: "completed" } });
    expect(framesOfType(socket, "response.create")).toHaveLength(2);
    expect(framesOfType(socket, "conversation.item.create")).toMatchObject([
      { item: { type: "function_call_output", call_id: "old", output: "Useful context" } },
      { item: { content: [{ text: "turn 3" }] } },
    ]);
    socket.emit({ type: "response.created", response: { id: "latest" } });
    socket.emit({ type: "response.done", response: { id: "latest", status: "completed" } });
    session.submitFunctionResult("joined", "Joined the original", false);
    expect(framesOfType(socket, "response.create")).toHaveLength(2);
    session.close();
  },
);

it.each([
  ["audio", 800],
  ["text", 200],
] as const)(
  "gives %s responses a runaway bound that every response inherits",
  async (outputModality, limit) => {
    const { session, socket } = await openConversation({ outputModality, onTextDelta: () => undefined });
    expect(framesOfType(socket, "session.update")[0]).toMatchObject({
      session: { max_output_tokens: limit },
    });
    session.createResponse();
    socket.emit({ type: "response.created", response: { id: "first" } });
    socket.emit({ type: "response.done", response: { id: "first", status: "completed" } });
    session.submitFunctionResult("handoff", "A very long result");
    expect(framesOfType(socket, "response.create")).toHaveLength(2);
    session.close();
  },
);

describe.each(["openai", "xai"] as const)("%s response error recovery", (provider) => {
  it("releases a bare server error for the next offered line exactly once, without replay", async () => {
    const { session, socket, events, factory } = await openConversation({ provider });
    session.createResponse("failed offer");
    socket.emit({ type: "response.created", response: { id: "failed" } });
    socket.emit({ type: "error", error: { type: "server_error", code: "server_error", message: "private" } });
    session.createResponse("next offer");
    expect(framesOfType(socket, "response.create")).toHaveLength(2);
    expect(framesOfType(socket, "conversation.item.create")).toMatchObject([
      { item: { content: [{ text: "failed offer" }] } },
      { item: { content: [{ text: "next offer" }] } },
    ]);
    expect(events.errors).toEqual(["Realtime session error (server_error)"]);
    expect(events.done).toEqual([]);
    expect(factory).toHaveLength(1);
    expect(session.isOpen).toBe(true);
    session.close();
  });

  it("rechecks queued eligibility after the error callback supersedes an offer", async () => {
    let revision = 0;
    const { session, socket } = await openConversation({
      provider,
      onError: () => {
        revision = 1;
      },
    });
    session.createResponse();
    socket.emit({ type: "response.created", response: { id: "first" } });
    session.createResponse("stale", () => revision === 0);
    session.createResponse("current", () => revision === 1);
    socket.emit({ type: "error", error: { type: "server_error" } });
    expect(framesOfType(socket, "response.create")).toHaveLength(2);
    expect(framesOfType(socket, "conversation.item.create")).toMatchObject([
      { item: { content: [{ text: "current" }] } },
    ]);
    session.close();
  });

  it("ignores old terminal events and correlated errors before and after the next response starts", async () => {
    const { session, socket } = await openConversation({ provider });
    session.createResponse();
    const oldEventId = framesOfType(socket, "response.create")[0]?.event_id;
    expect(oldEventId).toEqual(expect.any(String));
    socket.emit({ type: "response.created", response: { id: "old" } });
    session.createResponse();
    session.createResponse();
    socket.emit({ type: "error", error: { type: "server_error" } });
    const oldDone = { type: "response.done", response: { id: "old", status: "failed" } };
    socket.emit(oldDone);
    expect(framesOfType(socket, "response.create")).toHaveLength(2);
    socket.emit({ type: "response.created", response: { id: "new" } });
    socket.emit(oldDone);
    socket.emit({ type: "error", error: { type: "server_error", event_id: oldEventId } });
    expect(framesOfType(socket, "response.create")).toHaveLength(2);
    socket.emit({ type: "response.done", response: { id: "new", status: "completed" } });
    expect(framesOfType(socket, "response.create")).toHaveLength(3);
    session.close();
  });

  it("does not release output for unrelated input errors, but releases a rejected create", async () => {
    const { session, socket, events } = await openConversation({ provider });
    session.createResponse();
    session.createResponse();
    socket.emit({ type: "error", error: { type: "invalid_request_error", code: "invalid_audio" } });
    socket.emit({ type: "error", error: { type: "server_error", event_id: "input-event" } });
    socket.emit({ type: "error", error: { type: "server_error", param: "audio" } });
    expect(framesOfType(socket, "response.create")).toHaveLength(1);
    const eventId = framesOfType(socket, "response.create")[0]?.event_id;
    expect(eventId).toEqual(expect.any(String));
    socket.emit({ type: "error", error: { type: "invalid_request_error", event_id: eventId } });
    expect(framesOfType(socket, "response.create")).toHaveLength(2);
    expect(events.errors).toHaveLength(4);
    session.close();
  });

  it.each([false, true])("defers error-callback offers and honors callback close=%s", async (close) => {
    const { session, socket } = await openConversation({
      provider,
      onError: () => {
        session.createResponse("callback offer");
        socket.emit({ type: "response.done", response: { id: "old", status: "failed" } });
        expect(framesOfType(socket, "response.create")).toHaveLength(1);
        if (close) session.close();
      },
    });
    session.createResponse();
    socket.emit({ type: "response.created", response: { id: "old" } });
    socket.emit({ type: "error", error: { type: "server_error" } });
    expect(framesOfType(socket, "response.create")).toHaveLength(close ? 1 : 2);
    session.close();
  });

  it("does not send an abandoned create after a synchronous context-send error", async () => {
    let failed = false;
    const { session, socket } = await openConversation({
      provider,
      onError: () => {
        session.createResponse("next offer");
      },
    });
    socket.onSend = (frame) => {
      if (frame.type !== "conversation.item.create" || failed) return;
      failed = true;
      socket.emit({ type: "error", error: { type: "server_error" } });
    };
    session.createResponse("failed offer");
    expect(framesOfType(socket, "response.create")).toHaveLength(0);
    expect(session.isOpen).toBe(false);
    socket.emit({ type: "response.created", response: { id: "late-old" } });
    socket.emit({ type: "response.done", response: { id: "late-old", status: "completed" } });
    expect(framesOfType(socket, "response.create")).toHaveLength(0);
    expect(framesOfType(socket, "conversation.item.create")).toHaveLength(1);
    session.close();
  });

  it("keeps a response started by a reentrant done callback active", async () => {
    let reentered = false;
    const { session, socket } = await openConversation({
      provider,
      onResponseDone: (meta) => {
        if (meta.responseId !== "old" || reentered) return;
        reentered = true;
        session.createResponse();
        socket.emit({ type: "response.done", response: { id: "old", status: "completed" } });
        session.createResponse();
      },
    });
    session.createResponse();
    socket.emit({ type: "response.created", response: { id: "old" } });
    socket.emit({ type: "response.done", response: { id: "old", status: "completed" } });
    expect(framesOfType(socket, "response.create")).toHaveLength(2);
    socket.emit({ type: "response.created", response: { id: "new" } });
    socket.emit({ type: "response.done", response: { id: "new", status: "completed" } });
    expect(framesOfType(socket, "response.create")).toHaveLength(3);
    session.close();
  });

  it("serializes a response enqueued inside shouldStart and honors a close inside it", async () => {
    const { session, socket } = await openConversation({ provider });
    session.createResponse("first", () => {
      session.createResponse("second");
      return true;
    });
    expect(framesOfType(socket, "response.create")).toHaveLength(1);
    expect(framesOfType(socket, "conversation.item.create")).toMatchObject([
      { item: { content: [{ text: "first" }] } },
    ]);
    socket.emit({ type: "response.created", response: { id: "first" } });
    socket.emit({ type: "response.done", response: { id: "first", status: "completed" } });
    expect(framesOfType(socket, "response.create")).toHaveLength(2);
    session.createResponse("closed", () => {
      session.close();
      return true;
    });
    socket.emit({ type: "response.created", response: { id: "second" } });
    expect(() =>
      socket.emit({ type: "response.done", response: { id: "second", status: "completed" } }),
    ).not.toThrow();
    expect(framesOfType(socket, "response.create")).toHaveLength(2);
  });
});

it("closes a matched server error before created instead of treating correlation as rejection", async () => {
  const { session, socket, events } = await openConversation();
  session.createResponse();
  session.createResponse();
  const eventId = framesOfType(socket, "response.create")[0]!.event_id;
  socket.emit({ type: "error", error: { type: "server_error", event_id: eventId } });
  expect(session.isOpen).toBe(false);
  expect(framesOfType(socket, "response.create")).toHaveLength(1);
  socket.emit({ type: "response.created", response: { id: "late-old" } });
  socket.emit({ type: "response.done", response: { id: "late-old", status: "completed" } });
  expect(events.done).toEqual([]);
});

it("preserves normal ID-less xAI tools but closes on uncorrelatable post-abandon output", async () => {
  const { session, socket, events } = await openConversation({ provider: "xai" });
  session.createResponse();
  socket.emit({ type: "response.created", response: { id: "old" } });
  const call = {
    type: "response.function_call_arguments.done",
    call_id: "normal",
    name: "ask_clankie",
    arguments: "{}",
  };
  socket.emit(call);
  expect(events.calls).toEqual([{ callId: "normal", name: "ask_clankie", argumentsJson: "{}" }]);
  session.createResponse();
  socket.emit({ type: "error", error: { type: "server_error" } });
  socket.emit({ type: "response.created", response: { id: "new" } });
  socket.emit({ ...call, call_id: "uncertain" });
  expect(events.calls).toHaveLength(1);
  expect(session.isOpen).toBe(false);
  expect(events.errors).toContain("Realtime output could not be attributed to a response");
  expect(events.done).toEqual([]);
});

it.each(["openai", "xai"] as const)(
  "retains identified %s tool calls and drops stale ones",
  async (provider) => {
    const { session, socket, events } = await openConversation({ provider });
    session.createResponse();
    socket.emit({ type: "response.created", response: { id: "current" } });
    const event =
      provider === "openai"
        ? {
            type: "response.output_item.done",
            item: { type: "function_call", call_id: "call", name: "ask_clankie", arguments: "{}" },
          }
        : {
            type: "response.function_call_arguments.done",
            call_id: "call",
            name: "ask_clankie",
            arguments: "{}",
          };
    socket.emit({ ...event, response_id: "old" });
    expect(events.calls).toEqual([]);
    socket.emit({ ...event, response_id: "current" });
    expect(events.calls).toEqual([{ callId: "call", name: "ask_clankie", argumentsJson: "{}" }]);
    session.close();
  },
);

it("ignores transport errors after the realtime session has closed", async () => {
  const { session, socket, events } = await openConversation();
  session.close();
  socket.emitError(new Error("stale transport detail"));
  expect(events.errors).toEqual([]);
  expect(events.closes).toEqual(["closed"]);
});
