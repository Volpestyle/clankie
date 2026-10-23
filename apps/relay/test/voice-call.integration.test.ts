import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { serve, type WebSocketServerLike } from "@hono/node-server";
import { afterEach, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { ClankieSettingsSchema } from "../../../packages/settings/src/index.ts";
import {
  PairingCompleteResponseSchema,
  PairingOfferWireSchema,
  PairingRedeemResponseSchema,
  VOICE_CALL_PATH,
  VoiceCallServerEventSchema,
  type OperatorConversationEventBody,
  type VoiceCallServerEvent,
} from "../../../packages/protocol/src/index.ts";
import {
  createVoiceRealtimePorts,
  parseVoiceRealtimeEnv,
  type RealtimeSocket,
} from "../../../packages/discord-presence-core/src/index.ts";
import { createClankieApp } from "../../clankie/src/app.ts";
import { BodyLeaseRouter } from "../../clankie/src/body-lease-router.ts";
import { BodyLeaseStore } from "../../clankie/src/body-leases.ts";
import { ConversationStore } from "../../clankie/src/captain/conversations.ts";
import { createStubCaptain } from "../../clankie/src/captain/port.ts";
import { voiceCallHandoff, voiceCallTranscript } from "../../clankie/src/captain/voice-call-handoff.ts";
import { composeVoiceLaneInstructions } from "../../clankie/src/captain/voice-lane.ts";
import { LocalCompanionBoundary } from "../../clankie/src/local-companion-boundary.ts";
import { ControlPlaneDeviceAuthorizer } from "../src/device-auth.ts";
import { createVoiceCallUpgrade } from "../src/voice-call.ts";

// A device calls Clankie through the real relay and service: device pairing,
// relay authorization, the call route, the voice body lease, his Discord rooms'
// own voice session, the production realtime port composition and the main
// conversation. Only the provider's socket and the model's answer are scripted.

const CAPTAIN_TOKEN = "isolated-voice-call-captain-token";
const OWNER_TOKEN = "isolated-voice-call-owner-token";
const ANSWER = "It's sunny and 24 degrees in Lisbon.";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until(predicate: () => boolean, description: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out observing ${description}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function origin(server: Server): string {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No fixture TCP listener");
  return `http://127.0.0.1:${address.port}`;
}

function closeServer(server: Server): void {
  cleanups.push(async () => {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  });
}

/** 20 ms frames of 24 kHz mono s16le: a 440 Hz tone at speech level, then silence. */
function utterance(speechMs: number, silenceMs: number): Buffer[] {
  const frames: Buffer[] = [];
  let sample = 0;
  for (let at = 0; at < speechMs + silenceMs; at += 20) {
    const frame = Buffer.alloc(960);
    for (let index = 0; index < 480; index += 1, sample += 1) {
      const level = at < speechMs ? Math.round(8_000 * Math.sin((2 * Math.PI * 440 * sample) / 24_000)) : 0;
      frame.writeInt16LE(level, index * 2);
    }
    frames.push(frame);
  }
  return frames;
}

/**
 * The provider's side of the realtime protocol, scripted: a transcription
 * session transcribes each committed utterance from the queue, and the
 * conversation answers a weather question with `ask_clankie`, a goodbye with
 * `voice_leave`, a function result by speaking it, and anything else with a
 * short spoken line.
 */
class ScriptedProvider {
  public readonly transcripts: string[] = [];
  /** What he says, reply by reply, as the provider's transcript of his audio. */
  public readonly replies: string[] = [];
  /** How long his spoken answer to a handoff runs. */
  public answerMs = 480;
  public readonly functionOutputs: string[] = [];
  public transcribedBytes = 0;
  public readonly sockets: ScriptedSocket[] = [];
  public readonly factory = async (): Promise<RealtimeSocket> => {
    const socket = new ScriptedSocket(this);
    this.sockets.push(socket);
    return socket;
  };
}

class ScriptedSocket implements RealtimeSocket {
  private readonly provider: ScriptedProvider;
  private kind: "transcription" | "conversation" = "conversation";
  private receive: ((data: string) => void) | undefined;
  private closing: (() => void) | undefined;
  private sequence = 0;
  private heard: string[] = [];
  private output: string | undefined;
  private asked = false;
  public closed = false;

  public constructor(provider: ScriptedProvider) {
    this.provider = provider;
  }

  public send(data: string | Uint8Array): void {
    const frame = JSON.parse(typeof data === "string" ? data : Buffer.from(data).toString("utf8")) as {
      type: string;
      session?: { type?: string };
      audio?: string;
      item?: { type: string; output?: string; content?: { text?: string }[] };
    };
    if (frame.type === "session.update")
      this.kind = frame.session?.type === "transcription" ? "transcription" : "conversation";
    if (frame.type === "input_audio_buffer.append")
      this.provider.transcribedBytes += Buffer.from(frame.audio ?? "", "base64").byteLength;
    if (frame.type === "input_audio_buffer.commit" && this.kind === "transcription") {
      const transcript = this.provider.transcripts.shift() ?? "";
      const itemId = `tx_${String(++this.sequence)}`;
      // Streamed like the real transcriber: deltas while it listens, then the whole line.
      const half = Math.ceil(transcript.length / 2);
      for (const delta of [transcript.slice(0, half), transcript.slice(half)])
        if (delta)
          this.later({ type: "conversation.item.input_audio_transcription.delta", item_id: itemId, delta });
      this.later({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: itemId,
        transcript,
      });
    }
    if (frame.type === "conversation.item.create" && frame.item?.type === "function_call_output") {
      this.output = frame.item.output ?? "";
      this.provider.functionOutputs.push(this.output);
    } else if (frame.type === "conversation.item.create")
      this.heard.push(frame.item?.content?.map((part) => part.text ?? "").join("") ?? "");
    if (frame.type === "response.create") setImmediate(() => this.respond());
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closing?.();
  }
  public onMessage(handler: (data: string) => void): void {
    this.receive = handler;
  }
  public onClose(handler: () => void): void {
    this.closing = handler;
  }
  public onError(): void {}

  private respond(): void {
    const id = `resp_${String(++this.sequence)}`;
    const heard = this.heard.join("\n");
    this.heard = [];
    this.emit({ type: "response.created", response: { id } });
    const call = (name: string, args: Record<string, unknown>) => {
      this.emit({
        type: "response.output_item.done",
        response_id: id,
        item: { type: "function_call", call_id: `call_${id}`, name, arguments: JSON.stringify(args) },
      });
      this.emit({ type: "response.done", response: { id, status: "completed" } });
    };
    if (this.output !== undefined) {
      this.output = undefined;
      this.speak(id, this.provider.answerMs);
    } else if (/weather/iu.test(heard) && !this.asked) {
      this.asked = true;
      call("ask_clankie", { request: "What's the weather in Lisbon right now?" });
    } else if (/goodbye/iu.test(heard)) call("voice_leave", {});
    else this.speak(id, 200);
  }

  private speak(id: string, ms: number): void {
    // His words stream as they are generated, ahead of and alongside the audio.
    const words = this.provider.replies.shift() ?? "Mm-hm.";
    for (const delta of words.match(/\S+\s*/gu) ?? [])
      this.emit({
        type: "response.output_audio_transcript.delta",
        response_id: id,
        item_id: `item_${id}`,
        delta,
      });
    this.emit({
      type: "response.output_audio_transcript.done",
      response_id: id,
      item_id: `item_${id}`,
      transcript: words,
    });
    const pcm = Buffer.alloc((24_000 * 2 * ms) / 1_000, 3);
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < pcm.byteLength; offset += 24_000 * 2 * 0.24)
      chunks.push(pcm.subarray(offset, Math.min(pcm.byteLength, offset + 24_000 * 2 * 0.24)));
    for (const chunk of chunks)
      this.emit({
        type: "response.output_audio.delta",
        response_id: id,
        item_id: `item_${id}`,
        delta: chunk.toString("base64"),
      });
    this.emit({ type: "response.done", response: { id, status: "completed" } });
  }

  private later(frame: Record<string, unknown>): void {
    setImmediate(() => this.emit(frame));
  }

  private emit(frame: Record<string, unknown>): void {
    if (!this.closed) this.receive?.(JSON.stringify(frame));
  }
}

/** The device's half: plays what arrives (acknowledging started and drained) and talks. */
class Device {
  public readonly events: VoiceCallServerEvent[] = [];
  public readonly audio = new Map<string, number>();
  public readonly socket: WebSocket;
  public closed = false;
  private playback: string | undefined;

  public constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("close", () => {
      this.closed = true;
    });
    socket.on("message", (data, isBinary) => {
      const bytes = Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]);
      if (isBinary) {
        const id = this.playback;
        if (id === undefined) return;
        if (!this.audio.has(id)) this.ack(id, "started");
        this.audio.set(id, (this.audio.get(id) ?? 0) + bytes.byteLength);
        return;
      }
      const event = VoiceCallServerEventSchema.parse(JSON.parse(bytes.toString("utf8")));
      this.events.push(event);
      if (event.type !== "playback") return;
      if (event.action === "start") this.playback = event.playbackId;
      if (event.action === "finish") this.ack(event.playbackId, "drained");
      if (event.action === "stop") this.ack(event.playbackId, "stopped");
    });
  }

  /** Each line as the device shows it now: the latest text per line, in the order lines began. */
  public lines(): { speaker: string; text: string; final: boolean }[] {
    const lines = new Map<string, { speaker: string; text: string; final: boolean }>();
    for (const event of this.events)
      if (event.type === "transcript")
        lines.set(event.lineId, { speaker: event.speaker, text: event.text, final: event.final });
    return [...lines.values()];
  }

  public states(): string[] {
    return this.events.flatMap((event) => (event.type === "state" ? [event.state] : []));
  }

  public ended(): Extract<VoiceCallServerEvent, { type: "ended" }> | undefined {
    return this.events.find(
      (event): event is Extract<VoiceCallServerEvent, { type: "ended" }> => event.type === "ended",
    );
  }

  public spokenBytes(): number {
    return [...this.audio.values()].reduce((sum, bytes) => sum + bytes, 0);
  }

  public say(speechMs: number): void {
    for (const frame of utterance(speechMs, 700)) this.socket.send(frame, { binary: true });
  }

  public send(event: Record<string, unknown>): void {
    this.socket.send(JSON.stringify({ schemaVersion: 1, ...event }));
  }

  private ack(playbackId: string, status: "started" | "drained" | "stopped"): void {
    if (this.socket.readyState === WebSocket.OPEN) this.send({ type: "playback", playbackId, status });
  }
}

