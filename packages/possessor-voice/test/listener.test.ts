import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createPossessorVoiceListener, type PossessorVoiceListener } from "../src/listener.ts";
import { POSSESSOR_VOICE_SCHEMA_VERSION } from "../src/protocol.ts";

const TOKEN = "clankie_possessor_voice_test_token";

let listener: PossessorVoiceListener | undefined;

afterEach(async () => {
  await listener?.close();
  listener = undefined;
});

async function attach(port: number, token = TOKEN): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/possessor`, {
    headers: { authorization: `Bearer ${token}` },
  });
  await new Promise<void>((resolve, reject) => {
    socket.on("open", resolve);
    socket.on("error", reject);
  });
  return socket;
}

function narration(text: string): string {
  return JSON.stringify({ schemaVersion: POSSESSOR_VOICE_SCHEMA_VERSION, type: "narrate", text });
}

describe("possessor voice listener", () => {
  it("refuses to open without a token at all", () => {
    expect(() => createPossessorVoiceListener({ token: "  ", narrate: async () => undefined })).toThrow(
      /possessor_voice_token_required/u,
    );
  });

  it("hands a narration to the live voice session", async () => {
    const narrate = vi.fn(async () => undefined);
    listener = createPossessorVoiceListener({ token: TOKEN, narrate });
    const port = await listener.listen(0);

    const socket = await attach(port);
    socket.send(narration("walked into a wall by the lab"));
    await vi.waitFor(() => expect(narrate).toHaveBeenCalledWith("walked into a wall by the lab"));
    socket.close();
  });

  it("rejects a wrong bearer and an unknown path", async () => {
    listener = createPossessorVoiceListener({ token: TOKEN, narrate: async () => undefined });
    const port = await listener.listen(0);

    await expect(attach(port, "wrong-token")).rejects.toThrow();
    const wrongPath = new WebSocket(`ws://127.0.0.1:${String(port)}/producer`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    await expect(
      new Promise((resolve, reject) => {
        wrongPath.on("open", resolve);
        wrongPath.on("error", reject);
      }),
    ).rejects.toThrow();
  });

  it("survives a narrate failure rather than dropping the connection", async () => {
    const narrate = vi.fn(async () => {
      throw new Error("not in a voice channel");
    });
    listener = createPossessorVoiceListener({ token: TOKEN, narrate });
    const port = await listener.listen(0);

    const socket = await attach(port);
    socket.send(narration("first"));
    await vi.waitFor(() => expect(narrate).toHaveBeenCalledTimes(1));
    socket.send(narration("second"));
    await vi.waitFor(() => expect(narrate).toHaveBeenCalledTimes(2));
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });

  it("ignores off-contract client messages", async () => {
    const narrate = vi.fn(async () => undefined);
    listener = createPossessorVoiceListener({ token: TOKEN, narrate });
    const port = await listener.listen(0);

    const socket = await attach(port);
    socket.send("{not json");
    // A presence action a possessor must never reach from this seam.
    socket.send(JSON.stringify({ schemaVersion: 1, type: "join_channel", channelId: "123" }));
    socket.send(JSON.stringify({ schemaVersion: 1, type: "narrate", text: "" }));
    socket.send(narration("real one"));
    await vi.waitFor(() => expect(narrate).toHaveBeenCalledTimes(1));
    expect(narrate).toHaveBeenCalledWith("real one");
    socket.close();
  });

  it("pushes utterances to attached possessors and retains nothing for absent ones", async () => {
    listener = createPossessorVoiceListener({ token: TOKEN, narrate: async () => undefined });
    const port = await listener.listen(0);

    // Nobody attached: the line is dropped, never queued.
    listener.publishUtterance("james: anyone home");
    expect(listener.attachedCount).toBe(0);

    const socket = await attach(port);
    await vi.waitFor(() => expect(listener?.attachedCount).toBe(1));
    const received: string[] = [];
    socket.on("message", (raw) => received.push(String(raw)));

    listener.publishUtterance("james: go left");
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(JSON.parse(received[0] ?? "{}")).toEqual({
      schemaVersion: POSSESSOR_VOICE_SCHEMA_VERSION,
      type: "utterance",
      text: "james: go left",
    });
    // The dropped line from before the attach is not replayed.
    expect(received).toHaveLength(1);
    socket.close();
  });
});
