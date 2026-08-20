import { describe, expect, it, vi } from "vitest";
import { createPlayVoiceClient, type PlayVoiceSocket } from "../src/client.ts";
import {
  PLAY_NARRATION_MAX_CHARS,
  PLAY_UTTERANCE_MAX_CHARS,
  PLAY_VOICE_SCHEMA_VERSION,
} from "../src/protocol.ts";

/** Controllable stand-in for the `ws` client. */
function fakeSocket(readyState = 1) {
  const listeners = new Map<string, (data?: unknown) => void>();
  return {
    readyState,
    sent: [] as string[],
    send(payload: string) {
      this.sent.push(payload);
    },
    close: vi.fn(),
    on(event: string, listener: (data?: unknown) => void) {
      listeners.set(event, listener);
    },
    fire(event: string, data?: unknown) {
      listeners.get(event)?.(data);
    },
  };
}

describe("play voice client", () => {
  it("presents a bearer token and sends a bounded narration", async () => {
    const socket = fakeSocket();
    const connect = vi.fn(() => socket as unknown as PlayVoiceSocket);
    const client = createPlayVoiceClient({
      url: "ws://127.0.0.1:4323/play",
      token: "play-secret",
      connect,
    });

    expect(connect).toHaveBeenCalledWith("ws://127.0.0.1:4323/play", "play-secret");
    expect(client.connected).toBe(true);

    await client.narrate("  walked into a wall by the lab  ");
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({
      schemaVersion: PLAY_VOICE_SCHEMA_VERSION,
      type: "narrate",
      text: "walked into a wall by the lab",
    });

    await client.narrate("took a step", { deliveryId: "play-turn-3", respond: false });
    expect(JSON.parse(socket.sent[1] ?? "{}")).toEqual({
      schemaVersion: PLAY_VOICE_SCHEMA_VERSION,
      type: "narrate",
      text: "took a step",
      deliveryId: "play-turn-3",
      respond: false,
    });
  });

  it("refuses rather than queues when the bridge is unreachable", async () => {
    const socket = fakeSocket(3);
    const client = createPlayVoiceClient({
      url: "ws://127.0.0.1:4323/play",
      token: "play-secret",
      connect: () => socket as unknown as PlayVoiceSocket,
    });

    await expect(client.narrate("anyone there")).rejects.toThrow(/clankie_speech_unavailable/u);
    expect(socket.sent).toHaveLength(0);
  });

  it("refuses narration past the bound instead of truncating it", async () => {
    const socket = fakeSocket();
    const client = createPlayVoiceClient({
      url: "ws://127.0.0.1:4323/play",
      token: "play-secret",
      connect: () => socket as unknown as PlayVoiceSocket,
    });

    await expect(client.narrate("x".repeat(PLAY_NARRATION_MAX_CHARS + 1))).rejects.toThrow(
      /clankie_speech_too_long/u,
    );
    expect(socket.sent).toHaveLength(0);
  });

  it("delivers room utterances to subscribers and stops on unsubscribe", () => {
    const socket = fakeSocket();
    const client = createPlayVoiceClient({
      url: "ws://127.0.0.1:4323/play",
      token: "play-secret",
      connect: () => socket as unknown as PlayVoiceSocket,
    });

    const heard: string[] = [];
    const unsubscribe = client.subscribe((utterance) => heard.push(utterance));
    socket.fire(
      "message",
      JSON.stringify({
        schemaVersion: PLAY_VOICE_SCHEMA_VERSION,
        type: "utterance",
        text: "james: go left",
      }),
    );
    expect(heard).toEqual(["james: go left"]);

    unsubscribe();
    socket.fire(
      "message",
      JSON.stringify({
        schemaVersion: PLAY_VOICE_SCHEMA_VERSION,
        type: "utterance",
        text: "james: other way",
      }),
    );
    expect(heard).toEqual(["james: go left"]);
  });

  it("ignores malformed and off-contract server messages", () => {
    const socket = fakeSocket();
    const client = createPlayVoiceClient({
      url: "ws://127.0.0.1:4323/play",
      token: "play-secret",
      connect: () => socket as unknown as PlayVoiceSocket,
    });

    const heard: string[] = [];
    client.subscribe((utterance) => heard.push(utterance));
    socket.fire("message", "{not json");
    socket.fire("message", JSON.stringify({ schemaVersion: 1, type: "join_channel", text: "hi" }));
    socket.fire("message", JSON.stringify({ schemaVersion: 99, type: "utterance", text: "hi" }));
    expect(heard).toEqual([]);
  });

  it("accepts the canonical transcript bound and rejects a longer wire message", () => {
    const socket = fakeSocket();
    const client = createPlayVoiceClient({
      url: "ws://127.0.0.1:4323/play",
      token: "play-secret",
      connect: () => socket as unknown as PlayVoiceSocket,
    });
    const heard: string[] = [];
    client.subscribe((utterance) => heard.push(utterance));
    const exact = "x".repeat(PLAY_UTTERANCE_MAX_CHARS);

    socket.fire(
      "message",
      JSON.stringify({ schemaVersion: PLAY_VOICE_SCHEMA_VERSION, type: "utterance", text: exact }),
    );
    socket.fire(
      "message",
      JSON.stringify({
        schemaVersion: PLAY_VOICE_SCHEMA_VERSION,
        type: "utterance",
        text: `${exact}x`,
      }),
    );

    expect(heard).toEqual([exact]);
  });

  it("tracks whether a room is listening, and never treats it as an utterance", () => {
    const socket = fakeSocket();
    const client = createPlayVoiceClient({
      url: "ws://127.0.0.1:4323/play",
      token: "play-secret",
      connect: () => socket as unknown as PlayVoiceSocket,
    });

    const heard: string[] = [];
    client.subscribe((utterance) => heard.push(utterance));
    // Nobody has said anything about a room yet, so play keeps
    // authoring for its own surfaces (ADR 0074).
    expect(client.roomListening).toBe(false);

    socket.fire(
      "message",
      JSON.stringify({
        schemaVersion: PLAY_VOICE_SCHEMA_VERSION,
        type: "room",
        listening: true,
      }),
    );
    expect(client.roomListening).toBe(true);
    expect(heard).toEqual([]);

    socket.fire(
      "message",
      JSON.stringify({
        schemaVersion: PLAY_VOICE_SCHEMA_VERSION,
        type: "room",
        listening: false,
      }),
    );
    expect(client.roomListening).toBe(false);
  });

  it("stops believing a room is listening when the seam drops", () => {
    const sockets = [fakeSocket(), fakeSocket()];
    let index = 0;
    const client = createPlayVoiceClient({
      url: "ws://127.0.0.1:4323/play",
      token: "play-secret",
      connect: () => sockets[index++] as unknown as PlayVoiceSocket,
      setTimeoutImpl: () => undefined,
    });

    sockets[0]?.fire(
      "message",
      JSON.stringify({
        schemaVersion: PLAY_VOICE_SCHEMA_VERSION,
        type: "room",
        listening: true,
      }),
    );
    expect(client.roomListening).toBe(true);

    sockets[0]?.fire("close");
    expect(client.roomListening).toBe(false);
  });

  it("reconnects after a close instead of going permanently silent", () => {
    const sockets = [fakeSocket(), fakeSocket()];
    let index = 0;
    const connect = vi.fn(() => sockets[index++] as unknown as PlayVoiceSocket);
    const scheduled: Array<() => void> = [];
    createPlayVoiceClient({
      url: "ws://127.0.0.1:4323/play",
      token: "play-secret",
      connect,
      setTimeoutImpl: (handler) => scheduled.push(handler),
    });

    sockets[0]?.fire("close");
    expect(scheduled).toHaveLength(1);
    scheduled[0]?.();
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
