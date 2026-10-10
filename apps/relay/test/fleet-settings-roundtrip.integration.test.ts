import {
  HOST_SETTINGS_PATH,
  HostSettingsSnapshotSchema,
} from "../../../packages/protocol/src/owner-settings.ts";
import { PersonaAttentionSnapshotSchema } from "../../../packages/protocol/src/discord-attention.ts";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ClankieApiClient } from "../../../packages/api-client/src/index.ts";
import {
  FLEET_HIRE_DEFAULTS_PATH,
  FleetHireDefaultsSnapshotSchema,
  MachineWorkerAccountsSchema,
  OPERATOR_PERSONA_PATH,
  ProjectsSettingsSchema,
  TAKE_CONTROL_GRANTS,
  WORKER_ACCOUNT_HOLDS_PATH,
  WorkerAccountHoldsSchema,
  workerAccountsRoute,
} from "../../../packages/protocol/src/index.ts";
import { SettingsStore } from "../../../packages/settings/src/index.ts";
import {
  VIEWS_PATH,
  ViewListSchema,
  ViewRenderSchema,
  ViewResultSchema,
  viewPath,
} from "../../../packages/protocol/src/views.ts";
import { publicGatewayTargetFor } from "../../../packages/protocol/src/public-gateway.ts";
import { ViewStore } from "../../clankie/src/views.ts";
import { createClankieApp } from "../../clankie/src/app.ts";
import { createStubCaptain } from "../../clankie/src/captain/port.ts";
import { DeviceSessionSigner, mintDeviceSessionClaims } from "../../clankie/src/device-session.ts";
import { HostedBodyClient } from "../../clankie/src/hosted-body.ts";
import { HostedPairing } from "../../clankie/src/hosted-pairing.ts";
import { hostedFixture } from "../../clankie/test/fixtures/hosted-body.ts";
import { ControlPlaneDeviceAuthorizer } from "../src/device-auth.ts";
import { createOperatorConversationRelayHandler } from "../src/operator-conversations.ts";

