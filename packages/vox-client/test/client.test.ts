import { Buffer } from "node:buffer";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  VoxFrameDecoder,
  VoxClientError,
  VoxStderrDecoder,
  VOX_IPC_PROTOCOL_VERSION,
  createVoxClient,
  decodeVoxControlEvent,
  decodeVoxUserAudio,
  decodeVoxVideoFrame,
  resolveVoxBin,
  sanitizeVoxLog,
} from "../src/index.ts";

function framed(format: number, payload: Uint8Array): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt8(format, 0);
  header.writeUInt32LE(payload.byteLength, 1);
  return Buffer.concat([header, payload]);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for Vox fixture");
}

async function createVoxFixture(
  options: {
    processReady?: Record<string, unknown>;
    readStdin?: boolean;
    immediateFollowup?: boolean;
  } = {},
): Promise<{ bin: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "vox-client-test-"));
  const bin = join(directory, "vox-fixture");
  await writeFile(
    bin,
    `#!/usr/bin/env node
const readline = require("node:readline");
function send(format, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  const header = Buffer.alloc(5);
  header.writeUInt8(format, 0);
  header.writeUInt32LE(body.length, 1);
  process.stdout.write(Buffer.concat([header, body]));
}
function audio(userId, captureId) {
  const id = Buffer.from(captureId);
  const body = Buffer.alloc(20 + id.length + 4);
  body.writeBigUInt64LE(BigInt(userId), 0);
  body.writeUInt16LE(700, 8);
  body.writeUInt32LE(1, 10);
  body.writeUInt32LE(2, 14);
  body.writeUInt16LE(id.length, 18);
  id.copy(body, 20);
  body.set([1, 2, 3, 4], 20 + id.length);
  send(1, body);
}
let previousCapture;
send(0, ${JSON.stringify(
      options.processReady ?? {
        type: "process_ready",
        protocolVersion: VOX_IPC_PROTOCOL_VERSION,
      },
    )});
setTimeout(() => send(0, { type: "ready", connectionId: "fixture-connection" }), 5);
${
  options.readStdin === false
    ? "setInterval(() => {}, 1000);"
    : `readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  send(0, { type: "playback_armed", reason: line });
  if (command.type === "subscribe_user") {
    ${
      options.immediateFollowup === true
        ? `if (command.captureId === "capture-old") {
      audio(command.userId, command.captureId);
      send(0, { type: "user_audio_end", userId: command.userId, captureId: command.captureId });
      send(0, { type: "speaking_start", userId: command.userId });
      audio(command.userId, command.captureId);
    } else {
      audio(command.userId, command.captureId);
    }`
        : `if (previousCapture) audio(command.userId, previousCapture);
    audio(command.userId, command.captureId);
    previousCapture = command.captureId;`
    }
  }
  if (command.type === "destroy") process.exit(0);
});`
}
`,
  );
  await chmod(bin, 0o755);
  return { bin, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

describe("Vox client framing", () => {
  it("reassembles split control frames", () => {
    const payload = Buffer.from(
      JSON.stringify({ type: "process_ready", protocolVersion: VOX_IPC_PROTOCOL_VERSION }),
    );
    const input = framed(0, payload);
    const decoder = new VoxFrameDecoder();

    expect(decoder.push(input.subarray(0, 3)).frames).toEqual([]);
    const result = decoder.push(input.subarray(3));

    expect(result.fault).toBeUndefined();
    expect(decodeVoxControlEvent(result.frames[0]!.payload)).toEqual({
      type: "process_ready",
      protocolVersion: VOX_IPC_PROTOCOL_VERSION,
    });
  });

  it("wipes frames received after a decoder protocol fault", () => {
    const decoder = new VoxFrameDecoder();
    const malformedHeader = Buffer.from([2, 0, 0, 0, 0]);
    expect(decoder.push(malformedHeader).fault).toContain("unknown Vox frame format");
    expect([...malformedHeader]).toEqual([0, 0, 0, 0, 0]);

    const unobservedAfterFault = Buffer.from([9, 8, 7, 6]);
    expect(decoder.push(unobservedAfterFault).frames).toEqual([]);
    expect([...unobservedAfterFault]).toEqual([0, 0, 0, 0]);
  });

  it("decodes video and binary user-audio events", () => {
    const video = decodeVoxVideoFrame({
      type: "decoded_video_frame",
      role: "stream_watch",
      userId: "42",
      width: 1920,
      height: 1080,
      jpegBase64: "anBlZw==",
    });
    expect(video).toEqual({
      role: "stream_watch",
      userId: "42",
      width: 1920,
      height: 1080,
      jpegBase64: "anBlZw==",
    });

    const captureId = Buffer.from("capture-7");
    const audio = Buffer.alloc(20 + captureId.length + 4);
    audio.writeBigUInt64LE(42n, 0);
    audio.writeUInt16LE(700, 8);
    audio.writeUInt32LE(1, 10);
    audio.writeUInt32LE(2, 14);
    audio.writeUInt16LE(captureId.length, 18);
    audio.set(captureId, 20);
    audio.set([1, 2, 3, 4], 20 + captureId.length);
    const decodedAudio = decodeVoxUserAudio(audio);
    expect(decodedAudio).toEqual({
      userId: "42",
      captureId: "capture-7",
      signalPeakAbs: 700,
      signalActiveSampleCount: 1,
      signalSampleCount: 2,
      pcm: new Uint8Array([1, 2, 3, 4]),
    });
    expect([...audio]).toEqual(Array(audio.length).fill(0));

    const malformed = Buffer.alloc(20 + captureId.length + 4, 7);
    malformed.writeUInt32LE(1, 10);
    malformed.writeUInt32LE(3, 14);
    malformed.writeUInt16LE(captureId.length, 18);
    expect(decodeVoxUserAudio(malformed)).toBeUndefined();
    expect([...malformed]).toEqual(Array(malformed.length).fill(0));
  });

  it("parses role-scoped positive DAVE readiness", () => {
    expect(
      decodeVoxControlEvent(
        Buffer.from(
          JSON.stringify({
            type: "dave_state",
            role: "stream_watch",
            status: "ready",
            protocolVersion: 1,
          }),
        ),
      ),
    ).toEqual({
      type: "dave_state",
      role: "stream_watch",
      status: "ready",
      protocolVersion: 1,
    });
    expect(
      decodeVoxControlEvent(
        Buffer.from(JSON.stringify({ type: "dave_state", role: "voice", status: "ready" })),
      ),
    ).toBeUndefined();
    expect(
      decodeVoxControlEvent(
        Buffer.from(
          JSON.stringify({
            type: "dave_state",
            role: "voice",
            connectionId: "connection-1",
            status: "ready",
            protocolVersion: 1,
          }),
        ),
      ),
    ).toEqual({
      type: "dave_state",
      role: "voice",
      connectionId: "connection-1",
      status: "ready",
      protocolVersion: 1,
    });
  });

  it("requires transport error scope and parses correlated media starts", () => {
    expect(
      decodeVoxControlEvent(
        Buffer.from(
          JSON.stringify({
            type: "error",
            code: "voice_connect_failed",
            message: "failed",
            role: "voice",
            connectionId: "connection-1",
          }),
        ),
      ),
    ).toMatchObject({ role: "voice", connectionId: "connection-1" });
    expect(
      decodeVoxControlEvent(
        Buffer.from(JSON.stringify({ type: "error", code: "voice_runtime_error", message: "failed" })),
      ),
    ).toBeUndefined();
    expect(
      decodeVoxControlEvent(
        Buffer.from(
          JSON.stringify({
            type: "error",
            code: "voice_runtime_error",
            message: "failed",
            role: "stream_publish",
          }),
        ),
      ),
    ).toMatchObject({ role: "stream_publish" });
    expect(
      decodeVoxControlEvent(
        Buffer.from(
          JSON.stringify({
            type: "error",
            code: "stream_publish_connect_failed",
            message: "failed",
            role: "voice",
            connectionId: "connection-1",
          }),
        ),
      ),
    ).toBeUndefined();
    expect(
      decodeVoxControlEvent(
        Buffer.from(
          JSON.stringify({
            type: "stream_publish_media_started",
            role: "stream_publish",
            connectionGeneration: 4,
            sourceGeneration: 7,
          }),
        ),
      ),
    ).toEqual({
      type: "stream_publish_media_started",
      role: "stream_publish",
      connectionGeneration: 4,
      sourceGeneration: 7,
    });
    expect(
      decodeVoxControlEvent(
        Buffer.from(
          JSON.stringify({
            type: "tts_playback_state",
            playbackId: "playback-1",
            status: "started",
          }),
        ),
      ),
    ).toMatchObject({ status: "started", playbackId: "playback-1" });
  });

  it("writes correlated commands in order, drops stale capture epochs, and unsubscribes listeners", async () => {
    const fixture = await createVoxFixture();
    const commands: Record<string, unknown>[] = [];
    const statuses: string[] = [];
    const audioFrames: string[] = [];
    let voiceReadyEvents = 0;
    let removedListenerCalls = 0;
    const client = createVoxClient({ bin: fixture.bin });
    try {
      client.onStatus((status) => statuses.push(status));
      client.onEvent((event) => {
        if (event.type === "ready") voiceReadyEvents += 1;
        if (event.type === "playback_armed") {
          commands.push(JSON.parse(event.reason) as Record<string, unknown>);
        }
      });
      const unsubscribe = client.onEvent(() => {
        removedListenerCalls += 1;
      });
      unsubscribe();
      client.onUserAudio((frame) => audioFrames.push(frame.captureId));

      await waitFor(() => client.status === "ready");
      client.joinVoice({
        connectionId: "connection-1",
        guildId: "1",
        channelId: "2",
      });
      client.leaveVoice("phase-a-test");
      client.sendAudio({ playbackId: "playback-1", pcmBase64: "AQI=", sampleRate: 24_000 });
      client.finishTtsPlayback("playback-1");
      client.stopTtsPlayback("playback-1");
      client.subscribeUserAudio("42", "capture-old");
      client.subscribeUserAudio("42", "capture-new");
      client.musicPlay({ musicId: "music-1", url: " https://example.com/watch?v=1 " });
      client.musicPause("music-1");
      client.musicSetGain("music-1", 0.25, 300);
      client.musicResume("music-1");
      client.musicStop("music-1");

      await waitFor(() => commands.length === 12 && audioFrames.includes("capture-new"));
      expect(commands).toEqual([
        {
          type: "join",
          connectionId: "connection-1",
          guildId: "1",
          channelId: "2",
          selfMute: false,
        },
        { type: "leave", reason: "phase-a-test" },
        {
          type: "audio",
          playbackId: "playback-1",
          pcmBase64: "AQI=",
          sampleRate: 24_000,
        },
        { type: "finish_tts_playback", playbackId: "playback-1" },
        { type: "stop_tts_playback", playbackId: "playback-1" },
        {
          type: "subscribe_user",
          userId: "42",
          captureId: "capture-old",
          silenceDurationMs: 700,
          sampleRate: 24_000,
        },
        {
          type: "subscribe_user",
          userId: "42",
          captureId: "capture-new",
          silenceDurationMs: 700,
          sampleRate: 24_000,
        },
        {
          type: "music_play",
          musicId: "music-1",
          url: "https://example.com/watch?v=1",
          resolvedDirectUrl: false,
        },
        { type: "music_pause", musicId: "music-1" },
        { type: "music_set_gain", musicId: "music-1", target: 0.25, fadeMs: 300 },
        { type: "music_resume", musicId: "music-1" },
        { type: "music_stop", musicId: "music-1" },
      ]);
      expect(audioFrames).toEqual(["capture-new"]);
      expect(removedListenerCalls).toBe(0);
      await waitFor(() => voiceReadyEvents === 1);
      expect(statuses.filter((status) => status === "ready")).toHaveLength(1);
      expect(client.available).toBe(true);
    } finally {
      client.close();
      await fixture.cleanup();
    }
  });

  it("wipes unobserved and stale audio while isolating synchronous listener PCM", async () => {
    const fixture = await createVoxFixture();
    const commands: Record<string, unknown>[] = [];
    const firstListenerIds: string[] = [];
    const secondListenerPcm: number[][] = [];
    const client = createVoxClient({ bin: fixture.bin });
    try {
      client.onEvent((event) => {
        if (event.type === "playback_armed") {
          commands.push(JSON.parse(event.reason) as Record<string, unknown>);
        }
      });
      await waitFor(() => client.status === "ready");

      client.subscribeUserAudio("42", "capture-unobserved");
      await waitFor(() => commands.some((command) => command.captureId === "capture-unobserved"));

      client.onUserAudio((frame) => {
        firstListenerIds.push(frame.captureId);
        frame.pcm.fill(0);
      });
      client.onUserAudio((frame) => secondListenerPcm.push([...frame.pcm]));
      client.subscribeUserAudio("42", "capture-observed");

      await waitFor(() => secondListenerPcm.length === 1);
      expect(firstListenerIds).toEqual(["capture-observed"]);
      expect(secondListenerPcm).toEqual([[1, 2, 3, 4]]);
    } finally {
      client.close();
      await fixture.cleanup();
    }
  });

  it("disarms an ended capture before an immediate speaking follow-up", async () => {
    const fixture = await createVoxFixture({ immediateFollowup: true });
    const audioFrames: string[] = [];
    const speakingCaptureIds: (string | undefined)[] = [];
    const client = createVoxClient({ bin: fixture.bin });
    try {
      client.onEvent((event) => {
        if (event.type === "speaking_start") {
          speakingCaptureIds.push(event.captureId);
          client.subscribeUserAudio(event.userId, "capture-new");
        }
      });
      client.onUserAudio((frame) => audioFrames.push(frame.captureId));
      await waitFor(() => client.status === "ready");

      client.subscribeUserAudio("42", "capture-old");

      await waitFor(() => audioFrames.includes("capture-new"));
      expect(speakingCaptureIds).toEqual([undefined]);
      expect(audioFrames).toEqual(["capture-old", "capture-new"]);
    } finally {
      client.close();
      await fixture.cleanup();
    }
  });

  it("resolves an owned candidate without requiring environment configuration", () => {
    expect(resolveVoxBin({}, [process.execPath])).toBe(process.execPath);
  });

  it("returns an unavailable missing client for a missing binary", () => {
    const client = createVoxClient({ bin: join(tmpdir(), "definitely-missing-clankvox") });
    expect(client.status).toBe("missing");
    expect(client.available).toBe(false);
    expect(() => client.sendAudio({ playbackId: "missing-playback", pcmBase64: "AQI=" })).toThrow(
      VoxClientError,
    );
  });

  it.each([
    ["missing", { type: "process_ready" }, "protocol version"],
    [
      "mismatched",
      { type: "process_ready", protocolVersion: VOX_IPC_PROTOCOL_VERSION + 1 },
      "protocol mismatch",
    ],
  ])("rejects a %s IPC handshake before commands can be used", async (_label, processReady, detail) => {
    const fixture = await createVoxFixture({ processReady });
    const errors: string[] = [];
    const client = createVoxClient({ bin: fixture.bin, onError: (message) => errors.push(message) });
    try {
      await waitFor(() => client.status === "error");
      expect(client.available).toBe(false);
      expect(client.detail.toLowerCase()).toContain(detail);
      expect(errors).toHaveLength(1);
      expect(() => client.joinVoice({ connectionId: "blocked", guildId: "1", channelId: "2" })).toThrow(
        VoxClientError,
      );
    } finally {
      client.close();
      await fixture.cleanup();
    }
  });

  it("fails closed with playback correlation when reliable stdin backpressure overflows", async () => {
    const fixture = await createVoxFixture({ readStdin: false });
    const client = createVoxClient({ bin: fixture.bin });
    try {
      await waitFor(() => client.status === "ready");
      client.sendAudio({ playbackId: "blocked-playback", pcmBase64: "A".repeat(1_000_000) });

      let overflow: unknown;
      for (let index = 0; index <= 256; index += 1) {
        try {
          client.finishTtsPlayback(`finish-${index}`);
        } catch (error) {
          overflow = error;
          break;
        }
      }

      expect(overflow).toBeInstanceOf(VoxClientError);
      expect(overflow).toMatchObject({
        code: "stdin_queue_overflow",
        correlationId: "finish-256",
      });
      expect(client.status).toBe("error");
      expect(client.available).toBe(false);
    } finally {
      client.close();
      await fixture.cleanup();
    }
  });

  it("redacts transport credentials and signed URLs from child diagnostics", () => {
    expect(
      sanitizeVoxLog(
        'endpoint="stream.discord.gg" session_id=abc token: secret url=https://cdn.example/a?sig=secret connected=true',
      ),
    ).toBe("endpoint=[redacted] session_id=[redacted] token: [redacted] url=[redacted-url] connected=true");
  });

  it("reassembles and splits stderr chunks before sanitizing lines", () => {
    const decoder = new VoxStderrDecoder();

    expect(decoder.push("first token=sec")).toEqual([]);
    expect(decoder.push("ret\r\nsecond\nthird")).toEqual(["first token=secret", "second"]);
    expect(decoder.finish()).toBe("third");
    expect(sanitizeVoxLog("first token=secret")).toBe("first token=[redacted]");
  });
});
