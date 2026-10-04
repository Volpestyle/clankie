import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsStore } from "../../../packages/settings/src/index.ts";
import {
  OperatorConversationServiceResultSchema,
  SUPERVISE_GRANTS,
  TAKE_CONTROL_GRANTS,
  createOperatorConversationServiceClient,
  type OperatorConversationServiceRequest,
} from "../../../packages/protocol/src/index.ts";
import { hostedOperatorAllows } from "../../../packages/protocol/src/hosted-operator.ts";
import type { WorkItemWriteRequest } from "../../../packages/protocol/src/work-item-write.ts";
import { createClankieApp } from "../../clankie/src/app.ts";
import { createStubCaptain } from "../../clankie/src/captain/port.ts";
import { DeviceSessionSigner, mintDeviceSessionClaims } from "../../clankie/src/device-session.ts";
import { HostedBodyClient } from "../../clankie/src/hosted-body.ts";
import { HostedPairing } from "../../clankie/src/hosted-pairing.ts";
import { projectWorkRepoId } from "../../clankie/src/project-work-items.ts";
import { createWorkItemsService } from "../../clankie/src/work-items.ts";
import { hostedFixture } from "../../clankie/test/fixtures/hosted-body.ts";
import {
  createCaptainConversationDispatch,
  createDeviceConversationDispatch,
} from "../src/conversation-upstream.ts";
import { ControlPlaneDeviceAuthorizer } from "../src/device-auth.ts";
import { createOperatorConversationRelayHandler } from "../src/operator-conversations.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => Promise<unknown>) {
  const server = createServer((request, response) => {
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

async function fixture(options: { hosted?: boolean; deviceDispatch?: boolean } = {}) {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "relay-work-write-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, ".clankie"), { recursive: true });
  await mkdir(join(workspace, "tasks"));
  const itemPath = join(workspace, "tasks", "T-1-relay.md");
  const original =
    '---\nid: T-1\ntitle: Relay-owned item\nstatus: todo\nlabels: ["Developer"]\ndepends_on: []\n---\n\n**Owner:** previous\n\nOwner-authored notes.\n';
  await writeFile(itemPath, original);
  await writeFile(
    join(workspace, ".clankie", "tracking.json"),
    JSON.stringify({
      schemaVersion: 1,
      backend: "markdown",
      directory: "tasks",
      decidedBy: "owner",
      decidedAt: "2026-10-04T00:00:00.000Z",
    }),
  );
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    projects: {
      ...current.projects,
      projects: [
        {
          id: "relay-work",
          name: "Relay work",
          workspaces: [
            {
              id: "local",
              machineId: "fixture-machine",
              path: workspace,
              platform: process.platform === "win32" ? "windows" : "posix",
            },
          ],
          worktreeRoots: [],
          roles: [],
          labelRoleMap: [],
          grants: [],
          trackerRef: { workspaceId: "local", path: ".clankie/tracking.json" },
        },
      ],
    },
  }));
  const stateDirectory = join(root, "state");
  const workItems = createWorkItemsService({
    stateDirectory,
    projects: async () => (await settings.load()).projects,
    projectsFence: async () => {
      const snapshot = await settings.loadFenced();
      return { projects: snapshot.settings.projects, assertCurrent: snapshot.assertCurrent };
    },
    localMachineId: "fixture-machine",
    run: async () => {
      throw new Error("No external command may run in this fixture");
    },
  });
  const hf = hostedFixture();
  const now = hf.now;
  const key = randomBytes(32);
  const signer = new DeviceSessionSigner(key);
  const names = ["control", "other", "read", "unminted"] as const;
  const tokens = Object.fromEntries(
    names.map((deviceId) => [
      deviceId,
      signer.issue(
        mintDeviceSessionClaims({ deviceId, nowEpochSeconds: Math.floor(now / 1000), ttlSeconds: 600 }),
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
          name: "Same display name",
          platform: "ios",
          offeredGrants: grants,
          mintedBy: options.hosted && deviceId !== "unminted" ? "hosted-account-operator" : "local-owner",
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
  const eventLogPath = join(root, "events.jsonl");
  await writeFile(eventLogPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  const captainServe = vi.fn(async () => {
    throw new Error("Work writes must not enter the captain conversation route");
  });
  const service = await createClankieApp({
    settings,
    workItems,
    captain: createStubCaptain({ serveOperatorConversation: captainServe }),
    eventLogPath,
    deviceSessionKey: key,
    clock: () => new Date(now),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer fixture-owner" ? { operatorId: "owner" } : undefined,
    authenticateCaptain: async (request) =>
      request.headers.get("authorization") === "Bearer fixture-captain-token"
        ? { captainId: "captain", steerSourceLane: "api" }
        : undefined,
    ...(options.hosted
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
    service.close();
  });
  // Both portal hops use real loopback HTTP; only the external work backend is a temporary file.
  const controlUrl = await listen(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === "string") headers.set(name, value);
      else if (value) for (const entry of value) headers.append(name, entry);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    const result = await service.app.fetch(
      new Request(`http://${request.headers.host}${request.url}`, {
        method: request.method ?? "GET",
        headers,
        ...(body ? { body } : {}),
      }),
    );
    response.statusCode = result.status;
    result.headers.forEach((value, name) => response.setHeader(name, value));
    response.end(Buffer.from(await result.arrayBuffer()));
  });
  const seen: { path: string; token: string | null; body: unknown }[] = [];
  const hooks: { beforeOwner?: () => Promise<void>; loseWriteResponse?: boolean } = {};
  const controlFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const body = request.method === "POST" ? await request.clone().json() : undefined;
    seen.push({ path, token: request.headers.get("authorization"), body });
    if (path !== "/v1/devices/self") await hooks.beforeOwner?.();
    const result = await fetch(request);
    const op =
      path === "/v1/hosted/operator"
        ? JSON.parse((body as { body: string }).body).op
        : (body as { op?: string } | undefined)?.op;
    if (hooks.loseWriteResponse && op === "work_item_write") {
      await result.arrayBuffer();
      throw new Error("Fixture lost a completed write response");
    }
    return result;
  };
  const authorizeDevice = new ControlPlaneDeviceAuthorizer({ baseUrl: controlUrl, fetch: controlFetch });
  const dispatch = vi.fn(
    createCaptainConversationDispatch({
      baseUrl: controlUrl,
      bearerToken: "fixture-captain-token",
      fetch: controlFetch,
    }),
  );
  const messages: unknown[] = [];
  const handler = createOperatorConversationRelayHandler({
    authorizeDevice,
    dispatch,
    ...(options.deviceDispatch === false
      ? {}
      : { deviceDispatch: createDeviceConversationDispatch({ baseUrl: controlUrl, fetch: controlFetch }) }),
    logger: { info: (fields) => messages.push(fields), warn: (fields) => messages.push(fields) },
  });
  const relayUrl = await listen(handler);
  const raw = (request: OperatorConversationServiceRequest, token = tokens.control!) =>
    fetch(`${relayUrl}/operator/v1/dispatch`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  const client = (token = tokens.control!) =>
    createOperatorConversationServiceClient(async (request) => {
      const response = await raw(request, token);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return OperatorConversationServiceResultSchema.parse(await response.json());
    });
  const request = (): WorkItemWriteRequest => ({
    repoId: projectWorkRepoId("relay-work"),
    itemId: "T-1",
    requestId: randomUUID(),
    command: { action: "assign", owner: "relay-worker" },
  });
  const revoke = async () => {
    const response = await fetch(`${controlUrl}/v1/devices/control/revoke`, {
      method: "POST",
      headers: { authorization: "Bearer fixture-owner" },
    });
    expect(response.status).toBe(200);
  };
  return {
    tokens,
    seen,
    hooks,
    dispatch,
    captainServe,
    messages,
    client,
    raw,
    request,
    revoke,
    original,
    itemPath,
    eventLogPath,
    receiptPath: join(stateDirectory, "work-write-receipts.json"),
  };
}

it.each([false, true])(
  "real owner HTTP roundtrip hosted=%s retains original device identity and reads its exact receipt without mutation",
  async (hosted) => {
    const f = await fixture({ hosted });
    const request = f.request();
    const result = await f.client().workItemWrite!(request);
    expect(result).toMatchObject({
      requestId: request.requestId,
      outcome: "applied",
      item: { id: "T-1", owner: "relay-worker" },
    });
    const item = await readFile(f.itemPath, "utf8");
    const journal = await readFile(f.receiptPath, "utf8");
    expect(item).toContain("Owner-authored notes.");
    expect(JSON.parse(journal)).toEqual([
      expect.objectContaining({
        id: request.requestId,
        state: "settled",
        scope: expect.objectContaining({
          owner: { kind: "device", id: "control" },
          repoId: request.repoId,
          itemId: request.itemId,
        }),
      }),
    ]);
    const { command: _command, ...target } = request;
    expect(await f.client().workItemWriteReceipt!(target)).toEqual(result);
    expect(await f.client().workItemWriteReceipt!({ ...target, requestId: randomUUID() })).toMatchObject({
      outcome: "refused",
    });
    expect(await readFile(f.receiptPath, "utf8")).toBe(journal);
    expect(await readFile(f.itemPath, "utf8")).toBe(item);
    const hops = f.seen.filter((entry) => entry.path !== "/v1/devices/self");
    expect(hops).toHaveLength(3);
    expect(
      hops.every(
        (entry) =>
          entry.path === (hosted ? "/v1/hosted/operator" : "/operator/v1/dispatch") &&
          entry.token === `Bearer ${f.tokens.control}`,
      ),
    ).toBe(true);
    if (hosted)
      for (const hop of hops) {
        const envelope = hop.body as { method: string; path: string; body: string };
        expect(envelope).toMatchObject({ method: "POST", path: "/operator/v1/dispatch" });
        expect(hostedOperatorAllows(envelope.method, envelope.path, envelope.body)).toBe(true);
      }
    expect(await f.client(f.tokens.other!).workItemWriteReceipt!(target)).toEqual({
      requestId: request.requestId,
      outcome: "refused",
      message: "No matching work-item write receipt for this owner, item, and binding. Nothing dispatched.",
    });
    const audits = (await readFile(f.eventLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.type.startsWith("work.item.write."));
    expect(audits).toHaveLength(2);
    expect(
      audits.every(
        (event) => event.data.principal.kind === "device" && event.data.principal.id === "control",
      ),
    ).toBe(true);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.captainServe).not.toHaveBeenCalled();
    expect(JSON.stringify(f.messages)).not.toContain(f.tokens.control);
  },
);

it("refuses both write and receipt operations without terminalControl before any owner or captain hop", async () => {
  const f = await fixture();
  const request = f.request();
  const { command: _command, ...target } = request;
  for (const operation of [
    { op: "work_item_write", schemaVersion: 1, request },
    { op: "work_item_write_receipt", schemaVersion: 1, ...target },
  ] as const) {
    const response = await f.raw(operation, f.tokens.read!);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "terminal_control_grant_required" });
  }
  expect(f.seen.every((entry) => entry.path === "/v1/devices/self")).toBe(true);
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.captainServe).not.toHaveBeenCalled();
  expect(existsSync(f.receiptPath)).toBe(false);
  expect(await readFile(f.itemPath, "utf8")).toBe(f.original);
});

