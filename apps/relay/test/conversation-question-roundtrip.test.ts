import { ClankieSettingsSchema } from "../../../packages/settings/src/index.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, randomUUID, randomBytes } from "node:crypto";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { createClankieApp } from "../../clankie/src/app.ts";
import { ConversationStore } from "../../clankie/src/captain/conversations.ts";
import { createStubCaptain } from "../../clankie/src/captain/port.ts";
import { QuestionDraftSchema } from "../../clankie/src/captain/conversation-questions.ts";
import { DeviceSessionSigner, mintDeviceSessionClaims } from "../../clankie/src/device-session.ts";
import { HostedPairing } from "../../clankie/src/hosted-pairing.ts";
import { HostedBodyClient } from "../../clankie/src/hosted-body.ts";
import { hostedFixture } from "../../clankie/test/fixtures/hosted-body.ts";
import {
  GatewayEncryptionHost,
  openGatewayValue,
  sealGatewayValue,
} from "../../clankie/src/gateway-encryption.ts";
import { createGatewayEncryptedFetch } from "../../../packages/api-client/src/gateway-encryption.ts";
import {
  TAKE_CONTROL_GRANTS,
  SUPERVISE_GRANTS,
  createOperatorConversationServiceClient,
  OperatorConversationServiceResultSchema,
  type OperatorConversationServiceRequest,
  type OperatorConversationServiceDispatch,
} from "../../../packages/protocol/src/index.ts";
import { ControlPlaneDeviceAuthorizer } from "../src/device-auth.ts";
import {
  createCaptainConversationDispatch,
  createDeviceConversationDispatch,
} from "../src/conversation-upstream.ts";
import { createOperatorConversationRelayHandler } from "../src/operator-conversations.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function listen(handler: (request: IncomingMessage, response: ServerResponse) => Promise<unknown>) {
  const server: Server = createServer((request, response) => {
    void handler(request, response).catch(() => {
      response.statusCode = 500;
      response.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No fixture TCP listener");
  return `http://127.0.0.1:${address.port}`;
}

async function fixture(hosted = false, text = false) {
  const root = mkdtempSync(join(tmpdir(), "relay-question-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  let now = Date.now();
  const clock = () => now;
  const key = randomBytes(32),
    signer = new DeviceSessionSigner(key);
  const names = ["control", "other", "read", "unminted"];
  const tokens = Object.fromEntries(
    names.map((id) => [
      id,
      signer.issue(
        mintDeviceSessionClaims({
          deviceId: id,
          nowEpochSeconds: Math.floor(clock() / 1000),
          ttlSeconds: 600,
        }),
      ),
    ]),
  );
  const events = names.flatMap((deviceId) => {
    const grants = deviceId === "read" ? SUPERVISE_GRANTS : TAKE_CONTROL_GRANTS;
    const base = {
      occurredAt: new Date(clock()).toISOString(),
      missionId: `device:${deviceId}`,
      correlationId: "fixture",
      profileHash: "fixture",
    };
    return [
      {
        ...base,
        id: randomUUID(),
        type: "device.pairing.redeemed",
        data: {
          schemaVersion: 1,
          deviceId,
          offerId: deviceId,
          name: "Same label",
          platform: "ios",
          offeredGrants: grants,
          mintedBy: hosted && deviceId !== "unminted" ? "hosted-account-operator" : "local-owner",
          pendingExpiresAt: new Date(clock() + 600_000).toISOString(),
        },
      },
      {
        ...base,
        id: randomUUID(),
        type: "device.activated",
        data: {
          schemaVersion: 1,
          deviceId,
          grants,
          sessionExpiresAt: new Date(clock() + 600_000).toISOString(),
        },
      },
    ];
  });
  const log = join(root, "events.jsonl");
  writeFileSync(log, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const continuation = vi.fn(),
    issuers: unknown[] = [];
  const store = new ConversationStore(
    join(root, "conversations"),
    async (id, _message, _publish, context) => {
      if (context.inputAnswer) {
        continuation(context);
        return;
      }
      issuers.push(context.ownerAuthority?.principal);
      if (context.ownerAuthority)
        await store.requestQuestion(
          id,
          QuestionDraftSchema.parse(
            text
              ? { kind: "text", prompt: "What context?" }
              : { kind: "choice", prompt: "Which size?", options: [{ label: "Small" }, { label: "Large" }] },
          ),
          context,
        );
    },
  );
  const created = await store.serve({
    op: "create",
    schemaVersion: 1,
    scope: { kind: "workspace", workspaceId: workspace },
    title: "Fixture",
  });
  if (created.op !== "create") throw new Error("Wrong result");
  const id = created.conversation.conversationId;
  const writeSettings = vi.fn(async () => {
    throw new Error("Settings forbidden");
  });
  const hf = hostedFixture();
  const service = await createClankieApp({
    settings: { load: async () => ClankieSettingsSchema.parse({ schemaVersion: 1 }), update: writeSettings },
    captain: createStubCaptain({
      serveOperatorConversation: (request, authority) =>
        store.serve(request as Parameters<typeof store.serve>[0], authority),
      invalidateQuestionPrincipal: (deviceId) => store.invalidateQuestionPrincipal(deviceId),
    }),
    eventLogPath: log,
    deviceSessionKey: key,
    clock: () => new Date(clock()),
    authenticateCaptain: async (r) =>
      r.headers.get("authorization") === "Bearer fixture-captain-token"
        ? { captainId: "captain", steerSourceLane: "api" }
        : undefined,
    authenticateOperator: async (r) =>
      r.headers.get("authorization") === "Bearer fixture-owner" ? { operatorId: "owner" } : undefined,
    ...(hosted
      ? {
          hostedPairing: new HostedPairing(
            new HostedBodyClient(hf.bootstrap, { clock }),
            generateKeyPairSync("ed25519").privateKey,
            { clock },
          ),
        }
      : {}),
  });
  cleanups.push(async () => {
    await store.close();
    service.close();
    expect(writeSettings).not.toHaveBeenCalled();
    rmSync(root, { recursive: true, force: true });
  });
  const seen: { path: string; token: string | null; body: unknown }[] = [];
  let selfCount = 0;
  const hooks: {
    before?: (request: Request, signal: AbortSignal) => Promise<void>;
    after?: (request: Request, response: Response, signal: AbortSignal) => Promise<Response>;
    self?: (response: Response, count: number) => Promise<Response>;
  } = {};
  const controlFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    // Observe the dispatch signal: Node 26 Request.clone() weakly retains its
    // dependent controller, so GC can stop a clone from following cancellation.
    const signal = init?.signal ?? (input instanceof Request ? input.signal : request.signal);
    expect(new URL(request.url).origin).toBe("http://control.fixture");
    seen.push({
      path: new URL(request.url).pathname,
      token: request.headers.get("authorization"),
      body: request.method === "POST" ? await request.clone().json() : undefined,
    });
    await hooks.before?.(request, signal);
    const hookRequest = request.clone();
    let response = await service.app.fetch(request);
    if (new URL(request.url).pathname === "/v1/devices/self")
      response = (await hooks.self?.(response, ++selfCount)) ?? response;
    return (await hooks.after?.(hookRequest, response, signal)) ?? response;
  };
  const authorizer = new ControlPlaneDeviceAuthorizer({
    baseUrl: "http://control.fixture",
    fetch: controlFetch,
  });
  const owner = createDeviceConversationDispatch({ baseUrl: "http://control.fixture", fetch: controlFetch });
  const captain = createCaptainConversationDispatch({
    baseUrl: "http://control.fixture",
    bearerToken: "fixture-captain-token",
    fetch: controlFetch,
  });
  const messages: unknown[] = [];
  const options = {
    clock,
    authorizeDevice: authorizer,
    dispatch: captain,
    deviceDispatch: owner,
    logger: {
      info: (fields: unknown) => messages.push(fields),
      warn: (fields: unknown) => messages.push(fields),
    },
  };
  const requests: { request: IncomingMessage; response: ServerResponse }[] = [];
  const handler = createOperatorConversationRelayHandler(options);
  const url = await listen(async (request, response) => {
    requests.push({ request, response });
    return handler(request, response);
  });
  const raw = (request: OperatorConversationServiceRequest, token = tokens.control!, signal?: AbortSignal) =>
    fetch(`${url}/operator/v1/dispatch`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(request),
      ...(signal ? { signal } : {}),
    });
  const client = (token = tokens.control!) =>
    createOperatorConversationServiceClient(async (request, signal) => {
      const response = await raw(request, token, signal);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return OperatorConversationServiceResultSchema.parse(await response.json());
    });
  const turn = () => ({
    schemaVersion: 1 as const,
    kind: "message" as const,
    conversationId: id,
    surfaceClientId: "fixture",
    expectedRevision: store.conversation(id)!.revision,
    message: "Ask a preference",
  });
  const send = async (token = tokens.control!) => {
    const result = await client(token).send(turn());
    if (result.status !== "accepted") throw new Error(result.status);
    await store.awaitRun(result.runId);
    return result;
  };
  const target = async () => {
    const read = await client().inputGet!(id);
    const q = read.question!;
    return {
      conversationId: id,
      requestId: q.requestId,
      incarnationId: q.incarnationId,
      expectedRevision: read.revision!,
      answer: text
        ? { kind: "text" as const, text: "/reset is context" }
        : { kind: "choice" as const, optionId: q.options[0]!.optionId },
    };
  };
  const revoke = async (deviceId: string) => {
    const response = await service.app.request(`/v1/devices/${deviceId}/revoke`, {
      method: "POST",
      headers: { authorization: "Bearer fixture-owner" },
    });
    expect(response.status).toBe(200);
  };
  return {
    id,
    key,
    clock,
    store,
    service,
    tokens,
    client,
    raw,
    send,
    turn,
    target,
    continuation,
    issuers,
    seen,
    hooks,
    requests,
    messages,
    options,
    revoke,
    expire: () => {
      now += 601_000;
    },
  };
}

it.each([false, true])(
  "actual signed owner roundtrip with hosted=%s preserves exact receipt and one continuation",
  async (hosted) => {
    const f = await fixture(hosted);
    await f.send();
    expect(f.issuers).toEqual([{ kind: "device", id: "control" }]);
    const target = await f.target();
    const invalid = await f.client().inputAnswer!({
      ...target,
      answer: { kind: "choice", optionId: randomUUID() },
    });
    expect(invalid.reason).toBe("invalid_answer");
    const [answer, duplicate] = await Promise.all([
      f.client().inputAnswer!(target),
      f.client(f.tokens.other!).inputAnswer!(target),
    ]);
    const runId = answer.question!.continuation!.runId;
    expect(duplicate.question!.continuation!.runId).toBe(runId);
    await f.store.awaitRun(runId);
    expect(f.continuation).toHaveBeenCalledTimes(1);
    const recovered = await f.client(f.tokens.other!).inputGet!(f.id, target.requestId);
    expect(recovered.question).toMatchObject({
      requestId: target.requestId,
      status: "submitted",
      continuation: { runId, state: "completed" },
    });
    const writes = f.seen.filter((r) => r.path !== "/v1/devices/self");
    expect(writes.every((r) => r.path === (hosted ? "/v1/hosted/operator" : "/operator/v1/dispatch"))).toBe(
      true,
    );
    expect(writes.every((r) => r.token !== "Bearer fixture-captain-token")).toBe(true);
    expect(JSON.stringify(f.messages)).not.toContain(f.tokens.control);
    expect(JSON.stringify(f.messages)).not.toContain("Which size");
  },
);

it("TUI-started text can be answered by a paired device without interpreting slash text", async () => {
  const f = await fixture(false, true);
  const response = await f.service.app.request("/operator/v1/dispatch", {
    method: "POST",
    headers: { authorization: "Bearer fixture-owner", "content-type": "application/json" },
    body: JSON.stringify({ op: "send", schemaVersion: 1, turn: f.turn() }),
  });
  const started = OperatorConversationServiceResultSchema.parse(await response.json());
  if (started.op !== "send" || started.result.status !== "accepted") throw new Error("not accepted");
  await f.store.awaitRun(started.result.runId);
  const answer = await f.client().inputAnswer!(await f.target());
  await f.store.awaitRun(answer.question!.continuation!.runId);
  expect(f.continuation.mock.calls[0]![0].inputAnswer).toBeDefined();
  expect(answer.question!.answer).toEqual({ kind: "text", text: "/reset is context" });
});

it("chat-only send keeps captain semantics while all question operations, listing included, require current control", async () => {
  const f = await fixture();
  await f.send(f.tokens.read!);
  expect(f.issuers).toEqual([undefined]);
  expect((await f.client().inputGet!(f.id)).question).toBeUndefined();
  await f.send();
  const target = await f.target();
  // The control device reads the pending ask through its own owner route, never the captain hop.
  const listed = await f.client().inputList!({ status: "pending" });
  expect(listed.questions.map((entry) => entry.question?.requestId)).toEqual([target.requestId]);
  for (const request of [
    { op: "input_list", schemaVersion: 1, status: "pending" },
    { op: "input_get", schemaVersion: 1, conversationId: f.id },
    { op: "input_answer", schemaVersion: 1, ...target },
    {
      op: "input_cancel",
      schemaVersion: 1,
      conversationId: f.id,
      requestId: target.requestId,
      incarnationId: target.incarnationId,
      expectedRevision: target.expectedRevision,
    },
  ] as const) {
    const before = f.seen.filter((r) => r.path !== "/v1/devices/self").length;
    expect((await f.raw(request, f.tokens.read!)).status).toBe(403);
    expect(f.seen.filter((r) => r.path !== "/v1/devices/self")).toHaveLength(before);
  }
  const { answer: _answer, ...cancelTarget } = target;
  const cancelled = await f.client().inputCancel!(cancelTarget);
  expect(cancelled.question?.status).toBe("cancelled");
  expect((await f.client().inputAnswer!(target)).question?.status).toBe("cancelled");
  expect(f.continuation).not.toHaveBeenCalled();
});

it.each(["captain", "wrong-signer", "expired", "revoked"])(
  "refuses actual %s device authority",
  async (kind) => {
    const f = await fixture();
    let token = f.tokens.control!;
    if (kind === "captain") token = "fixture-captain-token";
    if (kind === "wrong-signer")
      token = new DeviceSessionSigner(randomBytes(32)).issue(
        mintDeviceSessionClaims({
          deviceId: "control",
          nowEpochSeconds: Math.floor(f.clock() / 1000),
          ttlSeconds: 600,
        }),
      );
    if (kind === "expired") f.expire();
    if (kind === "revoked") await f.revoke("control");
    expect((await f.raw({ op: "input_get", schemaVersion: 1, conversationId: f.id }, token)).status).toBe(
      401,
    );
    expect((await f.raw({ op: "input_list", schemaVersion: 1, status: "pending" }, token)).status).toBe(401);
    expect(f.seen.every((r) => r.path === "/v1/devices/self")).toBe(true);
  },
);

it("hosted unminted control device cannot fall back around the bridge", async () => {
  const f = await fixture(true);
  const response = await f.raw(
    { op: "input_get", schemaVersion: 1, conversationId: f.id },
    f.tokens.unminted!,
  );
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "conversation_owner_upstream_refused" });
  expect(f.seen.some((r) => r.path === "/v1/hosted/operator")).toBe(true);
  expect(f.seen.some((r) => r.path === "/operator/v1/dispatch")).toBe(false);
  expect(
    (await f.raw({ op: "reset", schemaVersion: 1, conversationId: f.id, expectedRevision: 0 })).status,
  ).toBe(403);
});

it("known revoke between relay admission and actual service hop denies owner work", async () => {
  const f = await fixture(true);
  f.hooks.before = async (request) => {
    if (new URL(request.url).pathname === "/v1/hosted/operator") await f.revoke("control");
  };
  expect((await f.raw({ op: "input_get", schemaVersion: 1, conversationId: f.id })).status).toBe(401);
  expect(f.continuation).not.toHaveBeenCalled();
});

it("revocation after committed answer withholds response but later exact read recovers original run", async () => {
  const f = await fixture();
  await f.send();
  const target = await f.target();
  f.hooks.after = async (request, response) => {
    if (request.method === "POST" && (await request.clone().json()).op === "input_answer") {
      const result = OperatorConversationServiceResultSchema.parse(await response.clone().json());
      if (result.op !== "input_answer") throw new Error("wrong result");
      await f.store.awaitRun(result.result.question!.continuation!.runId);
      await f.revoke("control");
    }
    return response;
  };
  expect((await f.raw({ op: "input_answer", schemaVersion: 1, ...target })).status).toBe(401);
  delete f.hooks.after;
  const recovered = await f.client(f.tokens.other!).inputGet!(f.id, target.requestId);
  expect(recovered.question?.continuation?.state).toBe("completed");
  expect(f.continuation).toHaveBeenCalledTimes(1);
});

it("uncertain answer response is recovered by exact read, never an automatic second mutation", async () => {
  const f = await fixture();
  await f.send();
  const target = await f.target();
  f.hooks.after = async (request, response) => {
    if (request.method === "POST" && (await request.clone().json()).op === "input_answer")
      throw new Error(`Bearer ${f.tokens.control} private answer`);
    return response;
  };
  const response = await f.raw({ op: "input_answer", schemaVersion: 1, ...target });
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "conversation_upstream_unavailable" });
  delete f.hooks.after;
  const recovered = await f.client().inputGet!(f.id, target.requestId);
  await f.store.awaitRun(recovered.question!.continuation!.runId);
  expect(f.continuation).toHaveBeenCalledTimes(1);
  expect(f.seen.filter((r) => (r.body as { op?: string } | undefined)?.op === "input_answer")).toHaveLength(
    1,
  );
  expect(JSON.stringify(f.messages)).not.toContain(f.tokens.control);
});