async function fixture(options: { silentPeerMs?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "relay-voice-call-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const shutdown = new AbortController();
  const asked: string[] = [];
  const store = new ConversationStore(join(directory, "conversations"), async (_id, message, publish) => {
    asked.push(message);
    publish({ type: "message", role: "captain", text: ANSWER, streaming: false });
  });
  cleanups.push(async () => {
    shutdown.abort();
    await store.close();
  });
  const leases = new BodyLeaseStore(join(directory, "body-leases"));
  cleanups.push(async () => leases.close());
  const provider = new ScriptedProvider();
  const service = await createClankieApp({
    settings: { load: async () => ClankieSettingsSchema.parse({ schemaVersion: 1 }) },
    eventLogPath: join(directory, "events.jsonl"),
    deviceSessionKey: randomBytes(32),
    authenticateCaptain: async (request) =>
      request.headers.get("authorization") === `Bearer ${CAPTAIN_TOKEN}`
        ? { captainId: "fixture-captain", steerSourceLane: "api" }
        : undefined,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === `Bearer ${OWNER_TOKEN}`
        ? { operatorId: "fixture-owner" }
        : undefined,
    captain: createStubCaptain({
      serveOperatorConversation: (request, authority, signal) =>
        store.serve(request as Parameters<typeof store.serve>[0], authority, signal),
      voiceLaneInstructions: (surface) =>
        composeVoiceLaneInstructions("# Identity\nYou are Clankie.", surface),
      voiceCallHandoff: (input) => voiceCallHandoff(store, shutdown.signal, input),
      voiceCallTranscript: (input) => voiceCallTranscript(store, input),
      mainConversationId: () => store.defaultGlobalConversationId(),
    }),
    bodyLeases: {
      router: new BodyLeaseRouter(leases),
      store: leases,
      confirmStopped: async () => true,
    },
    voiceCall: {
      realtime: async () => ({
        ports: createVoiceRealtimePorts({
          apiKey: "fixture-realtime",
          config: parseVoiceRealtimeEnv({}),
          socketFactory: provider.factory,
        }),
        decayWindowMs: 60_000,
      }),
      ...(options.silentPeerMs === undefined ? {} : { silentPeerMs: options.silentPeerMs }),
    },
  });
  cleanups.push(async () => service.close());
  const server = serve({
    port: 0,
    hostname: "127.0.0.1",
    // The service's primary listener as index.ts composes it, so the call route upgrades through it.
    fetch: new LocalCompanionBoundary().fetch(service.app.fetch),
    websocket: { server: new WebSocketServer({ noServer: true }) as unknown as WebSocketServerLike },
  }) as Server;
  if (!server.listening) await once(server, "listening");
  closeServer(server);
  const control = origin(server);
  const logs: { level: string; message: string; fields: Readonly<Record<string, unknown>> }[] = [];
  const upgrade = createVoiceCallUpgrade({
    authorizeDevice: new ControlPlaneDeviceAuthorizer({ baseUrl: control }),
    serviceUrl: control,
    captainToken: CAPTAIN_TOKEN,
    reauthorizeMs: 100,
    logger: {
      info: (fields, message) => logs.push({ level: "info", message, fields }),
      warn: (fields, message) => logs.push({ level: "warn", message, fields }),
    },
  });
  const relayServer = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  relayServer.on("upgrade", (request, socket, head) => {
    if (!upgrade(request, socket, head)) socket.destroy();
  });
  relayServer.listen(0, "127.0.0.1");
  await once(relayServer, "listening");
  closeServer(relayServer);
  const relay = origin(relayServer).replace("http:", "ws:");

  async function post(path: string, body: unknown, bearer?: string): Promise<unknown> {
    const response = await fetch(`${control}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return response.json();
  }
  async function pair(grants: { chat?: boolean } = {}): Promise<{ id: string; token: string }> {
    const offer = PairingOfferWireSchema.parse(await post("/v1/pairing/offer", {}, OWNER_TOKEN));
    const redeemed = PairingRedeemResponseSchema.parse(
      await post("/v1/pairing/redeem", { code: offer.localCode, device: { name: "Mac", platform: "macos" } }),
    );
    const completed = PairingCompleteResponseSchema.parse(
      await post("/v1/pairing/complete", {
        completionToken: redeemed.completionToken,
        acceptedGrants: { ...redeemed.offeredGrants, ...grants },
      }),
    );
    return { id: completed.deviceId, token: completed.deviceToken };
  }
  async function call(token: string | undefined): Promise<Device> {
    const socket = new WebSocket(
      `${relay}${VOICE_CALL_PATH}`,
      token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } },
    );
    const device = new Device(socket);
    cleanups.push(async () => {
      if (socket.readyState === WebSocket.OPEN) socket.close();
    });
    await once(socket, "open");
    return device;
  }
  /** The status a refused upgrade answers with. */
  async function refusal(token: string | undefined): Promise<number> {
    const socket = new WebSocket(
      `${relay}${VOICE_CALL_PATH}`,
      token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } },
    );
    socket.on("error", () => undefined);
    const [, response] = (await once(socket, "unexpected-response")) as [unknown, { statusCode: number }];
    return response.statusCode;
  }
  async function mainEvents(): Promise<OperatorConversationEventBody[]> {
    const result = await store.serve({
      op: "replay",
      schemaVersion: 1,
      replay: {
        schemaVersion: 1,
        conversationId: store.defaultGlobalConversationId(),
        surfaceClientId: "fixture",
        limit: 100,
      },
    });
    if (result.op !== "replay" || result.result.status !== "page") throw new Error("Main replay failed");
    return result.result.events;
  }
  /** An upgrade that authorizes but never completes: no Sec-WebSocket-Key, so the handshake aborts. */
  async function brokenUpgrade(token: string): Promise<string> {
    const socket = connect(Number(new URL(relay).port), "127.0.0.1");
    await once(socket, "connect");
    socket.write(
      `GET ${VOICE_CALL_PATH} HTTP/1.1\r\nHost: relay\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
        `Sec-WebSocket-Version: 13\r\nAuthorization: Bearer ${token}\r\n\r\n`,
    );
    let answer = "";
    socket.on("data", (chunk: Buffer) => (answer += chunk.toString("utf8")));
    await once(socket, "close");
    return answer;
  }
  return { store, leases, provider, asked, logs, pair, call, refusal, mainEvents, post, brokenUpgrade };
}

it("calls Clankie from a paired device: he greets, hears, acts in the main conversation, speaks, and hangs up cleanly", async () => {
  const f = await fixture();
  const device = await f.call((await f.pair()).token);
  // He answers the call in his own voice before anyone speaks.
  await until(() => device.spokenBytes() > 0, "his greeting");
  expect(device.states()[0]).toBe("connecting");
  expect(f.leases.status("voice")).toMatchObject({ conversationId: f.store.defaultGlobalConversationId() });
  await until(() => device.states().at(-1) === "listening", "listening after the greeting");

  // 600 ms of speech then silence, all at once: the utterance ends before the
  // session has opened its capture and must still arrive whole.
  f.provider.transcripts.push("Clankie, what's the weather in Lisbon?");
  const greeting = device.spokenBytes();
  device.say(600);
  await until(() => f.provider.functionOutputs.length > 0, "the handoff result");
  expect(f.provider.transcribedBytes).toBeGreaterThanOrEqual(24_000 * 2 * 0.6);
  expect(f.provider.functionOutputs[0]).toContain(ANSWER);
  await until(() => device.spokenBytes() >= greeting + 24_000 * 2 * 0.48, "his spoken answer");
  expect(device.states()).toEqual(expect.arrayContaining(["hearing", "thinking", "speaking"]));

  // The ask was a turn in the main conversation, visible there with its answer.
  expect(f.asked).toHaveLength(1);
  expect(f.asked[0]).toContain("live voice call");
  expect(f.asked[0]).toContain("What's the weather in Lisbon right now?");
  const events = await f.mainEvents();
  expect(events).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: "message", role: "captain", text: ANSWER })]),
  );

  device.send({ type: "hangup" });
  await until(() => device.closed, "the call closing");
  expect(device.ended()).toMatchObject({ reason: "hung_up" });
  expect(f.leases.status("voice")).toBeUndefined();
});

