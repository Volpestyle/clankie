import { describe, expect, it, vi } from "vitest";
import { createPossessorVoiceClient, type PossessorVoiceSocket } from "../src/client.ts";
import { POSSESSOR_NARRATION_MAX_CHARS, POSSESSOR_VOICE_SCHEMA_VERSION } from "../src/protocol.ts";

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

describe("possessor voice client", () => {
  it("presents a bearer token and sends a bounded narration", async () => {
    const socket = fakeSocket();
    const connect = vi.fn(() => socket as unknown as PossessorVoiceSocket);
    const client = createPossessorVoiceClient({
      url: "ws://127.0.0.1:4323/possessor",
      token: "possessor-secret",
      connect,
    });

    expect(connect).toHaveBeenCalledWith("ws://127.0.0.1:4323/possessor", "possessor-secret");
    expect(client.connected).toBe(true);

    await client.say("  walked into a wall by the lab  ");
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({
      schemaVersion: POSSESSOR_VOICE_SCHEMA_VERSION,
      type: "narrate",
      text: "walked into a wall by the lab",
    });
  });

  it("refuses rather than queues when the bridge is unreachable", async () => {
    const socket = fakeSocket(3);
    const client = createPossessorVoiceClient({
      url: "ws://127.0.0.1:4323/possessor",
      token: "possessor-secret",
      connect: () => socket as unknown as PossessorVoiceSocket,
    });

    await expect(client.say("anyone there")).rejects.toThrow(/clankie_speech_unavailable/u);
    expect(socket.sent).toHaveLength(0);
  });

  it("refuses narration past the bound instead of truncating it", async () => {
    const socket = fakeSocket();
    const client = createPossessorVoiceClient({
      url: "ws://127.0.0.1:4323/possessor",
      token: "possessor-secret",
      connect: () => socket as unknown as PossessorVoiceSocket,
    });

    await expect(client.say("x".repeat(POSSESSOR_NARRATION_MAX_CHARS + 1))).rejects.toThrow(
      /clankie_speech_too_long/u,
    );
    expect(socket.sent).toHaveLength(0);
  });

  it("delivers room utterances to subscribers and stops on unsubscribe", () => {
    const socket = fakeSocket();
    const client = createPossessorVoiceClient({
      url: "ws://127.0.0.1:4323/possessor",
      token: "possessor-secret",
      connect: () => socket as unknown as PossessorVoiceSocket,
    });

    const heard: string[] = [];
    const unsubscribe = client.subscribe((utterance) => heard.push(utterance));
    socket.fire(
      "message",
      JSON.stringify({
        schemaVersion: POSSESSOR_VOICE_SCHEMA_VERSION,
        type: "utterance",
        text: "james: go left",
      }),
    );
    expect(heard).toEqual(["james: go left"]);

    unsubscribe();
    socket.fire(
      "message",
      JSON.stringify({
        schemaVersion: POSSESSOR_VOICE_SCHEMA_VERSION,
        type: "utterance",
        text: "james: other way",
      }),
    );
    expect(heard).toEqual(["james: go left"]);
  });

  it("ignores malformed and off-contract server messages", () => {
    const socket = fakeSocket();
    const client = createPossessorVoiceClient({
      url: "ws://127.0.0.1:4323/possessor",
      token: "possessor-secret",
      connect: () => socket as unknown as PossessorVoiceSocket,
    });

    const heard: string[] = [];
    client.subscribe((utterance) => heard.push(utterance));
    socket.fire("message", "{not json");
    socket.fire("message", JSON.stringify({ schemaVersion: 1, type: "join_channel", text: "hi" }));
    socket.fire("message", JSON.stringify({ schemaVersion: 99, type: "utterance", text: "hi" }));
    expect(heard).toEqual([]);
  });

  it("reconnects after a close instead of going permanently silent", () => {
    const sockets = [fakeSocket(), fakeSocket()];
    let index = 0;
    const connect = vi.fn(() => sockets[index++] as unknown as PossessorVoiceSocket);
    const scheduled: Array<() => void> = [];
    createPossessorVoiceClient({
      url: "ws://127.0.0.1:4323/possessor",
      token: "possessor-secret",
      connect,
      setTimeoutImpl: (handler) => scheduled.push(handler),
    });

    sockets[0]?.fire("close");
    expect(scheduled).toHaveLength(1);
    scheduled[0]?.();
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