const cleanups: Array<() => Promise<void>> = [];
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
  if (!address || typeof address === "string") throw new Error("Fixture TCP listener unavailable");
  return `http://127.0.0.1:${address.port}`;
}
async function fixture(options: { unavailableAwakeRegistry?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "fleet-settings-relay-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    projects: ProjectsSettingsSchema.parse({ projects: [{ id: "garden", name: "Garden" }] }),
  }));
  const hf = hostedFixture();
  const key = randomBytes(32),
    signer = new DeviceSessionSigner(key);
  const names = ["control", "hosted", "hosted-read", "chat", "steer"] as const;
  const tokens = Object.fromEntries(
    names.map((deviceId) => [
      deviceId,
      signer.issue(
        mintDeviceSessionClaims({ deviceId, nowEpochSeconds: Math.floor(hf.now / 1000), ttlSeconds: 600 }),
      ),
    ]),
  ) as Record<(typeof names)[number], string>;
  const events = names.flatMap((deviceId) => {
    const grants =
      deviceId === "control" || deviceId === "hosted"
        ? TAKE_CONTROL_GRANTS
        : { chat: true, steer: deviceId !== "chat", terminalObserve: true, terminalControl: false };
    const base = {
      occurredAt: new Date(hf.now).toISOString(),
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
          name: deviceId,
          platform: "ios",
          offeredGrants: grants,
          mintedBy: deviceId.startsWith("hosted") ? "hosted-account-operator" : "local-owner",
          pendingExpiresAt: new Date(hf.now + 600_000).toISOString(),
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
          sessionExpiresAt: new Date(hf.now + 600_000).toISOString(),
        },
      },
    ];
  });
  const eventLogPath = join(root, "events.jsonl");
  await writeFile(eventLogPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  let captainCalls = 0;
  const service = await createClankieApp({
    captain: createStubCaptain({
      serveOperatorConversation: async () => {
        captainCalls++;
        throw new Error("Settings cannot use captain conversations");
      },
    }),
    settings,
    views: new ViewStore(join(root, "views"), () => hf.now),
    ...(options.unavailableAwakeRegistry
      ? {
          applyKeepAwake: async () => {
            await readFile(join(root, "missing-awake-registry"));
          },
        }
      : {}),
    eventLogPath,
    deviceSessionKey: key,
    clock: () => new Date(hf.now),
    hostedPairing: new HostedPairing(
      new HostedBodyClient(hf.bootstrap, { clock: () => hf.now }),
      generateKeyPairSync("ed25519").privateKey,
      { clock: () => hf.now },
    ),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
    workerAccounts: async (fleet) => ({
      machine: fleet ?? "local",
      shell: "posix",
      observedAt: new Date(hf.now).toISOString(),
      accounts: [
        {
          harness: "codex",
          label: "work",
          home: "/Users/owner/.codex-work",
          signedIn: true,
          identity: "owner@example.com",
          headroom: 0.4,
          usable: true,
        },
      ],
    }),
  });
  cleanups.push(async () => {
    service.close();
  });
  const controlUrl = await listen(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === "string") headers.set(name, value);
      else if (value) value.forEach((entry) => headers.append(name, entry));
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
  const forwarded: Array<{ path: string; token: string }> = [];
  const hooks: { before?: (() => Promise<void>) | undefined; after?: (() => Promise<void>) | undefined } = {};
  const handler = createOperatorConversationRelayHandler({
    authorizeDevice: new ControlPlaneDeviceAuthorizer({ baseUrl: controlUrl }),
    dispatch: async () => {
      captainCalls++;
      throw new Error("Settings cannot use captain dispatch");
    },
    roomRequest: async (path, method, token, body) => {
      forwarded.push({ path, token });
      await hooks.before?.();
      const result = await fetch(new URL(path, controlUrl), {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body }),
        redirect: "error",
      });
      await hooks.after?.();
      return result;
    },
  });
  const relayUrl = await listen(async (request, response) => {
    if (!(await handler(request, response))) {
      response.statusCode = 404;
      response.end();
    }
  });
  const revoke = async (deviceId: string) => {
    const result = await fetch(`${controlUrl}/v1/devices/${deviceId}/revoke`, {
      method: "POST",
      headers: { authorization: "Bearer owner" },
    });
    expect(result.status).toBe(200);
  };
  return {
    root,
    settings,
    service,
    tokens,
    forwarded,
    hooks,
    revoke,
    relayUrl,
    controlUrl,
    now: hf.now,
    captainCalls: () => captainCalls,
  };
}

it("round-trips owner settings through real relay/device/service HTTP and persistence using only the original device identity", async () => {
  const f = await fixture();
  for (const device of ["control", "hosted"] as const) {
    const client = new ClankieApiClient({ baseUrl: f.relayUrl, operatorToken: f.tokens[device] });
    const fleet = await client.fleetSettings();
    expect(fleet.workingPreferences).toBe(true);
    const updated = await client.updateFleetSettings({
      schemaVersion: 1,
      expectedRevision: fleet.revision,
      changes: {
        closure: "owner",
        commit: "owner",
        push: "owner",
        release: { mode: "time_rule", rule: "Release after the last v* tag is more than one week old." },
        verification: "review_and_seal",
        reportingStyle: "Short and plain.",
      },
    });
    expect(updated.fleet.closure).toBe("owner");
    expect(updated.fleet.release).toEqual({
      mode: "time_rule",
      rule: "Release after the last v* tag is more than one week old.",
    });
    const projects = await client.projects();
    expect(projects.workingPreferences).toBe(true);
    expect(projects.autonomyDefaults?.fleet.closure).toBe("owner");
    const project = await client.updateProjectSettings({
      projectId: "garden",
      expectedRevision: projects.revision,
      changes: { autonomy: { fleet: { machineSetup: "owner", commit: "lead", release: { mode: "owner" } } } },
    });
    expect(project.settings.projects[0]!.autonomy?.fleet?.machineSetup).toBe("owner");
    expect(project.settings.projects[0]!.autonomy?.fleet?.release).toEqual({ mode: "owner" });
    expect(f.forwarded.slice(-4).every((entry) => entry.token === f.tokens[device])).toBe(true);
  }
  expect(f.captainCalls()).toBe(0);
  expect((await new SettingsStore(f.settings.path).load()).autonomy.fleet.closure).toBe("owner");
  expect((await new SettingsStore(f.settings.path).load()).autonomy.fleet.verification).toBe(
    "review_and_seal",
  );
});