it("shows the call in the chat as it is spoken, both sides, and adds nothing when it ends (VUH-2752)", async () => {
  const f = await fixture();
  f.provider.replies.push("Hey! Good to hear you.", "Sure, sounds good to me.");
  const device = await f.call((await f.pair()).token);
  await until(
    () => device.lines().some((line) => line.speaker === "clankie" && line.final),
    "his greeting's line",
  );
  // His words arrived as they were generated, not only once he finished.
  const transcript = device.events.flatMap((event) => (event.type === "transcript" ? [event] : []));
  const greeting = transcript.filter((event) => event.lineId === transcript[0]?.lineId);
  expect(greeting.length).toBeGreaterThan(2);
  expect(greeting.at(-1)).toMatchObject({ text: "Hey! Good to hear you.", final: true });

  f.provider.transcripts.push("Let's grab lunch at noon.");
  device.say(600);
  await until(
    () => device.lines().some((line) => line.speaker === "owner" && line.final),
    "the owner's line",
  );
  const owner = device.events.filter((event) => event.type === "transcript" && event.speaker === "owner");
  // A partial first, then the whole line: the owner sees their words appear as they talk.
  expect(owner.map((event) => event.type === "transcript" && [event.text, event.final])).toEqual([
    ["Let's grab lu", false],
    ["Let's grab lunch at noon.", false],
    ["Let's grab lunch at noon.", true],
  ]);
  await until(
    () => device.lines().filter((line) => line.speaker === "clankie" && line.final).length === 2,
    "his reply's line",
  );

  // Each line is in the main conversation as soon as it closed, in order.
  const said = (await f.mainEvents()).flatMap((event) =>
    event.type === "message" && (event.role === "operator" || event.role === "captain")
      ? [`${event.role}: ${event.text}`]
      : [],
  );
  expect(said).toEqual([
    "captain: Hey! Good to hear you.",
    "operator: Let's grab lunch at noon.",
    "captain: Sure, sounds good to me.",
  ]);
  // Recording a line never ran a turn; the call's voice already answered.
  expect(f.asked).toHaveLength(0);

  device.send({ type: "hangup" });
  await until(() => device.closed, "the call closing");
  expect((await f.mainEvents()).filter((event) => event.type === "message")).toHaveLength(said.length);
});

