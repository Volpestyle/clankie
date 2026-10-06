import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { afterEach, expect, it } from "vitest";
import { ClankieSettingsSchema } from "../../../packages/settings/src/index.ts";
import {
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  OperatorConversationServiceRequestSchema,
  OperatorConversationServiceResultSchema,
  OperatorConversationStreamEventSchema,
  PairingCompleteResponseSchema,
  PairingOfferWireSchema,
  PairingRedeemResponseSchema,
  type OperatorConversationReplayPage,
  type OperatorConversationServiceRequest,
  type ReplayOperatorConversationRequest,
  type ReplayOperatorConversationResult,
} from "../../../packages/protocol/src/index.ts";
import { parseHerdrSeatTranscript } from "../../../packages/agent-transcript/src/index.ts";
import { createClankieApp } from "../../clankie/src/app.ts";
import { ConversationStore } from "../../clankie/src/captain/conversations.ts";
import { createStubCaptain } from "../../clankie/src/captain/port.ts";
import { nativeConversationPage } from "../../clankie/src/captain/native-conversation.ts";
import nativeCodex from "../../clankie/test/fixtures/codex-subagents.json" with { type: "json" };
import { ControlPlaneDeviceAuthorizer } from "../src/device-auth.ts";
import { createCaptainConversationDispatch } from "../src/conversation-upstream.ts";
import {
  createOperatorConversationRelayHandler,
  OPERATOR_CONVERSATION_TAIL_PATH,
} from "../src/operator-conversations.ts";