it("refuses chat and steer devices before any settings or captain hop, and denies hosted operator elevation without its mint and terminalControl proof", async () => {
  const f = await fixture();
  const before = await f.settings.load();
  for (const device of ["chat", "steer", "hosted-read"] as const) {
    const client = new ClankieApiClient({ baseUrl: f.relayUrl, operatorToken: f.tokens[device] });
    await expect(client.fleetSettings()).rejects.toThrow("403");
    await expect(
      client.updateFleetSettings({
        schemaVersion: 1,
        expectedRevision: "a".repeat(64),
        changes: { closure: "owner" },
      }),
    ).rejects.toThrow("403");
    await expect(
      client.updateProjectSettings({
        projectId: "garden",
        expectedRevision: "a".repeat(64),
        changes: { autonomy: { fleet: { closure: "owner" } } },
      }),
    ).rejects.toThrow("403");
  }
  for (const device of ["control", "hosted-read"] as const) {
    const result = await fetch(`${f.controlUrl}/v1/hosted/operator`, {
      method: "POST",
      headers: { authorization: `Bearer ${f.tokens[device]}`, "content-type": "application/json" },
      body: JSON.stringify({ method: "GET", path: "/v1/operator/fleet-settings" }),
    });
    expect(result.status).toBe(403);
  }
  expect(f.forwarded).toEqual([]);
  expect(f.captainCalls()).toBe(0);
  expect(await f.settings.load()).toEqual(before);
});

it("revalidates real revocation during relay work and keeps unknown queries and filesystem context out of this portal", async () => {
  const f = await fixture();
  const client = new ClankieApiClient({ baseUrl: f.relayUrl, operatorToken: f.tokens.control });
  const fleet = await client.fleetSettings();
  f.hooks.before = () => f.revoke("control");
  await expect(
    client.updateFleetSettings({
      schemaVersion: 1,
      expectedRevision: fleet.revision,
      changes: { closure: "owner" },
    }),
  ).rejects.toThrow("401");
  expect((await f.settings.load()).autonomy.fleet.closure).toBe("lead");
  f.hooks.before = undefined;
  f.hooks.after = () => f.revoke("hosted");
  const hosted = new ClankieApiClient({ baseUrl: f.relayUrl, operatorToken: f.tokens.hosted });
  await expect(hosted.fleetSettings()).rejects.toThrow("401");
  f.hooks.after = undefined;
  const count = f.forwarded.length;
  for (const path of [
    "/v1/operator/projects?includeAutonomy=false",
    "/v1/operator/projects?includeAutonomy=true&unknown=true",
    "/v1/operator/projects?includeAutonomy=true&includeAutonomy=true",
    "/v1/operator/fleet-settings/context?workingDirectory=/tmp&machine=local",
  ]) {
    const result = await fetch(`${f.relayUrl}${path}`, {
      headers: { authorization: `Bearer ${f.tokens.chat}` },
    });
    expect([400, 404]).toContain(result.status);
  }
  expect(f.forwarded).toHaveLength(count);
  expect(f.captainCalls()).toBe(0);
});

