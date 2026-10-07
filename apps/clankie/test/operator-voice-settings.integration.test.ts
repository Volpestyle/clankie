import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import {
  FileCredentialStore,
  ensureOperatorCredential,
  rotateOperatorCredential,
} from "@clankie/credential-broker";
import { TAKE_CONTROL_GRANTS } from "@clankie/protocol";
import { DeviceSessionSigner, mintDeviceSessionClaims } from "../src/device-session.ts";
import { SettingsStore } from "@clankie/settings";
import { afterEach, expect, it } from "vitest";
import { createClankieApp, type ClankieAppDependencies } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createCredentialBackedOperatorAuthenticator } from "../src/operator-auth.ts";

type SettingsSource = NonNullable<ClankieAppDependencies["settings"]>;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Real HTTP, schema, credential broker and atomic settings file. The captain is
// an unrelated boundary: these routes must never invoke a model or voice body.
async function fixture(
  options: {
    settings?: (store: SettingsStore) => SettingsSource;
    operatorUnavailable?: boolean;
    paired?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "operator-voice-settings-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const settings = new SettingsStore(join(root, "settings.json"));
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const owner = await ensureOperatorCredential({ env: {}, store: credentials });
  await credentials.set("anthropic", { type: "api", key: "sk-ant-fixture-secret-never-returned" });
  const deviceKey = randomBytes(32);
  const eventLogPath = join(root, "events.jsonl");
  const now = Date.now();
  const deviceId = "voice-control-device";
  const envelope = {
    occurredAt: new Date(now).toISOString(),
    missionId: `device:${deviceId}`,
    correlationId: "voice-paired-fixture",
    profileHash: "fixture",
  };
  if (options.paired)
    await writeFile(
      eventLogPath,
      [
        {
          ...envelope,
          id: randomUUID(),
          type: "device.pairing.redeemed",
          data: {
            schemaVersion: 1,
            deviceId,
            offerId: "voice-offer",
            name: "Phone",
            platform: "ios",
            offeredGrants: TAKE_CONTROL_GRANTS,
            mintedBy: "local-operator",
            pendingExpiresAt: new Date(now + 600_000).toISOString(),
          },
        },
        {
          ...envelope,
          id: randomUUID(),
          type: "device.activated",
          data: {
            schemaVersion: 1,
            deviceId,
            grants: TAKE_CONTROL_GRANTS,
            sessionExpiresAt: new Date(now + 600_000).toISOString(),
          },
        },
      ]
        .map((value) => JSON.stringify(value))
        .join("\n") + "\n",
    );
  const deviceToken = new DeviceSessionSigner(deviceKey).issue(
    mintDeviceSessionClaims({ deviceId, nowEpochSeconds: Math.floor(now / 1_000), ttlSeconds: 600 }),
  );
  const service = await createClankieApp({
    captain: createStubCaptain(),
    ...(options.paired ? { eventLogPath, deviceSessionKey: deviceKey } : {}),
    settings: options.settings?.(settings) ?? settings,
    ...(options.operatorUnavailable
      ? {}
      : {
          authenticateOperator: createCredentialBackedOperatorAuthenticator({
            env: {},
            store: credentials,
            identity: { operatorId: "fixture-owner" },
          }),
        }),
  });
  cleanups.push(async () => {
    service.close();
  });
  const server = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture server address");
  const url = `http://127.0.0.1:${address.port}/v1/operator/voice`;
  const request = async (method = "GET", body?: unknown, token: string | null = owner.token) => {
    let input = body;
    if (
      method === "POST" &&
      body !== null &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      !("expectedRevision" in body)
    ) {
      const current = await settings.load();
      input = {
        expectedRevision: createHash("sha256").update(JSON.stringify(current.voice)).digest("hex"),
        voice: { ...current.voice, ...body },
      };
    }
    return fetch(url, {
      method,
      headers: {
        connection: "close",
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(input === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
  };
  return { settings, credentials, owner, request, url, deviceId, deviceToken };
}

it("reads defaults without creating a file and protects voice settings with current owner credentials", async () => {
  const f = await fixture();
  for (const token of [null, "wrong-operator", "captain-bearer", "paired-device-bearer"]) {
    expect((await f.request("GET", undefined, token)).status).toBe(401);
    expect((await f.request("POST", { realtimeProvider: "xai" }, token)).status).toBe(401);
  }
  const response = await f.request();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({
    voice: { realtimeProvider: "openai", ttsProvider: "openai", xAiReasoningEffort: "high" },
  });
  await expect(readFile(f.settings.path)).rejects.toMatchObject({ code: "ENOENT" });
  const rotated = await rotateOperatorCredential({ env: {}, store: f.credentials });
  expect((await f.request()).status).toBe(401);
  expect((await f.request("GET", undefined, rotated.token)).status).toBe(200);
});

it("persists a validated Anthropic voice patch and preserves persona and inactive provider settings", async () => {
  const f = await fixture();
  await f.settings.update((value) => ({
    ...value,
    persona: { ...value.persona, displayName: "Voice fixture" },
    voice: {
      ...value.voice,
      openAiRealtimeModel: "gpt-realtime-2.1",
      xAiVoice: "eve",
      xAiReasoningEffort: "none",
    },
  }));
  const response = await f.request("POST", {
    realtimeProvider: "anthropic",
    anthropicModel: "claude-sonnet-5-5",
    ttsProvider: "elevenlabs",
    elevenLabsVoiceId: "fixture-voice",
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({
    voice: {
      realtimeProvider: "anthropic",
      anthropicModel: "claude-sonnet-5-5",
      ttsProvider: "elevenlabs",
      elevenLabsVoiceId: "fixture-voice",
      openAiRealtimeModel: "gpt-realtime-2.1",
      xAiVoice: "eve",
      xAiReasoningEffort: "none",
    },
    restart: "Restart the active Discord body to apply voice settings.",
  });
  const snapshot = await (await f.request()).json();
  const updates = await Promise.all([
    f.request("POST", {
      expectedRevision: snapshot.revision,
      voice: { ...snapshot.voice, anthropicModel: "claude-opus-4-8" },
    }),
    f.request("POST", {
      expectedRevision: snapshot.revision,
      voice: { ...snapshot.voice, elevenLabsModelId: "eleven_v4_turbo" },
    }),
  ]);
  expect(updates.map((update) => update.status).sort()).toEqual([200, 409]);
  await f.request("POST", { anthropicModel: "claude-opus-4-8", elevenLabsModelId: "eleven_v4_turbo" });
  const persisted = await new SettingsStore(f.settings.path).load();
  expect(persisted.voice).toMatchObject({
    realtimeProvider: "anthropic",
    ttsProvider: "elevenlabs",
    xAiReasoningEffort: "none",
    anthropicModel: "claude-opus-4-8",
    elevenLabsModelId: "eleven_v4_turbo",
  });
  expect(persisted.persona.displayName).toBe("Voice fixture");
  const publicResult = await (await f.request()).text();
  expect(publicResult).not.toContain("sk-ant-");
  expect(publicResult).not.toContain(f.owner.token);
  expect(publicResult).not.toContain("Voice fixture");
  expect(await readFile(f.settings.path, "utf8")).not.toContain("sk-ant-");
});

it("rejects malformed, secret-shaped and incompatible voice patches without changing durable settings", async () => {
  const f = await fixture();
  await f.settings.update((value) => value);
  const original = await readFile(f.settings.path, "utf8");
  for (const body of [
    null,
    [],
    "voice",
    { realtimeProvider: "unsupported" },
    { apiKey: "sk-ant-fixture-secret" },
    { anthropicModel: "sk-ant-fixture-secret" },
    { anthropicModel: "" },
    { openAiVoice: 2 },
    { realtimeProvider: "anthropic" },
    { realtimeProvider: "anthropic", ttsProvider: "elevenlabs" },
    { realtimeProvider: "xai", ttsProvider: "elevenlabs", elevenLabsVoiceId: "fixture-voice" },
  ]) {
    const response = await f.request("POST", body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "malformed" });
    expect(await readFile(f.settings.path, "utf8")).toBe(original);
  }
  const malformedJson = await fetch(f.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${f.owner.token}`,
      "content-type": "application/json",
      connection: "close",
    },
    body: "{broken",
  });
  expect(malformedJson.status).toBe(400);
  expect(await readFile(f.settings.path, "utf8")).toBe(original);
});

it("refuses a queued write if the real owner credential rotates before atomic persistence", async () => {
  const entered = deferred();
  const resume = deferred();
  const f = await fixture({
    settings: (store) => ({
      load: () => store.load(),
      update: (mutate, guard) =>
        store.update(mutate, async () => {
          entered.resolve();
          await resume.promise;
          await guard?.();
        }),
    }),
  });
  await f.settings.update((value) => value);
  const original = await readFile(f.settings.path, "utf8");
  const pending = f.request("POST", { realtimeProvider: "xai" });
  await entered.promise;
  const rotated = await rotateOperatorCredential({ env: {}, store: f.credentials });
  resume.resolve();
  const response = await pending;
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "operator_authentication_required" });
  expect(await readFile(f.settings.path, "utf8")).toBe(original);
  expect((await f.request("POST", { realtimeProvider: "xai" }, rotated.token)).status).toBe(200);
  expect((await new SettingsStore(f.settings.path).load()).voice.realtimeProvider).toBe("xai");
});

it("discards a private settings read when owner authority rotates while the file read is pending", async () => {
  const entered = deferred();
  const resume = deferred();
  const f = await fixture({
    settings: (store) => ({
      load: async () => {
        const snapshot = await store.load();
        entered.resolve();
        await resume.promise;
        return snapshot;
      },
    }),
  });
  await f.settings.update((value) => ({
    ...value,
    voice: { ...value.voice, anthropicModel: "private-fixture-model" },
  }));
  const pending = f.request();
  await entered.promise;
  await rotateOperatorCredential({ env: {}, store: f.credentials });
  resume.resolve();
  const response = await pending;
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "operator_authentication_required" });
});

it("reports unavailable authentication, read-only stores and invalid stored settings without exposing their bytes", async () => {
  const unavailable = await fixture({ operatorUnavailable: true });
  expect(await (await unavailable.request()).json()).toEqual({
    error: "operator_authentication_unavailable",
  });
  expect((await unavailable.request("POST", {})).status).toBe(503);
  const readOnly = await fixture({ settings: (store) => ({ load: () => store.load() }) });
  expect((await readOnly.request()).status).toBe(200);
  const write = await readOnly.request("POST", { realtimeProvider: "xai" });
  expect(write.status).toBe(503);
  expect(await write.json()).toEqual({ error: "settings_unavailable" });
  await writeFile(readOnly.settings.path, '{"voice":{"apiKey":"sk-ant-invalid-stored-fixture"}}');
  const invalidRead = await readOnly.request();
  expect(invalidRead.status).toBe(503);
  expect(await invalidRead.json()).toEqual({ error: "settings_unavailable" });
});

it("refuses a persona write when the real owner credential rotates before persistence", async () => {
  const entered = deferred();
  const resume = deferred();
  const f = await fixture({
    settings: (store) => ({
      load: () => store.load(),
      update: (mutate, guard) =>
        store.update(mutate, async () => {
          entered.resolve();
          await resume.promise;
          await guard?.();
        }),
    }),
  });
  await f.settings.update((value) => value);
  const original = await readFile(f.settings.path, "utf8");
  const url = f.url.replace(/voice$/u, "persona");
  const headers = {
    authorization: `Bearer ${f.owner.token}`,
    "content-type": "application/json",
    connection: "close",
  };
  const snapshot = await (await fetch(url, { headers })).json();
  const pending = fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      expectedRevision: snapshot.revision,
      persona: { displayName: "Refused stale owner" },
    }),
  });
  await entered.promise;
  await rotateOperatorCredential({ env: {}, store: f.credentials });
  resume.resolve();
  expect((await pending).status).toBe(401);
  expect(await readFile(f.settings.path, "utf8")).toBe(original);
});

it("lets a current Take Control device read and set voice and refuses its queued write after revocation", async () => {
  const entered = deferred();
  const resume = deferred();
  let block = false;
  const f = await fixture({
    paired: true,
    settings: (store) => ({
      load: () => store.load(),
      update: (mutate, guard) =>
        store.update(mutate, async () => {
          if (block) {
            entered.resolve();
            await resume.promise;
          }
          await guard?.();
        }),
    }),
  });
  expect((await f.request("GET", undefined, f.deviceToken)).status).toBe(200);
  expect((await f.request("POST", { realtimeProvider: "xai" }, f.deviceToken)).status).toBe(200);
  const original = await readFile(f.settings.path, "utf8");
  block = true;
  const pending = f.request("POST", { xAiRealtimeModel: "refused-after-revoke" }, f.deviceToken);
  await entered.promise;
  const revoked = await fetch(f.url.replace(/operator\/voice$/u, `devices/${f.deviceId}/revoke`), {
    method: "POST",
    headers: { authorization: `Bearer ${f.owner.token}`, connection: "close" },
  });
  expect(revoked.status).toBe(200);
  resume.resolve();
  expect((await pending).status).toBe(401);
  expect(await readFile(f.settings.path, "utf8")).toBe(original);
  expect((await f.request("GET", undefined, f.deviceToken)).status).toBe(401);
});