const CAPTAIN_TOKEN = "isolated-tail-fixture-captain-token";
const OWNER_TOKEN = "isolated-tail-fixture-owner-token";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// All clocks and network connections are real. These waits observe HTTP effects,
// not the hub's private cache, subscribers, timers or conversation-store listeners.
async function until(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out observing ${description}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
function observed<T>(promise: Promise<T>): Promise<T> {
  // A deliberately cancelled request may reject while another HTTP observation
  // is awaited. Retain its rejection for the assertion without an unhandled turn.
  void promise.catch(() => undefined);
  return promise;
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
async function listener(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<unknown>,
): Promise<string> {
  const server = createServer((request, response) => {
    void handler(request, response).catch(() => {
      if (!response.destroyed) {
        response.statusCode = 500;
        response.end();
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  closeServer(server);
  return origin(server);
}
interface Device {
  readonly id: string;
  readonly token: string;
}
interface UpstreamRequest {
  readonly request: OperatorConversationServiceRequest;
  aborted: boolean;
}
interface AuthorizationTransport {
  readonly startedAt: number;
  durationMs?: number;
  status?: number;
  errorName?: string;
  abortReason?: string;
}
function page(result: ReplayOperatorConversationResult): OperatorConversationReplayPage {
  if (result.status !== "page") throw new Error(`Expected page, got ${result.code}`);
  return result;
}
function messages(result: OperatorConversationReplayPage): string[] {
  return result.events.flatMap((event) => (event.type === "message" ? [event.text] : []));
}
function input(
  conversationId: string,
  surfaceClientId: string,
  cursor?: string,
  options: Partial<ReplayOperatorConversationRequest> = {},
): ReplayOperatorConversationRequest {
  return {
    schemaVersion: 1,
    conversationId,
    surfaceClientId,
    waitMs: 5_000,
    limit: 50,
    ...(cursor === undefined ? {} : { cursor }),
    ...options,
  };
}

async function fixture(options: { tailMaxPages?: number } = { tailMaxPages: 1 }) {
  const directory = await mkdtemp(join(tmpdir(), "relay-shared-tail-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const shutdown = new AbortController();
  const store = new ConversationStore(join(directory, "conversations"), async () => {
    throw new Error("A read-only tail fixture must never start a model turn");
  });
  cleanups.push(async () => {
    shutdown.abort();
    await store.close();
  });
  const seats = new Map<string, string>();
  const nativeSources = new Map<string, { path: string; status: "idle" | "working" }>();
  async function create(name: string) {
    const result = await store.serve({
      op: "create",
      schemaVersion: 1,
      scope: name === "global" ? { kind: "global" } : { kind: "seat", seatId: `fixture-${name}` },
      title: name,
    });
    if (result.op !== "create") throw new Error("Conversation creation failed");
    const id = result.conversation.conversationId;
    if (name !== "global") seats.set(id, `fixture-${name}`);
    return id;
  }
  // publishHeadEvent addresses the guaranteed default head, rather than a
  // separately created global conversation.
  const id = store.defaultGlobalConversationId();
  const requests: UpstreamRequest[] = [];
  const authorizationReads = new Map<string, number>();
  const tokens = new Map<string, string>();
  const active = new Map<string, number>();
  const maximum = new Map<string, number>();
  let activeTotal = 0;
  let maximumTotal = 0;

  async function nativeRead(request: ReplayOperatorConversationRequest) {
    const source = nativeSources.get(request.conversationId)!;
    const jsonl = await readFile(source.path, "utf8");
    const header = JSON.parse(jsonl.split("\n")[0]!) as { payload: { id: string } };
    return nativeConversationPage(
      store.conversation(request.conversationId)!,
      { sessionKey: `codex:${header.payload.id}`, entries: parseHerdrSeatTranscript("codex", jsonl) },
      source.status,
      request,
    );
  }
  const service = await createClankieApp({
    settings: { load: async () => ClankieSettingsSchema.parse({ schemaVersion: 1 }) },
    eventLogPath: join(directory, "devices.jsonl"),
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
      async serveOperatorConversation(request, authority, readSignal) {
        if (request.op === "tail" || request.op === "replay") {
          const selection = request.op === "tail" ? request.tail : request.replay;
          if (nativeSources.has(selection.conversationId)) {
            // The authority port uses the real native parser/page formatter. A
            // journal change wakes the real store's cancellable read wait; no
            // harness process or model is needed to exercise opaque cursor flow.
            const deadline = Date.now() + (request.op === "tail" ? (selection.waitMs ?? 0) : 0);
            for (;;) {
              readSignal?.throwIfAborted();
              // Native hashes are not the store's numeric event addresses.
              const numeric = await store.serve({
                op: "replay",
                schemaVersion: 1,
                replay: { ...selection, cursor: undefined },
              });
              if (numeric.op !== "replay" || numeric.result.status !== "page")
                throw new Error("Native fixture change source unavailable");
              const result = await nativeRead(selection);
              if (
                result.status !== "page" ||
                result.events.length > 0 ||
                result.hasMore ||
                Date.now() >= deadline
              )
                return { op: request.op, schemaVersion: 1, result };
              // Evaluate the actual selected file after capturing the wake
              // anchor, so an append cannot fall between observation and park.
              await store.serve(
                {
                  op: "tail",
                  schemaVersion: 1,
                  tail: {
                    ...selection,
                    cursor: numeric.result.safeCursor,
                    liveSequence: numeric.result.live?.sequence ?? 0,
                    waitMs: Math.max(0, deadline - Date.now()),
                  },
                },
                authority,
                readSignal,
              );
            }
          }
        }
        return store.serve(request as Parameters<typeof store.serve>[0], authority, readSignal);
      },
    }),
  });
  cleanups.push(async () => service.close());
  const server = serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/v1/devices/self") {
        const deviceId = tokens.get(request.headers.get("authorization")?.slice("Bearer ".length) ?? "");
        if (deviceId !== undefined)
          authorizationReads.set(deviceId, (authorizationReads.get(deviceId) ?? 0) + 1);
      }
      if (path !== OPERATOR_CONVERSATION_DISPATCH_PATH) return service.app.fetch(request);
      const body = OperatorConversationServiceRequestSchema.parse(await request.clone().json());
      const record: UpstreamRequest = { request: body, aborted: false };
      requests.push(record);
      const parked = body.op === "tail" && (body.tail.waitMs ?? 0) > 0;
      const conversationId = body.op === "tail" ? body.tail.conversationId : undefined;
      if (parked && conversationId !== undefined) {
        const count = (active.get(conversationId) ?? 0) + 1;
        active.set(conversationId, count);
        maximum.set(conversationId, Math.max(maximum.get(conversationId) ?? 0, count));
        maximumTotal = Math.max(maximumTotal, ++activeTotal);
      }
      const cancelled = () => {
        record.aborted = true;
      };
      request.signal.addEventListener("abort", cancelled, { once: true });
      try {
        return await service.app.fetch(request);
      } finally {
        request.signal.removeEventListener("abort", cancelled);
        if (parked && conversationId !== undefined) {
          active.set(conversationId, active.get(conversationId)! - 1);
          activeTotal--;
        }
      }
    },
  }) as Server;
  if (!server.listening) await once(server, "listening");
  closeServer(server);
  const control = origin(server);
  const authorizationTransport: AuthorizationTransport[] = [];
  const authorizeFetch: typeof globalThis.fetch = async (request, init) => {
    const record: AuthorizationTransport = { startedAt: performance.now() };
    authorizationTransport.push(record);
    try {
      const response = await globalThis.fetch(request, init);
      record.status = response.status;
      return response;
    } catch (error) {
      record.errorName = error instanceof Error ? error.name : typeof error;
      const reason: unknown = init?.signal?.reason;
      if (reason !== undefined) record.abortReason = reason instanceof Error ? reason.name : typeof reason;
      throw error;
    } finally {
      record.durationMs = performance.now() - record.startedAt;
    }
  };
  const handler = createOperatorConversationRelayHandler({
    authorizeDevice: new ControlPlaneDeviceAuthorizer({ baseUrl: control, fetch: authorizeFetch }),
    dispatch: createCaptainConversationDispatch({ baseUrl: control, bearerToken: CAPTAIN_TOKEN }),
    ...options,
  });
  const relay = await listener(handler);
  async function post(path: string, body: unknown, bearer?: string) {
    const response = await fetch(`${control}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
      },
      body: JSON.stringify(body),
      signal: shutdown.signal,
    });
    expect(response.status).toBe(200);
    return response.json();
  }
  async function pair(name: string): Promise<Device> {
    const offer = PairingOfferWireSchema.parse(await post("/v1/pairing/offer", {}, OWNER_TOKEN));
    const redeemed = PairingRedeemResponseSchema.parse(
      await post("/v1/pairing/redeem", { code: offer.localCode, device: { name, platform: "ios" } }),
    );
    const completed = PairingCompleteResponseSchema.parse(
      await post("/v1/pairing/complete", {
        completionToken: redeemed.completionToken,
        acceptedGrants: redeemed.offeredGrants,
      }),
    );
    tokens.set(completed.deviceToken, completed.deviceId);
    return { id: completed.deviceId, token: completed.deviceToken };
  }
  function raw(
    device: Device,
    selection: ReplayOperatorConversationRequest,
    streaming = false,
    signal?: AbortSignal,
  ) {
    return observed(
      fetch(`${relay}${streaming ? OPERATOR_CONVERSATION_TAIL_PATH : OPERATOR_CONVERSATION_DISPATCH_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${device.token}`, "content-type": "application/json" },
        body: JSON.stringify({ op: "tail", schemaVersion: 1, tail: selection }),
        signal: signal === undefined ? shutdown.signal : AbortSignal.any([signal, shutdown.signal]),
      }),
    );
  }
  function tail(device: Device, selection: ReplayOperatorConversationRequest, signal?: AbortSignal) {
    return observed(
      (async () => {
        const response = await raw(device, selection, false, signal);
        expect(response.status).toBe(200);
        const result = OperatorConversationServiceResultSchema.parse(await response.json());
        if (result.op !== "tail") throw new Error("Wrong tail response");
        return result.result;
      })(),
    );
  }
  async function stream(device: Device, selection: ReplayOperatorConversationRequest) {
    const controller = new AbortController();
    const response = await raw(device, selection, true, controller.signal);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let eventsRead = 0;
    const close = async () => {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    };
    cleanups.push(close);
    return {
      close,
      async nextEvent() {
        const timeout = setTimeout(() => controller.abort(new Error("No NDJSON event within 3s")), 3_000);
        try {
          while (!buffered.includes("\n")) {
            const part = await reader.read();
            if (part.done) throw new Error("NDJSON ended before its expected event");
            buffered += decoder.decode(part.value, { stream: true });
          }
          const boundary = buffered.indexOf("\n");
          const frame = JSON.parse(buffered.slice(0, boundary)) as { kind: string; event?: unknown };
          buffered = buffered.slice(boundary + 1);
          expect(
            frame.kind,
            JSON.stringify({
              frame,
              eventsRead,
              authorizationTransport: authorizationTransport.slice(-12),
              longestAuthorizationMs: Math.max(...authorizationTransport.map((read) => read.durationMs ?? 0)),
              transportErrors: authorizationTransport.filter((read) => read.errorName !== undefined),
            }),
          ).toBe("event");
          eventsRead++;
          return OperatorConversationStreamEventSchema.parse(frame.event);
        } finally {
          clearTimeout(timeout);
        }
      },
    };
  }
  async function replay(conversationId: string, options: Partial<ReplayOperatorConversationRequest> = {}) {
    const selection = input(conversationId, "authority", undefined, { waitMs: 0, ...options });
    if (nativeSources.has(conversationId)) return page(await nativeRead(selection));
    const result = await store.serve({
      op: "replay",
      schemaVersion: 1,
      replay: selection,
    });
    if (result.op !== "replay") throw new Error("Wrong authoritative replay");
    return page(result.result);
  }
  function publish(conversationId: string, text: string) {
    const body = { type: "message" as const, role: "captain" as const, text, streaming: false as const };
    if (conversationId === id) store.publishHeadEvent(body);
    else store.publishSeatEvent(seats.get(conversationId)!, body);
  }
  async function joined(devices: readonly Device[], conversationIds: readonly string[]) {
    await until(
      () =>
        devices.every((device) => (authorizationReads.get(device.id) ?? 0) >= 2) &&
        conversationIds.every((value) => active.get(value) === 1),
      "paired readers and parked upstream HTTP tails",
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  async function native() {
    const conversationId = await create("native");
    const path = join(directory, "native.jsonl");
    const source = { path, status: "idle" as "idle" | "working" };
    nativeSources.set(conversationId, source);
    let sessionId = nativeCodex.parent.payload.id;
    let texts: string[] = [];
    let changes = 0;
    async function write() {
      // Parent/session metadata comes from inspected native Codex 0.160.0
      // rollouts; response_item message shapes match the native history fixture.
      const records = [
        { ...nativeCodex.parent, payload: { ...nativeCodex.parent.payload, id: sessionId } },
        ...texts.map((text, index) => ({
          timestamp: new Date(Date.parse("2026-10-04T17:20:00Z") + index * 1_000).toISOString(),
          type: "response_item",
          payload: {
            type: "message",
            id: `message-${index}`,
            role: "assistant",
            content: [{ type: "output_text", text }],
          },
        })),
      ];
      await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
      store.setLiveDraft(conversationId, `source-change-${++changes}`);
    }
    texts = ["Native one", "Native two", "Native three"];
    await write();
    return {
      id: conversationId,
      async append(text: string) {
        texts.push(text);
        await write();
      },
      async appendMany(additions: readonly string[]) {
        texts.push(...additions);
        await write();
      },
      activity(status: "idle" | "working") {
        source.status = status;
        store.setLiveDraft(conversationId, `source-change-${++changes}`);
      },
      journal: () => readFile(path, "utf8"),
      async replace() {
        sessionId = randomUUID();
        texts = ["Replacement session"];
        await write();
      },
    };
  }
  return {
    id,
    store,
    create,
    pair,
    raw,
    tail,
    stream,
    replay,
    publish,
    joined,
    native,
    requests,
    authorizationTransport,
    active,
    maximum,
    maximumTotal: () => maximumTotal,
    revoke: (device: Device) => post(`/v1/devices/${device.id}/revoke`, {}, OWNER_TOKEN),
  };
}

it("three paired devices share one parked HTTP tail across JSON and NDJSON, preserving events and surface IDs", async () => {
  const f = await fixture();
  const devices = await Promise.all([f.pair("iPhone"), f.pair("iPad"), f.pair("Desktop")]);
  const cursor = (await f.replay(f.id)).safeCursor;
  const phone = f.tail(devices[0]!, input(f.id, "phone", cursor));
  const tablet = f.tail(devices[1]!, input(f.id, "tablet", cursor));
  const stream = f.raw(devices[2]!, input(f.id, "desktop", cursor), true);
  await f.joined(devices, [f.id]);
  f.publish(f.id, "Shared native-independent event");
  const [phonePage, tabletPage, response] = await Promise.all([phone, tablet, stream]);
  const a = page(phonePage),
    b = page(tabletPage);
  expect(a.surfaceClientId).toBe("phone");
  expect(b.surfaceClientId).toBe("tablet");
  expect(a.events).toEqual(b.events);
  expect(messages(a)).toEqual(["Shared native-independent event"]);
  expect(response.status).toBe(200);
  const frames = (await response.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(frames).toEqual(a.events.map((event) => ({ kind: "event", event })));
  expect(f.maximum.get(f.id)).toBe(1);
  expect(f.maximumTotal()).toBe(1);
});

it("parks one upstream HTTP request for each of two conversations", async () => {
  const f = await fixture();
  const other = await f.create("other");
  const devices = await Promise.all([f.pair("One"), f.pair("Two"), f.pair("Three"), f.pair("Four")]);
  const requests = devices.map((device, index) => {
    const id = index < 2 ? f.id : other;
    return f
      .replay(id)
      .then((snapshot) => f.tail(device, input(id, `surface-${index}`, snapshot.safeCursor)));
  });
  await f.joined(devices, [f.id, other]);
  expect(f.maximumTotal()).toBe(2);
  f.publish(f.id, "First conversation");
  f.publish(other, "Second conversation");
  const results = await Promise.all(requests);
  results.forEach((result, index) => {
    expect(page(result).surfaceClientId).toBe(`surface-${index}`);
    expect(messages(page(result))).toEqual([index < 2 ? "First conversation" : "Second conversation"]);
  });
  expect(f.maximum.get(f.id)).toBe(1);
  expect(f.maximum.get(other)).toBe(1);
});

it("serves divergent older cursors and reconnect limits with immediate authoritative replay while the current reader stays parked", async () => {
  const f = await fixture();
  const devices = await Promise.all([f.pair("Current"), f.pair("History")]);
  for (const text of ["One", "Two", "Three", "Four"]) f.publish(f.id, text);
  const snapshot = await f.replay(f.id);
  const current = f.tail(devices[0]!, input(f.id, "current", snapshot.safeCursor));
  await f.joined([devices[0]!], [f.id]);
  const oldCursor = snapshot.events[0]!.cursor;
  const older = page(await f.tail(devices[1]!, input(f.id, "history", oldCursor, { waitMs: 0, limit: 2 })));
  expect(older.surfaceClientId).toBe("history");
  expect(older.events).toEqual(snapshot.events.slice(1, 3));
  expect(older.hasMore).toBe(true);
  const reconnect = page(
    await f.tail(devices[1]!, input(f.id, "reconnected", older.nextCursor, { waitMs: 0, limit: 1 })),
  );
  expect(reconnect.surfaceClientId).toBe("reconnected");
  expect(reconnect.events).toEqual(snapshot.events.slice(3, 4));
  expect(
    f.requests.some(
      ({ request }) =>
        request.op === "replay" && request.replay.cursor === oldCursor && (request.replay.waitMs ?? 0) === 0,
    ),
  ).toBe(true);
  expect(f.active.get(f.id)).toBe(1);
  f.publish(f.id, "After history read");
  expect(messages(page(await current))).toEqual(["After history read"]);
  expect(f.maximum.get(f.id)).toBe(1);
});

it("treats native hash cursors as opaque identities for history, reconnect and shared new events", async () => {
  const f = await fixture();
  const source = await f.native();
  const devices = await Promise.all([f.pair("Native current"), f.pair("Native history")]);
  const snapshot = await f.replay(source.id);
  expect(snapshot.safeCursor).toMatch(/^native:[a-f0-9]{64}:waiting$/u);
  const current = f.tail(devices[0]!, input(source.id, "native-current", snapshot.safeCursor));
  await f.joined([devices[0]!], [source.id]);
  const older = page(
    await f.tail(
      devices[1]!,
      input(source.id, "native-history", snapshot.events[0]!.cursor, { waitMs: 0, limit: 1 }),
    ),
  );
  expect(messages(older)).toEqual(["Native two"]);
  expect(older.hasMore).toBe(true);
  const reconnect = page(
    await f.tail(
      devices[1]!,
      input(source.id, "native-reconnect", older.nextCursor, { waitMs: 0, limit: 1 }),
    ),
  );
  expect(messages(reconnect)).toEqual(["Native three"]);
  expect(reconnect.surfaceClientId).toBe("native-reconnect");
  await source.append("Native four");
  expect(messages(page(await current))).toEqual(["Native four"]);
  expect(f.maximum.get(source.id)).toBe(1);
  expect(
    f.requests.filter(
      ({ request }) => request.op === "replay" && request.replay.conversationId === source.id,
    ),
  ).toHaveLength(2);
});

it("keeps live-sequence waits independent and replaces the volatile draft with the settled record", async () => {
  const f = await fixture();
  const devices = await Promise.all([f.pair("Draft watcher"), f.pair("New watcher")]);
  const cursor = (await f.replay(f.id)).safeCursor;
  const first = f.tail(devices[0]!, input(f.id, "draft-watcher", cursor));
  await f.joined([devices[0]!], [f.id]);
  f.store.setLiveDraft(f.id, "Typing shared answer");
  const draft = page(await first);
  expect(draft.events).toEqual([]);
  expect(draft.live?.text).toBe("Typing shared answer");
  const waiting = f.tail(
    devices[0]!,
    input(f.id, "already-drawn", cursor, { liveSequence: draft.live!.sequence }),
  );
  await until(() => f.active.get(f.id) === 1, "next shared draft observation");
  const unseen = page(
    await f.tail(devices[1]!, input(f.id, "not-yet-drawn", cursor, { waitMs: 0, liveSequence: 0 })),
  );
  expect(unseen.surfaceClientId).toBe("not-yet-drawn");
  expect(unseen.live).toEqual(draft.live);
  f.store.setLiveDraft(f.id, undefined);
  f.publish(f.id, "Settled shared answer");
  const settled = page(await waiting);
  expect(settled.live).toBeUndefined();
  expect(messages(settled)).toEqual(["Settled shared answer"]);
  expect(
    (await f.replay(f.id)).events.some(
      (event) => event.type === "message" && event.text === "Typing shared answer",
    ),
  ).toBe(false);
  expect(f.maximum.get(f.id)).toBe(1);
});

it("does not let an invalid reader cursor reset another subscriber's live observation", async () => {
  const f = await fixture();
  const devices = await Promise.all([f.pair("Valid"), f.pair("Invalid cursor")]);
  const cursor = (await f.replay(f.id)).safeCursor;
  const valid = f.tail(devices[0]!, input(f.id, "valid", cursor));
  await f.joined([devices[0]!], [f.id]);
  const recovery = await f.tail(devices[1]!, input(f.id, "invalid", "foreign:opaque-cursor", { waitMs: 0 }));
  expect(recovery).toMatchObject({ status: "recover", conversationId: f.id, code: "cursor_invalid" });
  expect(f.active.get(f.id)).toBe(1);
  f.publish(f.id, "Still observing");
  expect(messages(page(await valid))).toEqual(["Still observing"]);
  expect(f.maximum.get(f.id)).toBe(1);
});

it("isolates native session replacement recovery from a different conversation's parked reader", async () => {
  const f = await fixture();
  const source = await f.native();
  const devices = await Promise.all([f.pair("Native"), f.pair("Other conversation")]);
  const native = f.tail(devices[0]!, input(source.id, "native", (await f.replay(source.id)).safeCursor));
  const other = f.tail(devices[1]!, input(f.id, "other", (await f.replay(f.id)).safeCursor));
  await f.joined(devices, [source.id, f.id]);
  await source.replace();
  expect(await native).toMatchObject({
    status: "recover",
    conversationId: source.id,
    code: "cursor_reset",
    recoverable: true,
  });
  expect(f.active.get(f.id)).toBe(1);
  f.publish(f.id, "Unaffected conversation");
  expect(messages(page(await other))).toEqual(["Unaffected conversation"]);
  expect(f.maximumTotal()).toBe(2);
});

it("rechecks real device revocation before emitting a shared page and lets the other device receive it", async () => {
  const f = await fixture();
  const devices = await Promise.all([f.pair("Revoked stream"), f.pair("Still authorized")]);
  const cursor = (await f.replay(f.id)).safeCursor;
  const revoked = f.raw(devices[0]!, input(f.id, "revoked-stream", cursor), true);
  const authorized = f.tail(devices[1]!, input(f.id, "authorized", cursor));
  await f.joined(devices, [f.id]);
  await f.revoke(devices[0]!);
  f.publish(f.id, "Must not leak to revoked device");
  const response = await revoked;
  const body = await response.text();
  expect(body).not.toContain("Must not leak");
  expect(
    body
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  ).toEqual([
    { kind: "auth_failure", failure: { schemaVersion: 1, outcome: "auth_failed", reason: "revoked" } },
  ]);
  expect(messages(page(await authorized))).toEqual(["Must not leak to revoked device"]);
  expect(f.maximum.get(f.id)).toBe(1);
});

it("cancels one client without aborting the shared upstream, then aborts the actual HTTP hop when the last client leaves", async () => {
  const f = await fixture();
  const devices = await Promise.all([f.pair("Leaves first"), f.pair("Leaves last")]);
  const cursor = (await f.replay(f.id)).safeCursor;
  const first = new AbortController(),
    last = new AbortController();
  const a = f.raw(devices[0]!, input(f.id, "first", cursor), false, first.signal).then(
    () => "response",
    () => "aborted",
  );
  const b = f.raw(devices[1]!, input(f.id, "last", cursor), false, last.signal).then(
    () => "response",
    () => "aborted",
  );
  await f.joined(devices, [f.id]);
  first.abort();
  expect(await a).toBe("aborted");
  const abortedTails = () =>
    f.requests.filter(
      ({ request, aborted }) => request.op === "tail" && (request.tail.waitMs ?? 0) > 0 && aborted,
    );
  expect(f.active.get(f.id)).toBe(1);
  expect(abortedTails()).toHaveLength(0);
  last.abort();
  expect(await b).toBe("aborted");
  await until(
    () => f.active.get(f.id) === 0 && abortedTails().length === 1,
    "last subscriber's upstream HTTP cancellation",
  );
  expect(f.maximum.get(f.id)).toBe(1);
});

it("honors each device's wait deadline while another device keeps the single upstream parked", async () => {
  const f = await fixture();
  const devices = await Promise.all([f.pair("Long wait"), f.pair("Short wait")]);
  const cursor = (await f.replay(f.id)).safeCursor;
  const long = f.tail(devices[0]!, input(f.id, "long", cursor));
  await f.joined([devices[0]!], [f.id]);
  const started = Date.now();
  const short = page(await f.tail(devices[1]!, input(f.id, "short", cursor, { waitMs: 100, limit: 1 })));
  const elapsed = Date.now() - started;
  expect(elapsed).toBeGreaterThanOrEqual(90);
  expect(elapsed).toBeLessThan(1_500);
  expect(short.surfaceClientId).toBe("short");
  expect(short.events).toEqual([]);
  expect(short.nextCursor).toBe(cursor);
  expect(f.active.get(f.id)).toBe(1);
  f.publish(f.id, "Long reader remains");
  expect(messages(page(await long))).toEqual(["Long reader remains"]);
  expect(f.maximum.get(f.id)).toBe(1);
});

it("does not replay obsolete native activity when an unchanged transcript returns to the same waiting cursor", async () => {
  const f = await fixture({});
  const source = await f.native();
  const devices = await Promise.all([f.pair("Native stream"), f.pair("Native activity")]);
  const originalJournal = await source.journal();
  const waiting = await f.replay(source.id);
  const stream = await f.stream(
    devices[0]!,
    input(source.id, "persistent-native", undefined, { waitMs: 250 }),
  );
  for (const event of waiting.events) expect(await stream.nextEvent()).toEqual(event);
  const workingRead = f.tail(devices[1]!, input(source.id, "native-working", waiting.safeCursor));
  await f.joined(devices, [source.id]);

  source.activity("working");
  const working = page(await workingRead);
  expect(working.events).toMatchObject([{ type: "activity", phase: "responding" }]);
  expect(working.nextCursor).toMatch(/:responding$/u);
  expect(await stream.nextEvent()).toEqual(working.events[0]);
  const waitingRead = f.tail(devices[1]!, input(source.id, "native-waiting", working.nextCursor));
  await until(() => f.active.get(source.id) === 1, "shared native responding observation");

  source.activity("idle");
  const returned = page(await waitingRead);
  expect(returned.events).toMatchObject([{ type: "activity", phase: "waiting" }]);
  expect(returned.nextCursor).toBe(waiting.safeCursor);
  expect(await stream.nextEvent()).toEqual(returned.events[0]);
  const current = page(
    await f.tail(devices[1]!, input(source.id, "current-waiting", waiting.safeCursor, { waitMs: 0 })),
  );
  expect(current.events).toEqual([]);
  expect(current.nextCursor).toBe(waiting.safeCursor);
  expect(current.safeCursor).toBe(waiting.safeCursor);
  expect(await source.journal()).toBe(originalJournal);
  expect(f.maximum.get(source.id)).toBe(1);
  await stream.close();
});

it("uses authoritative backward history while a warm zero-wait cursor reads immediately from the shared cache", async () => {
  const f = await fixture({});
  const devices = await Promise.all([f.pair("Warm stream"), f.pair("Backward reader")]);
  for (const text of ["One", "Two", "Three", "Four", "Five"]) f.publish(f.id, text);
  const snapshot = await f.replay(f.id);
  const stream = await f.stream(devices[0]!, input(f.id, "warm-stream", undefined, { waitMs: 250 }));
  for (const event of snapshot.events) expect(await stream.nextEvent()).toEqual(event);
  await f.joined([devices[0]!], [f.id]);
  const replaysBefore = f.requests.filter(({ request }) => request.op === "replay").length;
  const selection = { cursor: snapshot.events.at(-1)!.cursor, direction: "backward" as const, limit: 2 };
  const expected = await f.replay(f.id, selection);
  const history = page(
    await f.tail(devices[1]!, input(f.id, "backward-history", selection.cursor, { ...selection, waitMs: 0 })),
  );
  expect({ ...history, surfaceClientId: "authority" }).toEqual(expected);
  expect(messages(history)).toEqual(["Three", "Four"]);
  expect(history.hasOlder).toBe(true);
  expect(
    f.requests.some(
      ({ request }) =>
        request.op === "replay" &&
        request.replay.cursor === selection.cursor &&
        request.replay.direction === "backward" &&
        (request.replay.waitMs ?? 0) === 0,
    ),
  ).toBe(true);

  const current = page(
    await f.tail(devices[1]!, input(f.id, "warm-current", snapshot.safeCursor, { waitMs: 0 })),
  );
  expect(current.surfaceClientId).toBe("warm-current");
  expect(current.events).toEqual([]);
  expect(current.nextCursor).toBe(snapshot.safeCursor);
  expect(f.requests.filter(({ request }) => request.op === "replay")).toHaveLength(replaysBefore + 1);
  expect(f.active.get(f.id)).toBe(1);
  expect(f.maximum.get(f.id)).toBe(1);
  await stream.close();
});

it("replays a native cursor evicted by the bounded cache without opening a second parked upstream tail", async () => {
  const f = await fixture({});
  const source = await f.native();
  const devices = await Promise.all([f.pair("Large native stream"), f.pair("Evicted cursor")]);
  const initial = await f.replay(source.id);
  const stream = await f.stream(
    devices[0]!,
    input(source.id, "large-stream", undefined, { waitMs: 250, limit: 500 }),
  );
  for (const event of initial.events) expect(await stream.nextEvent()).toEqual(event);
  await f.joined([devices[0]!], [source.id]);

  // One real journal write exceeds the 1 MiB cache with protocol-valid text;
  // this avoids thousands of synchronous durable-store writes in the fixture.
  const additions = Array.from({ length: 80 }, (_, index) => `Native large ${index}: ${"x".repeat(15_000)}`);
  expect(Buffer.byteLength(additions.join(""))).toBeGreaterThan(1024 * 1024);
  await source.appendMany(additions);
  const latest = await f.replay(source.id, { limit: 500 });
  for (const event of latest.events.slice(3)) expect(await stream.nextEvent()).toEqual(event);
  await until(
    () =>
      f.active.get(source.id) === 1 &&
      f.requests.some(
        ({ request }) =>
          request.op === "tail" &&
          request.tail.cursor === latest.safeCursor &&
          (request.tail.waitMs ?? 0) > 0,
      ),
    "the native stream's latest cursor and one parked upstream",
  );
  const replaysBefore = f.requests.filter(({ request }) => request.op === "replay").length;
  const evictedCursor = initial.events[0]!.cursor;
  const older = page(
    await f.tail(devices[1]!, input(source.id, "evicted-history", evictedCursor, { waitMs: 0, limit: 1 })),
  );
  expect(older.surfaceClientId).toBe("evicted-history");
  expect(messages(older)).toEqual(["Native two"]);
  expect(older.hasMore).toBe(true);
  const replays = f.requests.filter(({ request }) => request.op === "replay");
  expect(replays).toHaveLength(replaysBefore + 1);
  expect(replays.at(-1)!.request).toMatchObject({
    op: "replay",
    replay: {
      conversationId: source.id,
      cursor: evictedCursor,
      surfaceClientId: "evicted-history",
      limit: 1,
    },
  });
  expect(f.active.get(source.id)).toBe(1);
  expect(f.maximum.get(source.id)).toBe(1);
  await stream.close();
});