it("refuses a call while his voice is in a Discord room, and says which room", async () => {
  const f = await fixture();
  const created = await f.store.serve({
    op: "create",
    schemaVersion: 1,
    scope: { kind: "seat", seatId: "fixture-discord-voice" },
    title: "Discord voice · Garden / lounge",
  });
  if (created.op !== "create") throw new Error("Room conversation fixture failed");
  const room = created.conversation.conversationId;
  expect(f.leases.acquire("voice", room, 60_000).outcome).toBe("acquired");
  const device = await f.call((await f.pair()).token);
  await until(() => device.closed, "the refused call closing");
  expect(device.ended()).toEqual({
    schemaVersion: 1,
    type: "ended",
    reason: "voice_busy",
    room: "Discord voice · Garden / lounge",
  });
  // The Discord stay keeps his voice; nothing was opened toward the provider.
  expect(f.leases.status("voice")).toMatchObject({ conversationId: room });
  expect(f.provider.sockets).toHaveLength(0);
});

it("yields when the owner talks over him, and the device drops what it had not played", async () => {
  const f = await fixture();
  f.provider.answerMs = 3_000;
  const device = await f.call((await f.pair()).token);
  await until(() => device.states().at(-1) === "listening" && device.spokenBytes() > 0, "the greeting");
  f.provider.transcripts.push("Clankie, what's the weather in Lisbon?", "wait, hold on");
  device.say(600);
  await until(() => f.provider.functionOutputs.length > 0, "the handoff result");
  const answer = (): string | undefined =>
    device.events
      .flatMap((event) => (event.type === "playback" && event.action === "start" ? [event.playbackId] : []))
      .at(-1);
  const greeting = device.events.find((event) => event.type === "playback")!;
  await until(
    () => answer() !== undefined && answer() !== (greeting.type === "playback" ? greeting.playbackId : ""),
    "his answer starting",
  );
  const playbackId = answer()!;
  await until(() => (device.audio.get(playbackId) ?? 0) > 24_000 * 2 * 0.3, "some of his answer");
  device.say(1_000);
  await until(
    () =>
      device.events.some(
        (event) => event.type === "playback" && event.action === "stop" && event.playbackId === playbackId,
      ),
    "his answer stopping",
  );
  // Paced at speaking speed, most of a three-second answer was never sent.
  expect(device.audio.get(playbackId) ?? 0).toBeLessThan(24_000 * 2 * 2.5);
  device.send({ type: "hangup" });
  await until(() => device.closed, "the call closing");
});

