import { SettingsStore } from "../../../packages/settings/src/index.ts";
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
import { projectOnboarding } from "../../clankie/src/captain/project-onboarding.ts";
import { ProjectProposalDraftSchema } from "../../../packages/protocol/src/projects.ts";
import { DeviceSessionSigner, mintDeviceSessionClaims } from "../../clankie/src/device-session.ts";
import { HostedPairing } from "../../clankie/src/hosted-pairing.ts";
import { HostedBodyClient } from "../../clankie/src/hosted-body.ts";
import { hostedFixture } from "../../clankie/test/fixtures/hosted-body.ts";
import {
  TAKE_CONTROL_GRANTS,
  SUPERVISE_GRANTS,
  createOperatorConversationServiceClient,
  OperatorConversationServiceResultSchema,
  type OperatorConversationServiceRequest,
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

async function fixture(hosted = false) {
  const root = mkdtempSync(join(tmpdir(), "relay-question-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  let now = Date.now();
  const key = randomBytes(32),
    signer = new DeviceSessionSigner(key);
  const names = ["control", "other", "read", "unminted"];
  const tokens = Object.fromEntries(
    names.map((id) => [
      id,
      signer.issue(
        mintDeviceSessionClaims({ deviceId: id, nowEpochSeconds: Math.floor(now / 1000), ttlSeconds: 600 }),
      ),
    ]),
  );
  const events = names.flatMap((deviceId) => {
    const grants = deviceId === "read" ? SUPERVISE_GRANTS : TAKE_CONTROL_GRANTS;
    const base = {
      occurredAt: new Date(now).toISOString(),
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
          pendingExpiresAt: new Date(now + 600_000).toISOString(),
        },
      },
      {
        ...base,
        id: randomUUID(),
        type: "device.activated",
        data: { schemaVersion: 1, deviceId, grants, sessionExpiresAt: new Date(now + 600_000).toISOString() },
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
        await store.proposeProjectCreate(
          id,
          ProjectProposalDraftSchema.parse({ projectId: "first", name: "First", prompt: "Review project" }),
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
  const settings = new SettingsStore(join(root, "settings.json"));
  const writeSettings = vi.fn(settings.update.bind(settings));
  store.projectOnboarding = projectOnboarding({ load: () => settings.load(), update: writeSettings });
  const hf = hostedFixture();
  const service = await createClankieApp({
    settings: { load: () => settings.load(), update: writeSettings },
    captain: createStubCaptain({
      serveOperatorConversation: (request, authority) =>
        store.serve(request as Parameters<typeof store.serve>[0], authority),
      invalidateQuestionPrincipal: (deviceId) => store.invalidateQuestionPrincipal(deviceId),
    }),
    eventLogPath: log,
    deviceSessionKey: key,
    clock: () => new Date(now),
    authenticateCaptain: async (r) =>
      r.headers.get("authorization") === "Bearer fixture-captain-token"
        ? { captainId: "captain", steerSourceLane: "api" }
        : undefined,
    authenticateOperator: async (r) =>
      r.headers.get("authorization") === "Bearer fixture-owner" ? { operatorId: "owner" } : undefined,
    ...(hosted
      ? {
          hostedPairing: new HostedPairing(
            new HostedBodyClient(hf.bootstrap, { clock: () => now }),
            generateKeyPairSync("ed25519").privateKey,
            { clock: () => now },
          ),
        }
      : {}),
  });
  cleanups.push(async () => {
    await store.close();
    service.close();
    rmSync(root, { recursive: true, force: true });
  });
  const seen: { path: string; token: string | null; body: unknown }[] = [];
  let selfCount = 0;
  const hooks: {
    before?: (request: Request) => Promise<void>;
    after?: (request: Request, response: Response) => Promise<Response>;
    self?: (response: Response, count: number) => Promise<Response>;
  } = {};
  const controlFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    expect(new URL(request.url).origin).toBe("http://control.fixture");
    seen.push({
      path: new URL(request.url).pathname,
      token: request.headers.get("authorization"),
      body: request.method === "POST" ? await request.clone().json() : undefined,
    });
    await hooks.before?.(request);
    const hookRequest = request.clone();
    let response = await service.app.fetch(request);
    if (new URL(request.url).pathname === "/v1/devices/self")
      response = (await hooks.self?.(response, ++selfCount)) ?? response;
    return (await hooks.after?.(hookRequest, response)) ?? response;
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
    return (
      await client().projectProposalGet!({
        conversationId: id,
        requestId: q.requestId,
        incarnationId: q.incarnationId,
      })
    ).proposal!.target;
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
    writeSettings,
    key,
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
  "explicit original-device proposal and CREATE roundtrip hosted=%s never uses captain identity",
  async (hosted) => {
    const f = await fixture(hosted);
    await f.send();
    const target = await f.target();
    expect(f.writeSettings).not.toHaveBeenCalled();
    const result = await f.client().projectProposalConfirm!(target);
    expect(result.status).toBe("created");
    expect(await f.client().projectProposalConfirm!(target)).toEqual(result);
    expect(f.writeSettings).toHaveBeenCalledTimes(1);
    const dispatches = f.seen.filter(
      (s) => s.path === "/operator/v1/dispatch" || s.path === "/v1/hosted/operator",
    );
    expect(dispatches.every((d) => d.token === `Bearer ${f.tokens.control}`)).toBe(true);
    expect(JSON.stringify(f.messages)).not.toContain(f.tokens.control!);
    expect(f.continuation).not.toHaveBeenCalled();
  },
);
it("relay refuses chat-only/different owner/wrong signer and never substitutes captain for missing owner upstream", async () => {
  const f = await fixture();
  await f.send();
  const target = await f.target();
  for (const token of [
    f.tokens.read!,
    f.tokens.other!,
    "fixture-captain-token",
    new DeviceSessionSigner(Buffer.alloc(32, 9)).issue(
      mintDeviceSessionClaims({
        deviceId: "control",
        nowEpochSeconds: Math.floor(Date.now() / 1000),
        ttlSeconds: 60,
      }),
    ),
  ]) {
    const r = await f.raw({ op: "project_proposal_confirm", schemaVersion: 1, ...target }, token);
    expect([401, 403]).toContain(r.status);
  }
  expect(f.writeSettings).not.toHaveBeenCalled();
});
it("revocation between relay admission and owner dispatch prevents CREATE", async () => {
  const f = await fixture();
  await f.send();
  const target = await f.target();
  let revoked = false;
  f.hooks.before = async (request) => {
    if (!revoked && request.url.endsWith("/operator/v1/dispatch")) {
      revoked = true;
      await f.revoke("control");
    }
  };
  const r = await f.raw({ op: "project_proposal_confirm", schemaVersion: 1, ...target });
  expect([401, 403]).toContain(r.status);
  expect(f.writeSettings).not.toHaveBeenCalled();
});
it("lost CREATE response reconciles the consumed target without another write", async () => {
  const f = await fixture();
  await f.send();
  const target = await f.target();
  let dropped = false;
  f.hooks.after = async (request, response) => {
    if (
      !dropped &&
      request.url.endsWith("/operator/v1/dispatch") &&
      (await request.json()).op === "project_proposal_confirm"
    ) {
      dropped = true;
      throw Error("response lost");
    }
    return response;
  };
  const first = await f.raw({ op: "project_proposal_confirm", schemaVersion: 1, ...target });
  expect(first.ok).toBe(false);
  expect((await f.client().projectProposalConfirm!(target)).status).toBe("created");
  expect(f.writeSettings).toHaveBeenCalledTimes(1);
});
