import { createServer } from "node:http";
import { BodyLeaseStore } from "../../../apps/clankie/src/body-leases.ts";
import { BodyVoiceStays } from "../../../apps/clankie/src/body-voice-stays.ts";
import { DiscordRoomVoice } from "../../../apps/clankie/src/discord-room-voice.ts";
import { runDiscordCommand } from "../../../apps/tui/src/command/discord.ts";
import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { VoiceProviderReadinessSchema } from "@clankie/protocol";
import { readVoiceProviderReadiness } from "../src/voice-provider-readiness.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function provider(reply?: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), "voice-readiness-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of server.clients) socket.terminate();
        server.close(() => resolve());
      }),
  );
  let connections = 0;
  let closes = 0;
  const sent: Record<string, unknown>[] = [];
  server.on("connection", (socket, request) => {
    connections++;
    expect(request.headers.authorization).toBe("Bearer private-fixture-key");
    socket.on("close", () => {
      closes++;
    });
    socket.on("message", (data) => {
      sent.push(JSON.parse(data.toString()));
      socket.send(JSON.stringify({ type: "session.created", session: {} }));
      if (reply) socket.send(JSON.stringify(reply));
    });
  });
  const address = server.address();
  if (typeof address !== "object" || !address) throw new Error("missing fake provider address");
  return {
    root,
    sent,
    counts: () => ({ connections, closes }),
    options: {
      provider: "openai" as const,
      enabled: true,
      env: { CLANKIE_STATE: root },
      baseUrl: `ws://127.0.0.1:${address.port}/v1/realtime`,
      getApiKey: async () => "private-fixture-key",
    },
  };
}

// VUH-2728 comment 13db1bbe: the inspected live error, carried by an error event.
const exhausted = {
  type: "error",
  error: {
    type: "insufficient_quota",
    code: "credit_balance_exhausted",
    message:
      "You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.",
    param: null,
    event_id: null,
  },
};

it("reports the live quota frame before any call and shares a content-free cache across concurrent readers", async () => {
  const fake = await provider(exhausted);
  const first = await readVoiceProviderReadiness(fake.options);
  expect(VoiceProviderReadinessSchema.parse(first)).toMatchObject({
    state: "refused",
    providerCode: "credit_balance_exhausted",
    cached: false,
  });
  // Production status projection, HTTP, protocol client and headless call read:
  // the body is idle and no join/control endpoint is exposed by this fixture.
  const leases = new BodyLeaseStore(join(fake.root, "leases"));
  cleanups.push(async () => leases.close());
  const stays = new BodyVoiceStays(leases, join(fake.root, "stays.json"));
  const control = new DiscordRoomVoice(
    stays,
    leases,
    async (path) => {
      expect(path).toBe("/voice/status");
      return Response.json({
        active: false,
        outputMuted: false,
        activity: "idle",
        consentedParticipantCount: 0,
        activeCaptureCount: 0,
        handoffCount: 0,
      });
    },
    async () => ({}),
    () => readVoiceProviderReadiness(fake.options),
  );
  const http = createServer(async (request, response) => {
    if (
      request.url !== "/v1/discord/room-voice" ||
      request.headers.authorization !== "Bearer fixture-operator"
    ) {
      response.writeHead(403).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(await control.status()));
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  cleanups.push(() => new Promise<void>((resolve) => http.close(() => resolve())));
  const httpAddress = http.address();
  if (!httpAddress || typeof httpAddress === "string") throw new Error("missing HTTP address");
  const call = await runDiscordCommand(["call"], {
    host: `http://127.0.0.1:${httpAddress.port}`,
    env: { CLANKIE_OPERATOR_TOKEN: "fixture-operator" },
  });
  expect(call).toMatchObject({
    state: "idle",
    providerReadiness: {
      state: "refused",
      providerCode: "credit_balance_exhausted",
      cached: true,
    },
  });
  const repeated = await Promise.all(
    Array.from({ length: 12 }, () => readVoiceProviderReadiness(fake.options)),
  );
  expect(repeated.every((value) => value.cached && value.providerCode === "credit_balance_exhausted")).toBe(
    true,
  );
  expect(fake.counts().connections).toBe(1);
  // This is the actual provider protocol: no audio append/commit or response.create.
  expect(fake.sent.map((frame) => frame.type)).toEqual(["session.update"]);
  const directory = join(fake.root, "voice-provider-readiness");
  const records = await Promise.all(
    (await readdir(directory)).map((file) => readFile(join(directory, file), "utf8")),
  );
  expect(JSON.stringify([first, repeated, records])).not.toMatch(
    /private-fixture-key|You have no credits|authorization/i,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(fake.counts().closes).toBe(1);
});

it("reserves the cache before a provider answers, so concurrent doctor reads open only one socket", async () => {
  const fake = await provider({ type: "session.updated", session: {} });
  const results = await Promise.all(
    Array.from({ length: 12 }, () => readVoiceProviderReadiness(fake.options)),
  );
  expect(results.some((value) => value.state === "ready")).toBe(true);
  expect(results.every((value) => value.state === "checking" || value.state === "ready")).toBe(true);
  expect(fake.counts().connections).toBe(1);
  expect((await readVoiceProviderReadiness(fake.options)).cached).toBe(true);
});

it("bounds and caches an unconfirmed provider and closes the socket without generating anything", async () => {
  const fake = await provider();
  const before = Date.now();
  expect(await readVoiceProviderReadiness(fake.options)).toMatchObject({
    state: "unconfirmed",
    cached: false,
  });
  expect(Date.now() - before).toBeLessThan(6_000);
  expect(await readVoiceProviderReadiness(fake.options)).toMatchObject({
    state: "unconfirmed",
    cached: true,
  });
  expect(fake.counts().connections).toBe(1);
  expect(fake.sent.map((frame) => frame.type)).toEqual(["session.update"]);
});

it("does not contact a provider when voice is disabled or its API key is missing", async () => {
  const fake = await provider(exhausted);
  expect(await readVoiceProviderReadiness({ ...fake.options, enabled: false })).toMatchObject({
    state: "disabled",
  });
  expect(
    await readVoiceProviderReadiness({ ...fake.options, getApiKey: async () => undefined }),
  ).toMatchObject({ state: "missing_key" });
  expect(fake.counts().connections).toBe(0);
});

it("refreshes expired results once and refuses to bypass unavailable cache storage", async () => {
  const fake = await provider(exhausted);
  await readVoiceProviderReadiness(fake.options);
  const directory = join(fake.root, "voice-provider-readiness");
  const [file] = await readdir(directory);
  if (!file) throw new Error("missing cache");
  const path = join(directory, file);
  const value = JSON.parse(await readFile(path, "utf8"));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, JSON.stringify({ ...value, expiresAt: new Date(Date.now() - 1).toISOString() }));
  expect(await readVoiceProviderReadiness(fake.options)).toMatchObject({ state: "refused", cached: false });
  expect(fake.counts().connections).toBe(2);
  const blocked = join(fake.root, "not-a-directory");
  await writeFile(blocked, "fixture");
  expect(
    await readVoiceProviderReadiness({ ...fake.options, env: { CLANKIE_STATE: blocked } }),
  ).toMatchObject({ state: "unavailable" });
  expect(fake.counts().connections).toBe(2);
});