it("missing owner dispatch fails closed without captain fallback", async () => {
  const f = await fixture();
  const dispatch = vi.fn(f.options.dispatch);
  const handler = createOperatorConversationRelayHandler({
    authorizeDevice: f.options.authorizeDevice,
    dispatch,
  });
  const url = await listen(handler);
  for (const request of [
    { op: "input_get", schemaVersion: 1, conversationId: f.id },
    { op: "send", schemaVersion: 1, turn: f.turn() },
  ] as const) {
    const response = await fetch(`${url}/operator/v1/dispatch`, {
      method: "POST",
      headers: { authorization: `Bearer ${f.tokens.control}` },
      body: JSON.stringify(request),
    });
    expect(response.status).toBe(503);
  }
  expect(dispatch).not.toHaveBeenCalled();
});

it("send dedup identity is stable through grant upgrade and token rotation", async () => {
  const f = await fixture();
  let control = false;
  f.hooks.self = async (response) => {
    const data = await response.json();
    return Response.json({ ...data, grants: { ...data.grants, terminalControl: control } });
  };
  const request = { op: "send", schemaVersion: 1, turn: f.turn() } as const;
  const first = OperatorConversationServiceResultSchema.parse(await (await f.raw(request)).json());
  if (first.op !== "send" || first.result.status !== "accepted") throw new Error("not accepted");
  await f.store.awaitRun(first.result.runId);
  control = true;
  // Force wall time across the next second while the service fixture stays frozen.
  vi.spyOn(Date, "now").mockReturnValue(f.clock() + 1_000);
  const rotated = new DeviceSessionSigner(f.key).issue(
    mintDeviceSessionClaims({
      deviceId: "control",
      nowEpochSeconds: Math.floor(f.clock() / 1000),
      ttlSeconds: 500,
    }),
  );
  expect(rotated).not.toBe(f.tokens.control);
  const [a, b] = await Promise.all([f.raw(request), f.raw(request, rotated)]);
  expect(await a.json()).toEqual(first);
  expect(await b.json()).toEqual(first);
  expect(f.issuers).toEqual([undefined]);
  expect(f.seen.filter((r) => (r.body as { op?: string } | undefined)?.op === "send")).toHaveLength(1);
});

