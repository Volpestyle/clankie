import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  MAX_ELEVENLABS_CONTEXT_AUDIO_BYTES,
  MAX_ELEVENLABS_OPEN_CONTEXTS,
  MAX_ELEVENLABS_TEXT_APPEND_CHARACTERS,
  openElevenLabsTtsSession,
  type ElevenLabsTtsCloseReason,
  type ElevenLabsTtsSession,
  type ElevenLabsTtsSessionOptions,
} from "../src/elevenlabs-tts.ts";
import type { RealtimeSocket, RealtimeTimers } from "../src/realtime-session.ts";

class FakeSocket implements RealtimeSocket {
  public readonly sentRaw: string[] = [];
  public closed = false;
  private readonly messageHandlers: ((data: string) => void)[] = [];
  private readonly closeHandlers: (() => void)[] = [];
  private readonly errorHandlers: ((error: unknown) => void)[] = [];

  public send(data: string): void {
    this.sentRaw.push(data);
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

class FakeTimers implements RealtimeTimers {
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

  public fire(): void {
    const entry = this.scheduled.find((candidate) => !candidate.cleared && !candidate.fired);
    if (entry === undefined) throw new Error("No armed timer to fire");
    entry.fired = true;
    entry.handler();
  }
}

function frames(socket: FakeSocket): Record<string, unknown>[] {
  return socket.sentRaw.map((raw) => JSON.parse(raw) as Record<string, unknown>);
}

async function openSession(overrides: Partial<ElevenLabsTtsSessionOptions> = {}): Promise<{
  session: ElevenLabsTtsSession;
  socket: FakeSocket;
  timers: FakeTimers;
  factory: { url: string; headers: Record<string, string> }[];
  audio: { pcm: Buffer; contextId: string }[];
  done: string[];
  closes: ElevenLabsTtsCloseReason[];
  errors: string[];
}> {
  const socket = new FakeSocket();
  const timers = new FakeTimers();
  const factory: { url: string; headers: Record<string, string> }[] = [];
  const audio: { pcm: Buffer; contextId: string }[] = [];
  const done: string[] = [];
  const closes: ElevenLabsTtsCloseReason[] = [];
  const errors: string[] = [];
  const session = await openElevenLabsTtsSession({
    apiKey: "xi-test-secret",
    voiceId: "voice_abc123",
    socketFactory: (url, headers) => {
      factory.push({ url, headers: { ...headers } });
      return Promise.resolve(socket);
    },
    timers,
    onAudio: (pcm, contextId) => audio.push({ pcm: Buffer.from(pcm), contextId }),
    onContextDone: (contextId) => done.push(contextId),
    onClose: (reason) => closes.push(reason),
    onError: (message) => errors.push(message),
    ...overrides,
  });
  return { session, socket, timers, factory, audio, done, closes, errors };
}

describe("elevenlabs tts session", () => {
  it("connects to the multi-context endpoint with the pinned 24 kHz format and the key in headers only", async () => {
    const { session, socket, factory } = await openSession();
    expect(factory[0]?.headers).toEqual({ "xi-api-key": "xi-test-secret" });
    const url = factory[0]?.url ?? "";
    expect(url).toContain("/voice_abc123/multi-stream-input");
    expect(url).toContain("model_id=eleven_flash_v2_5");
    expect(url).toContain("output_format=pcm_24000");
    expect(url).toContain("auto_mode=true");
    expect(url).toContain("inactivity_timeout=180");

    session.openContext("ctx-1");
    session.appendText("ctx-1", "hello there");
    socket.emitError(new Error("transport blew up"));
    for (const raw of socket.sentRaw) expect(raw).not.toContain("xi-test-secret");
  });

  it("refuses non-WSS endpoints, allows loopback, and constrains the path-embedded voice id", async () => {
    const attempted: string[] = [];
    const failure = await openElevenLabsTtsSession({
      apiKey: "xi-test-secret",
      voiceId: "voice_abc123",
      baseUrl: "ws://example.com/v1/text-to-speech",
      socketFactory: (url) => {
        attempted.push(url);
        return Promise.resolve(new FakeSocket());
      },
      onAudio: () => undefined,
    }).then(
      () => "unexpectedly opened",
      (error: unknown) => String(error),
    );
    expect(failure).toContain("WSS unless it is loopback");
    expect(failure).not.toContain("xi-test-secret");
    expect(attempted).toHaveLength(0);

    const loopback = await openSession({ baseUrl: "ws://127.0.0.1:8788/v1/text-to-speech" });
    expect(loopback.factory[0]?.url).toContain("ws://127.0.0.1:8788/v1/text-to-speech/voice_abc123");

    const hostile = await openElevenLabsTtsSession({
      apiKey: "xi-test-secret",
      voiceId: "../../admin?x=",
      socketFactory: () => Promise.resolve(new FakeSocket()),
      onAudio: () => undefined,
    }).then(
      () => "unexpectedly opened",
      (error: unknown) => String(error),
    );
    expect(hostile).toContain("voice id");
  });

  it("opens a context with the handshake space and rides voice settings along", async () => {
    const { session, socket } = await openSession({
      voiceSettings: { stability: 0.4, similarityBoost: 0.8, speed: 1.1 },
    });
    session.openContext("ctx-1");
    expect(frames(socket)[0]).toEqual({
      text: " ",
      context_id: "ctx-1",
      voice_settings: { stability: 0.4, similarity_boost: 0.8, speed: 1.1 },
    });

    expect(() => {
      session.openContext("ctx-1");
    }).toThrow("already open");
  });

  it("streams text verbatim, flushes, and closes contexts", async () => {
    const { session, socket } = await openSession();
    session.openContext("ctx-1");
    session.appendText("ctx-1", "Sure — give ");
    session.appendText("ctx-1", "me a second.");
    session.appendText("ctx-1", "");
    session.flush("ctx-1");
    session.closeContext("ctx-1");
    expect(frames(socket).slice(1)).toEqual([
      { text: "Sure — give ", context_id: "ctx-1" },
      { text: "me a second.", context_id: "ctx-1" },
      { text: " ", context_id: "ctx-1", flush: true },
      { context_id: "ctx-1", close_context: true },
    ]);

    expect(() => {
      session.appendText("ctx-1", "late words");
    }).toThrow("not open");
    expect(() => {
      session.appendText("ctx-9", "never opened");
    }).toThrow("not open");
  });

  it("bounds text appends and live contexts", async () => {
    const { session } = await openSession();
    session.openContext("ctx-1");
    expect(() => {
      session.appendText("ctx-1", "x".repeat(MAX_ELEVENLABS_TEXT_APPEND_CHARACTERS + 1));
    }).toThrow("character limit");

    for (let index = 1; index < MAX_ELEVENLABS_OPEN_CONTEXTS; index += 1) {
      session.openContext(`ctx-${(index + 1).toString()}`);
    }
    expect(() => {
      session.openContext("ctx-overflow");
    }).toThrow("open-context limit");
  });

  it("surfaces decoded context audio and completion, and drops late audio for closed contexts", async () => {
    const { session, socket, audio, done } = await openSession();
    session.openContext("ctx-1");
    const pcm = Buffer.from([1, 0, 2, 0]);
    socket.emit({ audio: pcm.toString("base64"), contextId: "ctx-1" });
    expect(audio).toHaveLength(1);
    expect(audio[0]?.contextId).toBe("ctx-1");
    expect(audio[0]?.pcm.equals(pcm)).toBe(true);

    socket.emit({ isFinal: true, contextId: "ctx-1" });
    expect(done).toEqual(["ctx-1"]);

    // Barge-in shape: audio arriving after closeContext is late server
    // output and never reaches playback.
    session.openContext("ctx-2");
    session.closeContext("ctx-2");
    socket.emit({ audio: pcm.toString("base64"), contextId: "ctx-2" });
    expect(audio).toHaveLength(1);
  });

  it("carries sample-splitting chunk boundaries so surfaced PCM is always whole s16le samples", async () => {
    const { session, socket, audio } = await openSession();
    session.openContext("ctx-1");
    // Five bytes: two whole samples surface now, the odd byte is carried.
    socket.emit({ audio: Buffer.from([1, 0, 2, 0, 3]).toString("base64"), contextId: "ctx-1" });
    expect(audio).toHaveLength(1);
    expect(audio[0]?.pcm.equals(Buffer.from([1, 0, 2, 0]))).toBe(true);

    // The carried byte leads the next chunk, re-forming the split sample.
    socket.emit({ audio: Buffer.from([0, 4, 0]).toString("base64"), contextId: "ctx-1" });
    expect(audio).toHaveLength(2);
    expect(audio[1]?.pcm.equals(Buffer.from([3, 0, 4, 0]))).toBe(true);

    // A dangling carry at context end is a truncated sample and never surfaces.
    socket.emit({ audio: Buffer.from([5]).toString("base64"), contextId: "ctx-1" });
    expect(audio).toHaveLength(2);
    socket.emit({ isFinal: true, contextId: "ctx-1" });
    expect(audio).toHaveLength(2);
  });

  it("fails closed past the per-context audio byte cap", async () => {
    const { session, socket, audio, errors, closes } = await openSession();
    session.openContext("ctx-1");
    const nearCap = Buffer.alloc(MAX_ELEVENLABS_CONTEXT_AUDIO_BYTES - 10_000).toString("base64");
    socket.emit({ audio: nearCap, contextId: "ctx-1" });
    expect(errors).toHaveLength(0);

    const surfacedBefore = audio.length;
    socket.emit({ audio: Buffer.alloc(20_000).toString("base64"), contextId: "ctx-1" });
    expect(audio).toHaveLength(surfacedBefore);
    expect(errors).toEqual(["ElevenLabs context audio exceeded the byte limit"]);
    expect(closes).toEqual(["error"]);
    expect(socket.closed).toBe(true);
  });

  it("surfaces only a sanitized code from server error frames", async () => {
    const { socket, errors } = await openSession();
    socket.emit({ error: "quota_exceeded", message: "You said: 'the secret plan is...'" });
    socket.emit({ error: "prose that is far too long to be a machine code ".repeat(4), message: "detail" });
    expect(errors).toEqual(["ElevenLabs session error (quota_exceeded)", "ElevenLabs session error"]);
  });

  it("enforces the session lifetime cap and closes idempotently with close_socket", async () => {
    const first = await openSession({ maxLifetimeMs: 30_000 });
    expect(first.timers.scheduled[0]?.delayMs).toBe(30_000);
    first.timers.fire();
    expect(first.socket.closed).toBe(true);
    expect(first.closes).toEqual(["lifetime"]);
    expect(first.session.isOpen).toBe(false);
    expect(() => {
      first.session.openContext("ctx-1");
    }).toThrow("closed");

    const second = await openSession();
    second.session.openContext("ctx-1");
    second.session.close();
    second.session.close();
    expect(frames(second.socket).at(-1)).toEqual({ close_socket: true });
    expect(second.closes).toEqual(["closed"]);

    const third = await openSession();
    third.socket.close();
    expect(third.closes).toEqual(["socket"]);
  });
});