it("an upgrade that never completes closes the call it opened and releases his voice", async () => {
  const f = await fixture();
  const answer = await f.brokenUpgrade((await f.pair()).token);
  expect(answer).toMatch(/^HTTP\/1\.1 400/u);
  // The relay had already opened the call; abandoning the device closes it.
  await until(() => f.provider.sockets.length > 0, "the call it opened");
  await until(
    () => f.leases.status("voice") === undefined && f.provider.sockets.every((socket) => socket.closed),
    "the abandoned call ending",
  );
});

it("a device that goes silent ends the call", async () => {
  const f = await fixture({ silentPeerMs: 600 });
  const device = await f.call((await f.pair()).token);
  // Nothing from the device after its greeting acknowledgements: no microphone frames at all.
  await until(() => device.closed, "the silent call ending");
  expect(device.ended()).toMatchObject({ reason: "failed" });
  expect(f.leases.status("voice")).toBeUndefined();
  expect(f.provider.sockets.every((socket) => socket.closed)).toBe(true);
});

it("lets Clankie end the call himself", async () => {
  const f = await fixture();
  const device = await f.call((await f.pair()).token);
  await until(() => device.states().at(-1) === "listening" && device.spokenBytes() > 0, "the greeting");
  f.provider.transcripts.push("Okay Clankie, goodbye!");
  device.say(500);
  await until(() => device.closed, "his hang-up");
  expect(device.ended()).toMatchObject({ reason: "left" });
  expect(f.leases.status("voice")).toBeUndefined();
});