it("missing device dispatch returns unavailable for both operations without captain fallback", async () => {
  const f = await fixture({ deviceDispatch: false });
  const request = f.request();
  const { command: _command, ...target } = request;
  for (const operation of [
    { op: "work_item_write", schemaVersion: 1, request },
    { op: "work_item_write_receipt", schemaVersion: 1, ...target },
  ] as const) {
    const response = await f.raw(operation);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "conversation_owner_upstream_unavailable" });
  }
  expect(f.seen.every((entry) => entry.path === "/v1/devices/self")).toBe(true);
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.captainServe).not.toHaveBeenCalled();
  expect(existsSync(f.receiptPath)).toBe(false);
  expect(await readFile(f.itemPath, "utf8")).toBe(f.original);
});

it("an unminted hosted device cannot use either owner write route or fall back to local authority", async () => {
  const f = await fixture({ hosted: true });
  const request = f.request();
  const { command: _command, ...target } = request;
  for (const operation of [
    { op: "work_item_write", schemaVersion: 1, request },
    { op: "work_item_write_receipt", schemaVersion: 1, ...target },
  ] as const) {
    const response = await f.raw(operation, f.tokens.unminted!);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "conversation_owner_upstream_refused" });
  }
  expect(f.seen.some((entry) => entry.path === "/v1/hosted/operator")).toBe(true);
  expect(f.seen.some((entry) => entry.path === "/operator/v1/dispatch")).toBe(false);
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(existsSync(f.receiptPath)).toBe(false);
  expect(await readFile(f.itemPath, "utf8")).toBe(f.original);
});

