import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  createPlayVoiceListener,
  startPlayVoiceListener,
  type PlayVoiceListener,
  type PlayVoiceListenerEvidence,
} from "../src/listener.ts";
import { PLAY_UTTERANCE_MAX_CHARS, PLAY_VOICE_SCHEMA_VERSION, PlayUtteranceSchema } from "../src/protocol.ts";

const TOKEN = "clankie_play_voice_test_token";

let listener: PlayVoiceListener | undefined;

afterEach(async () => {
  await listener?.close();
  listener = undefined;
});

async function attach(port: number, token = TOKEN): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/play`, {
    headers: { authorization: `Bearer ${token}` },
  });
  await new Promise<void>((resolve, reject) => {
    socket.on("open", resolve);
    socket.on("error", reject);
  });
  return socket;
}

function narration(text: string, deliveryId?: string, respond?: boolean): string {
  return JSON.stringify({
    schemaVersion: PLAY_VOICE_SCHEMA_VERSION,
    type: "narrate",
    text,
    ...(deliveryId === undefined ? {} : { deliveryId }),
    ...(respond === undefined ? {} : { respond }),
  });
}

describe("play voice listener", () => {
  it("refuses to open without a token at all", () => {
    expect(() => createPlayVoiceListener({ token: "  ", narrate: async () => undefined })).toThrow(
      /play_voice_token_required/u,
    );
  });

  it("rejects EADDRINUSE from listen instead of emitting an unhandled server error", async () => {
    const owner = createPlayVoiceListener({ token: TOKEN, narrate: async () => undefined });
    const contender = createPlayVoiceListener({ token: TOKEN, narrate: async () => undefined });
    try {
      const port = await owner.listen(0);
      await expect(contender.listen(port)).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await contender.close();
      await owner.close();
    }
  });

  it("prefers the play journal's delivery id over a minted one", async () => {
    const narrate = vi.fn(async () => undefined);
    const evidence: PlayVoiceListenerEvidence[] = [];
    listener = createPlayVoiceListener({
      token: TOKEN,
      narrate,
      emit: (event) => {
        evidence.push(event);
      },
      idFactory: () => "should-not-use",
    });
    const port = await listener.listen(0);
    const socket = await attach(port);
    socket.send(narration("walked into a wall by the lab", "play-turn-9", false));
    await vi.waitFor(() =>
      expect(narrate).toHaveBeenCalledWith("walked into a wall by the lab", {
        deliveryId: "play-turn-9",
        respond: false,
      }),
    );
    await vi.waitFor(() =>
      expect(evidence).toContainEqual({
        type: "play_narration_submission",
        deliveryId: "play-turn-9",
        attachedCount: 1,
      }),
    );
    socket.close();
  });

  it("hands a narration to the live voice session", async () => {
    const narrate = vi.fn(async () => undefined);
    const evidence: PlayVoiceListenerEvidence[] = [];
    listener = createPlayVoiceListener({
      token: TOKEN,
      narrate,
      emit: (event) => {
        evidence.push(event);
      },
      idFactory: () => "accepted-narration",
    });
    const port = await listener.listen(0);

    const socket = await attach(port);
    socket.send(narration("walked into a wall by the lab"));
    await vi.waitFor(() =>
      expect(narrate).toHaveBeenCalledWith("walked into a wall by the lab", {
        deliveryId: "accepted-narration",
        respond: true,
      }),
    );
    await vi.waitFor(() =>
      expect(evidence).toContainEqual({
        type: "play_narration_submission",
        deliveryId: "accepted-narration",
        attachedCount: 1,
      }),
    );
    socket.close();
  });

  it("rejects a wrong bearer and an unknown path", async () => {
    listener = createPlayVoiceListener({ token: TOKEN, narrate: async () => undefined });
    const port = await listener.listen(0);

    await expect(attach(port, "wrong-token")).rejects.toThrow();
    const wrongPath = new WebSocket(`ws://127.0.0.1:${String(port)}/possessor`, {
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
    listener = createPlayVoiceListener({ token: TOKEN, narrate });
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
    listener = createPlayVoiceListener({ token: TOKEN, narrate });
    const port = await listener.listen(0);

    const socket = await attach(port);
    socket.send("{not json");
    // A presence action play must never reach from this seam.
    socket.send(JSON.stringify({ schemaVersion: 1, type: "join_channel", channelId: "123" }));
    socket.send(JSON.stringify({ schemaVersion: 1, type: "narrate", text: "" }));
    socket.send(narration("real one"));
    await vi.waitFor(() => expect(narrate).toHaveBeenCalledTimes(1));
    expect(narrate).toHaveBeenCalledWith("real one", {
      deliveryId: expect.any(String),
      respond: true,
    });
    socket.close();
  });

  it("pushes utterances to attached play clients and retains nothing for absent ones", async () => {
    listener = createPlayVoiceListener({ token: TOKEN, narrate: async () => undefined });
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
      schemaVersion: PLAY_VOICE_SCHEMA_VERSION,
      type: "utterance",
      text: "james: go left",
    });
    // The dropped line from before the attach is not replayed.
    expect(received).toHaveLength(1);
    socket.close();
  });

  it("bounds the complete attributed wire text and records only valid deliveries", async () => {
    const evidence: PlayVoiceListenerEvidence[] = [];
    listener = createPlayVoiceListener({
      token: TOKEN,
      narrate: async () => undefined,
      emit: (event) => {
        evidence.push(event);
      },
      idFactory: () => "bounded-delivery",
    });
    const port = await listener.listen(0);
    const socket = await attach(port);
    const received: string[] = [];
    socket.on("message", (raw) => received.push(String(raw)));

    const attribution = "james: ";
    const exact = attribution + "x".repeat(PLAY_UTTERANCE_MAX_CHARS - attribution.length);
    const splitSurrogate =
      attribution + "x".repeat(PLAY_UTTERANCE_MAX_CHARS - attribution.length - 1) + "😀 after";
    listener.publishUtterance("   ");
    listener.publishUtterance(exact);
    listener.publishUtterance(splitSurrogate);

    await vi.waitFor(() => expect(received).toHaveLength(2));
    await vi.waitFor(() =>
      expect(evidence.filter((event) => event.type === "play_transcript_delivery")).toHaveLength(2),
    );
    const messages = received.map((raw) => PlayUtteranceSchema.parse(JSON.parse(raw)));
    expect(messages[0]?.text).toBe(exact);
    expect(messages[0]?.text).toHaveLength(PLAY_UTTERANCE_MAX_CHARS);
    expect(messages[1]?.text).toBe(splitSurrogate.slice(0, PLAY_UTTERANCE_MAX_CHARS - 1));
    expect(messages[1]?.text.endsWith("\uD83D")).toBe(false);
    expect(evidence.filter((event) => event.type === "play_transcript_delivery")).toEqual([
      expect.objectContaining({ deliveredCount: 1 }),
      expect.objectContaining({ deliveredCount: 1 }),
    ]);
    socket.close();
    await vi.waitFor(() => expect(listener?.attachedCount).toBe(0));
    listener.publishUtterance("james: nobody attached");
    await vi.waitFor(() =>
      expect(evidence.filter((event) => event.type === "play_transcript_delivery")).toHaveLength(3),
    );
    expect(evidence.filter((event) => event.type === "play_transcript_delivery").at(-1)).toMatchObject({
      attachedCount: 0,
      deliveredCount: 0,
    });
  });

  it("emits only content-free seam lifecycle and delivery evidence", async () => {
    const evidence: PlayVoiceListenerEvidence[] = [];
    const narrate = vi.fn(async () => {
      throw new Error("voice_narration_not_in_channel: private words must not escape");
    });
    let nextId = 0;
    listener = createPlayVoiceListener({
      token: TOKEN,
      narrate,
      room: () => ({ listening: true }),
      emit: (event) => {
        evidence.push(event);
      },
      idFactory: () => `delivery-${String(++nextId)}`,
    });
    const port = await listener.listen(0);
    const socket = await attach(port);

    listener.publishUtterance("james: go left after the desk");
    socket.send(narration("walked into the private laboratory wall"));
    await vi.waitFor(() => expect(evidence.some((event) => event.type === "play_refusal")).toBe(true));

    expect(evidence).toEqual(
      expect.arrayContaining([
        { type: "play_connection", phase: "attached", attachedCount: 1 },
        { type: "play_room", listening: true, attachedCount: 1, deliveredCount: 1 },
        {
          type: "play_transcript_delivery",
          deliveryId: "delivery-1",
          attachedCount: 1,
          deliveredCount: 1,
        },
        {
          type: "play_refusal",
          deliveryId: "delivery-2",
          attachedCount: 1,
          reason: "voice_narration_not_in_channel",
        },
      ]),
    );
    expect(evidence).not.toContainEqual({
      type: "play_narration_submission",
      deliveryId: "delivery-2",
      attachedCount: 1,
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("go left");
    expect(serialized).not.toContain("laboratory wall");
    expect(serialized).not.toContain("private words");
    socket.close();
  });

  it("binds, forwards transcript lines, and stops on request", async () => {
    const events: string[] = [];
    const started = await startPlayVoiceListener({
      token: TOKEN,
      narrate: async () => undefined,
      subscribeTranscript: (onLine) => {
        events.push("subscribed");
        onLine("james: go left");
        return () => {
          events.push("stopped");
        };
      },
      port: 0,
    });
    listener = started.listener;
    expect(started.port).toBeGreaterThan(0);
    expect(events).toEqual(["subscribed"]);
    started.stopTranscript();
    expect(events).toEqual(["subscribed", "stopped"]);
  });
});