it("ends the call when the device is revoked, and refuses devices without call authority", async () => {
  const f = await fixture();
  expect(await f.refusal(undefined)).toBe(401);
  expect(await f.refusal("not-a-device-token")).toBe(401);
  const listener = await f.pair({ chat: false });
  expect(await f.refusal(listener.token)).toBe(403);
  const paired = await f.pair();
  const device = await f.call(paired.token);
  await until(() => device.spokenBytes() > 0, "the greeting");
  await f.post(`/v1/devices/${paired.id}/revoke`, {}, OWNER_TOKEN);
  await until(() => device.closed, "the revoked call closing");
  expect(device.ended()).toMatchObject({ reason: "revoked" });
  await until(() => f.leases.status("voice") === undefined, "the voice lease release");
  expect(await f.refusal(paired.token)).toBe(401);
  // The relay says why each upgrade ended the way it did (VUH-2727), naming the device but never its bearer.
  expect(f.logs.map(({ level, message, fields }) => ({ level, message, ...fields }))).toEqual([
    expect.objectContaining({
      message: "voice call relay refused",
      statusCode: 401,
      reason: "device_authentication_required",
    }),
    expect.objectContaining({
      message: "voice call relay refused",
      statusCode: 401,
      reason: "device_invalid",
    }),
    expect.objectContaining({
      message: "voice call relay refused",
      deviceId: listener.id,
      statusCode: 403,
      reason: "voice_call_grant_required",
    }),
    expect.objectContaining({
      level: "info",
      message: "voice call relay connected",
      deviceId: paired.id,
      statusCode: 101,
    }),
    expect.objectContaining({
      message: "voice call relay ended",
      deviceId: paired.id,
      reason: "revoked",
      closedBy: "relay",
      closeCode: 1008,
    }),
    expect.objectContaining({
      message: "voice call relay refused",
      statusCode: 401,
      reason: "device_revoked",
    }),
  ]);
  expect(JSON.stringify(f.logs)).not.toContain(paired.token);
});