it("revalidates the original device at the real owner hop after relay admission", async () => {
  const f = await fixture();
  f.hooks.beforeOwner = f.revoke;
  const response = await f.raw({ op: "work_item_write", schemaVersion: 1, request: f.request() });
  expect(response.status).toBe(401);
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.captainServe).not.toHaveBeenCalled();
  expect(existsSync(f.receiptPath)).toBe(false);
  expect(await readFile(f.itemPath, "utf8")).toBe(f.original);
});

it("lost applied response yields original-ID uncertainty and is recovered only by a read-only receipt call", async () => {
  const f = await fixture();
  const request = f.request();
  f.hooks.loseWriteResponse = true;
  expect(await f.client().workItemWrite!(request)).toMatchObject({
    requestId: request.requestId,
    outcome: "uncertain",
  });
  const item = await readFile(f.itemPath, "utf8");
  const journal = await readFile(f.receiptPath, "utf8");
  f.hooks.loseWriteResponse = false;
  const { command: _command, ...target } = request;
  expect(await f.client().workItemWriteReceipt!(target)).toMatchObject({
    requestId: request.requestId,
    outcome: "applied",
    item: { owner: "relay-worker" },
  });
  expect(await readFile(f.itemPath, "utf8")).toBe(item);
  expect(await readFile(f.receiptPath, "utf8")).toBe(journal);
  expect(
    f.seen.filter((entry) => (entry.body as { op?: string } | undefined)?.op === "work_item_write"),
  ).toHaveLength(1);
  expect(
    f.seen.filter((entry) => (entry.body as { op?: string } | undefined)?.op === "work_item_write_receipt"),
  ).toHaveLength(1);
  expect(f.dispatch).not.toHaveBeenCalled();
});