it("control loss after owner dispatch withholds response without a captain downgrade", async () => {
  const f = await fixture();
  f.hooks.self = async (response, count) => {
    const data = await response.json();
    return Response.json({ ...data, grants: { ...data.grants, terminalControl: count < 3 } });
  };
  expect((await f.raw({ op: "send", schemaVersion: 1, turn: f.turn() })).status).toBe(403);
  expect(f.seen.filter((r) => (r.body as { op?: string } | undefined)?.op === "send")).toHaveLength(1);
  expect(f.seen.some((r) => r.token === "Bearer fixture-captain-token")).toBe(false);
});

it("changed identity/scope after admission never publishes or reroutes", async () => {
  const f = await fixture();
  f.hooks.self = async (response, count) => {
    const data = await response.json();
    return Response.json(count === 2 ? { ...data, controlScope: "hosted" } : data);
  };
  expect((await f.raw({ op: "input_get", schemaVersion: 1, conversationId: f.id })).status).toBe(401);
  expect(f.seen.every((r) => r.path === "/v1/devices/self")).toBe(true);
});

it("disconnect during owner work aborts its fetch and cleans handler listeners", async () => {
  const f = await fixture();
  const began = latch(),
    aborted = latch();
  f.hooks.before = async (request, signal) => {
    if (new URL(request.url).pathname !== "/operator/v1/dispatch") return;
    began.resolve();
    await new Promise<void>((_resolve, reject) => {
      const onAbort = () => {
        aborted.resolve();
        reject(new Error("aborted"));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  };
  const controller = new AbortController();
  const pending = f.raw(
    { op: "input_get", schemaVersion: 1, conversationId: f.id },
    f.tokens.control!,
    controller.signal,
  );
  const rejected = expect(pending).rejects.toThrow();
  await began.promise;
  controller.abort();
  await rejected;
  await aborted.promise;
  await vi.waitFor(() => expect(f.requests[0]!.request.listenerCount("aborted")).toBe(0));
  expect(f.requests[0]!.response.listenerCount("close")).toBe(0);
  expect(f.seen.filter((r) => r.path === "/operator/v1/dispatch")).toHaveLength(1);
});

it("disconnect during finite authorizer await never starts a unary dispatch", async () => {
  const f = await fixture();
  const began = latch(),
    release = latch();
  f.hooks.self = async (response, count) => {
    if (count === 2) {
      began.resolve();
      await release.promise;
    }
    return response;
  };
  const controller = new AbortController();
  const pending = f.raw(
    { op: "input_get", schemaVersion: 1, conversationId: f.id },
    f.tokens.control!,
    controller.signal,
  );
  const rejected = expect(pending).rejects.toThrow();
  await began.promise;
  controller.abort();
  await rejected;
  await vi.waitFor(() => expect(f.requests[0]!.response.destroyed).toBe(true));
  release.resolve();
  await vi.waitFor(() => expect(f.requests[0]!.request.listenerCount("aborted")).toBe(0));
  expect(f.seen.every((r) => r.path === "/v1/devices/self")).toBe(true);
});

it("encrypted public transport reaches the real hosted relay/bridge without exposing the bearer outside", async () => {
  const f = await fixture(true);
  const hostId = "fixture_host_identity_1234",
    wrappingKey = randomBytes(32),
    encryptionKey = randomBytes(32).toString("base64");
  // Temporary pre-paired device ticket signed with this fixture's wrapping key.
  const credential = {
    hostId,
    key: encryptionKey,
    ticket: sealGatewayValue(
      wrappingKey,
      JSON.stringify({
        key: encryptionKey,
        subject: "control",
        stage: "device",
        expiresAt: f.clock() + 600_000,
      }),
      `clankie-gateway-ticket-v1:${hostId}`,
    ),
  };
  const host = new GatewayEncryptionHost(hostId, wrappingKey),
    outer: string[] = [];
  const encrypted = createGatewayEncryptedFetch({
    credential: () => credential,
    crypto: {
      randomBytes,
      seal: async (key, value, aad) => sealGatewayValue(Buffer.from(key, "base64"), value, aad),
      open: async (key, value, aad) => openGatewayValue(Buffer.from(key, "base64"), value, aad),
    },
    fetchImpl: async (input, init) => {
      outer.push(JSON.stringify({ input: String(input), init }));
      const path = new URL(String(input)).pathname.slice(`/h/${hostId}`.length);
      return host.handle(
        path,
        String(init?.body ?? ""),
        init?.signal ?? new AbortController().signal,
        async (request) => {
          if (new URL(request.url).hostname === "control") return f.service.app.fetch(request);
          const bearer = request.headers.get("authorization");
          expect(bearer).toBe(`Bearer ${f.tokens.control}`);
          return f.raw(
            (await request.json()) as OperatorConversationServiceRequest,
            bearer!.slice("Bearer ".length),
            request.signal,
          );
        },
      );
    },
  });
  const dispatch: OperatorConversationServiceDispatch = async (request, signal) => {
    const response = await encrypted(`http://127.0.0.1/h/${hostId}/operator/v1/dispatch`, {
      method: "POST",
      headers: { authorization: `Bearer ${f.tokens.control}`, "content-type": "application/json" },
      body: JSON.stringify(request),
      ...(signal ? { signal } : {}),
    });
    expect(response.status).toBe(200);
    return OperatorConversationServiceResultSchema.parse(await response.json());
  };
  const client = createOperatorConversationServiceClient(dispatch);
  const sent = await client.send(f.turn());
  if (sent.status !== "accepted") throw new Error("not accepted");
  await f.store.awaitRun(sent.runId);
  const pending = await client.inputGet!(f.id),
    q = pending.question!;
  const answer = await client.inputAnswer!({
    conversationId: f.id,
    incarnationId: q.incarnationId,
    requestId: q.requestId,
    expectedRevision: pending.revision!,
    answer: { kind: "choice", optionId: q.options[1]!.optionId },
  });
  await f.store.awaitRun(answer.question!.continuation!.runId);
  expect(f.continuation).toHaveBeenCalledTimes(1);
  expect(outer.join("\n")).not.toContain(f.tokens.control);
  expect(outer.join("\n")).not.toContain("Which size");
  expect(
    f.seen.filter((r) => r.path !== "/v1/devices/self").every((r) => r.path === "/v1/hosted/operator"),
  ).toBe(true);
});

it("control loss while reading the request refuses input before any owner dispatch", async () => {
  const f = await fixture();
  f.hooks.self = async (response, count) => {
    const data = await response.json();
    return Response.json({ ...data, grants: { ...data.grants, terminalControl: count < 2 } });
  };
  expect((await f.raw({ op: "input_get", schemaVersion: 1, conversationId: f.id })).status).toBe(403);
  expect(f.seen.every((r) => r.path === "/v1/devices/self")).toBe(true);
});

it("expiry between relay admission and hosted bridge fails with no direct fallback", async () => {
  const f = await fixture(true);
  f.hooks.before = async (request) => {
    if (new URL(request.url).pathname === "/v1/hosted/operator") f.expire();
  };
  expect((await f.raw({ op: "input_get", schemaVersion: 1, conversationId: f.id })).status).toBe(401);
  expect(f.seen.some((r) => r.path === "/operator/v1/dispatch")).toBe(false);
});

it("same-label wrong subject at publication cannot receive a question snapshot", async () => {
  const f = await fixture();
  await f.send();
  let reads = 0;
  f.hooks.self = async (response) => {
    const data = await response.json();
    return Response.json(++reads === 3 ? { ...data, deviceId: "other" } : data);
  };
  const response = await f.raw({ op: "input_get", schemaVersion: 1, conversationId: f.id });
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "device_authentication_required" });
});

it("disconnect after stored answer never cancels or retries its accepted continuation", async () => {
  const f = await fixture();
  await f.send();
  const target = await f.target();
  const committed = latch(),
    aborted = latch();
  f.hooks.after = async (request, response, signal) => {
    if (request.method === "POST" && (await request.clone().json()).op === "input_answer") {
      committed.resolve();
      await new Promise<void>((_resolve, reject) => {
        const onAbort = () => {
          aborted.resolve();
          reject(new Error("caller disconnected"));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    return response;
  };
  const controller = new AbortController();
  const pending = f.raw(
    { op: "input_answer", schemaVersion: 1, ...target },
    f.tokens.control!,
    controller.signal,
  );
  const rejected = expect(pending).rejects.toThrow();
  await committed.promise;
  controller.abort();
  await rejected;
  await aborted.promise;
  delete f.hooks.after;
  const receipt = await f.client().inputGet!(f.id, target.requestId);
  await f.store.awaitRun(receipt.question!.continuation!.runId);
  const terminal = await f.client().inputGet!(f.id, target.requestId);
  expect(terminal.question).toMatchObject({ status: "submitted", continuation: { state: "completed" } });
  expect(f.continuation).toHaveBeenCalledTimes(1);
  expect(f.seen.filter((r) => (r.body as { op?: string } | undefined)?.op === "input_answer")).toHaveLength(
    1,
  );
});

it.each([false, true])(
  "native message controls retain original device authority (hosted=%s)",
  async (hosted) => {
    const f = await fixture(hosted);
    for (const request of [
      { op: "pending_messages", schemaVersion: 1, conversationId: f.id, command: { action: "list" } },
      { op: "stop_task", schemaVersion: 1, conversationId: f.id },
    ] as const) {
      const response = await f.raw(request);
      expect(response.status).toBe(200);
      expect((await response.json()).result.outcome).toBe("unsupported");
      const hop = f.seen.filter((read) => read.path !== "/v1/devices/self").at(-1)!;
      expect(hop.token).toBe(`Bearer ${f.tokens.control}`);
      const before = f.seen.filter((read) => read.path !== "/v1/devices/self").length;
      expect((await f.raw(request, f.tokens.read!)).status).toBe(403);
      expect(f.seen.filter((read) => read.path !== "/v1/devices/self")).toHaveLength(before);
    }
  },
);