it("carries talkativeness, hire defaults and worker-account holds for a control device, and nothing wider", async () => {
  const f = await fixture();
  await f.settings.update((current) => ({
    ...current,
    persona: { ...current.persona, characterNotes: "private notes" },
    fleet: { ...current.fleet, hire: { harness: "codex", account: "work" } },
  }));
  const call = (path: string, body?: unknown, device: keyof typeof f.tokens = "control") =>
    fetch(`${f.relayUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${f.tokens[device]}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const persona = await call(OPERATOR_PERSONA_PATH);
  expect(persona.status).toBe(200);
  // The relay answers with talkativeness only; owner notes never reach the device.
  const attention = PersonaAttentionSnapshotSchema.parse(await persona.json());
  expect(attention.persona).toEqual({ chattiness: "balanced", replyPolicy: "all" });
  expect(
    (
      await call(OPERATOR_PERSONA_PATH, {
        expectedRevision: attention.revision,
        persona: { chattiness: "chatty" },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call(OPERATOR_PERSONA_PATH, {
        expectedRevision: attention.revision,
        persona: { characterNotes: "rewritten" },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call(OPERATOR_PERSONA_PATH, {
        expectedRevision: attention.revision,
        persona: { displayName: "Not him", chattiness: "quiet" },
      })
    ).status,
  ).toBe(400);

  const hire = FleetHireDefaultsSnapshotSchema.parse(await (await call(FLEET_HIRE_DEFAULTS_PATH)).json());
  expect(hire.hire).toEqual({ harness: "codex" });
  const cleared = await call(FLEET_HIRE_DEFAULTS_PATH, {
    schemaVersion: 1,
    expectedRevision: hire.revision,
    changes: { harness: "auto", effort: "high" },
  });
  expect(FleetHireDefaultsSnapshotSchema.parse(await cleared.json()).hire).toEqual({ effort: "high" });

  const accounts = MachineWorkerAccountsSchema.parse(
    await (await call(workerAccountsRoute("pc-work"))).json(),
  );
  expect(accounts.machine).toBe("pc-work");
  expect((await call("/v1/worker-accounts?fleet=PC")).status).toBe(400);
  const holds = WorkerAccountHoldsSchema.parse(await (await call(WORKER_ACCOUNT_HOLDS_PATH)).json());
  const held = await call(WORKER_ACCOUNT_HOLDS_PATH, {
    expectedRevision: holds.revision,
    machine: "pc-work",
    harness: "codex",
    label: "work",
    held: true,
  });
  expect(WorkerAccountHoldsSchema.parse(await held.json()).holds).toEqual([
    { machine: "pc-work", harness: "codex", label: "work" },
  ]);

  const saved = await new SettingsStore(f.settings.path).load();
  expect(saved.persona).toMatchObject({ chattiness: "chatty", characterNotes: "private notes" });
  expect(saved.fleet.hire).toEqual({ account: "work", effort: "high" });
  expect(saved.workerAccountHolds).toHaveLength(1);
  expect(f.forwarded.every((entry) => entry.token === f.tokens.control)).toBe(true);

  const forwarded = f.forwarded.length;
  for (const device of ["chat", "steer", "hosted-read"] as const) {
    expect((await call(OPERATOR_PERSONA_PATH, undefined, device)).status).toBe(403);
    expect(
      (await call(WORKER_ACCOUNT_HOLDS_PATH, { harness: "codex", label: "work", held: false }, device))
        .status,
    ).toBe(403);
  }
  expect(f.forwarded).toHaveLength(forwarded);
  expect(f.captainCalls()).toBe(0);
});

it("preserves a validated saved host receipt through device relay when runtime application fails", async () => {
  const f = await fixture({ unavailableAwakeRegistry: true });
  await f.settings.update((current) => ({ ...current, host: { ...current.host, keepAwake: true } }));
  const headers = { authorization: `Bearer ${f.tokens.control}`, "content-type": "application/json" };
  const snapshot = HostSettingsSnapshotSchema.parse(
    await (await fetch(`${f.relayUrl}${HOST_SETTINGS_PATH}`, { headers })).json(),
  );
  const response = await fetch(`${f.relayUrl}${HOST_SETTINGS_PATH}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      schemaVersion: 1,
      expectedRevision: snapshot.revision,
      changes: { keepAwake: false },
    }),
  });
  expect(response.status).toBe(503);
  const receipt = await response.json();
  expect(receipt).toMatchObject({ error: "keep_awake_apply_failed", saved: true });
  const saved = HostSettingsSnapshotSchema.parse(receipt.settings);
  expect(saved.host.keepAwake).toBe(false);
  expect(saved.revision).not.toBe(snapshot.revision);
  const reconciled = HostSettingsSnapshotSchema.parse(
    await (await fetch(`${f.relayUrl}${HOST_SETTINGS_PATH}`, { headers })).json(),
  );
  expect(reconciled).toEqual(saved);
  expect((await new SettingsStore(f.settings.path).load()).host.keepAwake).toBe(false);
  expect(f.forwarded.every((entry) => entry.token === f.tokens.control)).toBe(true);
  expect(f.captainCalls()).toBe(0);
});

it("carries the owner's views to a control device, unavailable sources included, and to no one else (VUH-2042)", async () => {
  const f = await fixture();
  const call = (path: string, body?: unknown, device: keyof typeof f.tokens = "control") =>
    fetch(`${f.relayUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${f.tokens[device]}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const spec = {
    title: "Heavy queue",
    sources: { fleet: { kind: "fleet_resources" } },
    panels: [{ source: "fleet", show: "queue", resource: "heavy" }],
  };
  const created = await call(VIEWS_PATH, { action: "create", spec });
  expect(created.status).toBe(200);
  const { view } = ViewResultSchema.parse(await created.json());
  expect(view.spec.refreshSeconds).toBe(5);
  expect(ViewListSchema.parse(await (await call(VIEWS_PATH)).json()).views.map((v) => v.id)).toEqual([
    view.id,
  ]);
  // This host runs no fleet resources: the source says why instead of failing the view.
  const render = ViewRenderSchema.parse(await (await call(viewPath(view.id))).json());
  expect(render.sources.fleet).toMatchObject({ state: "unavailable", kind: "fleet_resources" });
  const pinned = ViewResultSchema.parse(
    await (await call(VIEWS_PATH, { action: "pin", id: view.id })).json(),
  );
  expect(pinned.view).toMatchObject({ pinned: true, expiresAtMs: null });
  const unpinned = ViewResultSchema.parse(
    await (await call(VIEWS_PATH, { action: "unpin", id: view.id })).json(),
  );
  expect(unpinned.view.expiresAtMs).toBeGreaterThan(f.now);
  expect(await (await call(VIEWS_PATH, { action: "expire", id: view.id })).json()).toEqual({
    expired: view.id,
  });
  expect((await call(viewPath(view.id))).status).toBe(404);
  // Every one of these is reachable from a remote device through the public gateway.
  expect(publicGatewayTargetFor("GET", viewPath(view.id))).toBe("relay");
  expect(publicGatewayTargetFor("GET", `${VIEWS_PATH}/../fleet-settings`)).toBeUndefined();
  expect(f.forwarded.every((entry) => entry.token === f.tokens.control)).toBe(true);

  const forwarded = f.forwarded.length;
  // A spec the contract refuses never reaches the service; nor does a chat or steer device.
  expect((await call(VIEWS_PATH, { action: "create", spec: { ...spec, panels: [] } })).status).toBe(400);
  expect((await call(`${VIEWS_PATH}/view_NOTANID`)).status).toBe(404);
  for (const device of ["chat", "steer"] as const) {
    expect((await call(VIEWS_PATH, undefined, device)).status).toBe(403);
    expect((await call(VIEWS_PATH, { action: "create", spec }, device)).status).toBe(403);
  }
  expect(f.forwarded).toHaveLength(forwarded);
  expect(f.captainCalls()).toBe(0);
});
