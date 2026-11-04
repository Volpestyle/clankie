import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "@hono/node-server";
import { afterEach, expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { FileCredentialStore } from "@clankie/credential-broker";
import { TAKE_CONTROL_GRANTS, SUPERVISE_GRANTS } from "@clankie/protocol";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { DeviceSessionSigner, mintDeviceSessionClaims } from "../src/device-session.ts";
import { MachineJoins } from "../src/machine-joins.ts";
import { ReviewGate } from "../src/captain/review-gate.ts";
import type { ModelKeysPort } from "../src/model-keys.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

// Owner-route declarations share a decision, while each handler keeps its own validation.
const ownerRoutes: Array<{ method: string; path: string; body?: object }> = [
  {
    method: "GET",
    path: "/v1/harness-logins",
  },
  {
    method: "GET",
    path: "/v1/harness-logins/accounts",
  },
  {
    method: "GET",
    path: "/v1/harness-logins/install",
  },
  {
    method: "GET",
    path: "/v1/model-keys",
  },
  {
    method: "GET",
    path: "/v1/model-settings",
  },
  {
    method: "GET",
    path: "/v1/model-keys/subscriptions",
  },
  {
    method: "GET",
    path: "/v1/model-keys/subscriptions/methods",
  },
  {
    method: "GET",
    path: "/v1/model-keys/options",
  },
  {
    method: "GET",
    path: "/v1/model-keys/local",
  },
  {
    method: "GET",
    path: "/v1/captain/seat",
  },
  {
    method: "GET",
    path: "/v1/worker-accounts/pi",
  },
  {
    method: "GET",
    path: "/v1/operator/http-settings",
  },
  {
    method: "GET",
    path: "/v1/operator/host-settings",
  },
  {
    method: "GET",
    path: "/v1/settings/evidence-storage",
  },
  {
    method: "GET",
    path: "/v1/operator/maximum-trust-mode",
  },
  {
    method: "GET",
    path: "/v1/operator/foreign-heavy-permits",
  },
  {
    method: "GET",
    path: "/v1/accounts/codex",
  },
  {
    method: "GET",
    path: "/v1/accounts",
  },
  {
    method: "GET",
    path: "/v1/operator/fleet-resources",
  },
  {
    method: "GET",
    path: "/v1/operator/fleet-resources/simulators",
  },
  {
    method: "GET",
    path: "/v1/operator/reviews/landing",
  },
  {
    method: "GET",
    path: "/v1/operator/reviews",
  },
  {
    method: "GET",
    path: "/v1/operator/projects",
  },
  {
    method: "GET",
    path: "/v1/setup/survey",
  },
  {
    method: "GET",
    path: "/v1/operator/fleet-settings",
  },
  {
    method: "GET",
    path: "/v1/operator/fleet-settings/hire",
  },
  {
    method: "GET",
    path: "/v1/operator/fleet-settings/context",
  },
  {
    method: "GET",
    path: "/v1/operator/runtime-health",
  },
  {
    method: "GET",
    path: "/v1/worker-accounts/holds",
  },
  {
    method: "GET",
    path: "/v1/worker-accounts/budgets",
  },
  {
    method: "GET",
    path: "/v1/usage",
  },
  {
    method: "GET",
    path: "/v1/usage/settings",
  },
  {
    method: "GET",
    path: "/v1/huddles",
  },
  {
    method: "GET",
    path: "/v1/fleet/asks",
  },
  {
    method: "GET",
    path: "/v1/worker-accounts",
  },
  {
    method: "GET",
    path: "/v1/runtime-connections/fixture/membership",
  },
  {
    method: "POST",
    path: "/v1/operator/reviews/waivers",
    body: {},
  },
  {
    method: "POST",
    path: "/v1/fleet/asks/fixture/answer",
    body: {},
  },
  {
    method: "POST",
    path: "/v1/operator/projects/create",
    body: {},
  },
  {
    method: "POST",
    path: "/v1/machine-joins/approve",
    body: {},
  },
];

async function fixture(withModels = false) {
  const root = await mkdtemp(join(tmpdir(), "owner-route-device-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const now = Date.now(),
    key = new Uint8Array(32).fill(37),
    events = join(root, "events.jsonl");
  const settings = new SettingsStore(join(root, "settings.json"));
  const originals = [
    { deviceId: "account", mintedBy: "hosted-account", grants: TAKE_CONTROL_GRANTS },
    { deviceId: "account-child", mintedBy: "device:account", grants: TAKE_CONTROL_GRANTS },
    { deviceId: "account-grandchild", mintedBy: "device:account-child", grants: TAKE_CONTROL_GRANTS },
    { deviceId: "supervise", mintedBy: "hosted-account", grants: SUPERVISE_GRANTS },
  ];
  const rows = originals.flatMap(({ deviceId, mintedBy, grants }) => {
    const base = {
      occurredAt: new Date(now - 1000).toISOString(),
      missionId: `device:${deviceId}`,
      correlationId: "owner-route-proof",
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
          mintedBy,
          offeredGrants: grants,
          offerId: deviceId,
          name: deviceId,
          platform: "macos",
          pendingExpiresAt: new Date(now + 60000).toISOString(),
        },
      },
      {
        ...base,
        id: randomUUID(),
        type: "device.activated",
        data: { schemaVersion: 1, deviceId, grants, sessionExpiresAt: new Date(now + 3600000).toISOString() },
      },
    ];
  });
  await writeFile(events, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const signer = new DeviceSessionSigner(key);
  const token = (deviceId: string) =>
    signer.issue(
      mintDeviceSessionClaims({ deviceId, nowEpochSeconds: Math.floor(now / 1000), ttlSeconds: 3600 }),
    );
  let beforePersist: (() => Promise<void>) | undefined;
  const update = settings.update.bind(settings);
  settings.update = (mutate, guard) =>
    update(mutate, async () => {
      const action = beforePersist;
      beforePersist = undefined;
      await action?.();
      await guard?.();
    });
  let beforeReview: (() => Promise<void>) | undefined;
  const reviews = new ReviewGate({
    path: join(root, "reviews.json"),
    directoryProject: async () => "fixture",
    review: async () => {
      const action = beforeReview;
      beforeReview = undefined;
      await action?.();
      return { seat: "reviewer" };
    },
    seat: async () => undefined,
    resolve: async () => undefined,
    seatProject: async () => "fixture",
    reviewers: async () => [],
    lead: () => undefined,
    deliver: async () => {
      throw Error("No native send in owner-route proof");
    },
    notifyLead: async () => {},
  });
  let beforeSubscription: (() => Promise<void>) | undefined,
    subscriptionWrites = 0;
  const models = {
    startSubscription: async (_input, authority) => {
      const action = beforeSubscription;
      beforeSubscription = undefined;
      await action?.();
      const committed = await authority.commit(async () => {
        subscriptionWrites++;
      });
      return committed
        ? {
            ok: true,
            sessionId: randomUUID(),
            providerId: "openai-codex",
            state: "complete",
            expiresAt: new Date(now + 3600000).toISOString(),
          }
        : { ok: false, error: "forbidden" };
    },
  } as ModelKeysPort;
  const joins = new MachineJoins({
    settings,
    secrets: new FileCredentialStore(join(root, "credentials.json")),
    directory: join(root, "joins"),
  });
  const service = await createClankieApp({
    captain: { ...createStubCaptain(), reviews },
    settings,
    machineJoins: joins,
    ...(withModels ? { modelKeys: models } : {}),
    eventLogPath: events,
    deviceSessionKey: key,
    isSameMacRequest: (request) => new URL(request.url).hostname === "127.0.0.1",
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer fixture-owner"
        ? { operatorId: "fixture-owner" }
        : undefined,
    authenticateCaptain: async (request) =>
      request.headers.get("authorization") === "Bearer fixture-captain"
        ? { captainId: "fixture-captain" }
        : undefined,
  });
  cleanup.push(async () => service.close());
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: service.app.fetch });
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  cleanup.push(async () => {
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing owned listener");
  const request = async (
    path: string,
    bearer: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
  const pair = async (bearer: string) => {
    const offer = await request("/v1/pairing/offer", bearer, {});
    expect(offer.status).toBe(200);
    const pending = await request("/v1/pairing/redeem", "", {
      code: offer.data.code,
      device: { name: "Owner test device", platform: "macos" },
    });
    expect(pending.status).toBe(200);
    const complete = await request("/v1/pairing/complete", "", {
      completionToken: pending.data.completionToken,
      acceptedGrants: TAKE_CONTROL_GRANTS,
    });
    expect(complete.status).toBe(200);
    return { id: complete.data.deviceId as string, token: complete.data.deviceToken as string };
  };
  const owner = await pair("fixture-owner"),
    ownerChild = await pair(owner.token);
  return {
    settings,
    request,
    token,
    owner,
    ownerChild,
    reviews,
    events,
    revoke: async (id: string) => {
      expect((await request(`/v1/devices/${id}/revoke`, "fixture-owner", {})).status).toBe(200);
    },
    beforePersist: (action: () => Promise<void>) => {
      beforePersist = action;
    },
    beforeReview: (action: () => Promise<void>) => {
      beforeReview = action;
    },
    beforeSubscription: (action: () => Promise<void>) => {
      beforeSubscription = action;
    },
    subscriptionWrites: () => subscriptionWrites,
  };
}

it.each(["account", "account-child"])(
  "owner routes share the device decision across the HTTP matrix (%s)",
  async (principal) => {
    const f = await fixture();
    expect(ownerRoutes).toHaveLength(40);
    for (const route of ownerRoutes) {
      const denied = await f.request(route.path, f.token(principal), route.body, route.method);
      expect(denied.status, `${principal}: ${route.method} ${route.path}`).toBe(403);
      for (const owner of [f.owner, f.ownerChild]) {
        const allowed = await f.request(route.path, owner.token, route.body, route.method);
        expect([200, 400, 503], `${route.method} ${route.path}`).toContain(allowed.status);
      }
    }
  },
  60000,
);

it("keeps owner and owner-child choices usable and operator-only routes separate", async () => {
  const f = await fixture();
  for (const owner of [f.owner, f.ownerChild]) {
    const result = await f.request("/v1/operator/maximum-trust-mode", owner.token, {
      schemaVersion: 1,
      enabled: true,
    });
    expect(result.status).toBe(200);
    expect((await f.settings.load()).maximumTrustMode).toBe(true);
    expect(
      (await f.request("/v1/operator/maximum-trust-mode", owner.token, { schemaVersion: 1, enabled: false }))
        .status,
    ).toBe(200);
    for (const path of ["/v1/machines", "/v1/runtime-connections"])
      expect((await f.request(path, owner.token)).status).toBe(401);
  }
  for (const bearer of ["untrusted-worker", "joined-host", "fixture-captain", ""])
    expect(
      (await f.request("/v1/operator/maximum-trust-mode", bearer, { schemaVersion: 1, enabled: true }))
        .status,
    ).toBe(401);
  expect((await f.request("/v1/operator/maximum-trust-mode", f.token("supervise"))).status).toBe(403);
});

it("renews owner sessions and supervised sessions with their existing scope", async () => {
  const f = await fixture();
  for (const id of ["account", "account-child", "account-grandchild"]) {
    const before = (await readFile(f.events, "utf8"))
      .split("\n")
      .filter((line) => line.includes('"device.session.refreshed"')).length;
    expect((await f.request("/v1/devices/self/session/refresh", f.token(id), {})).status).toBe(403);
    const after = (await readFile(f.events, "utf8"))
      .split("\n")
      .filter((line) => line.includes('"device.session.refreshed"')).length;
    expect(after).toBe(before);
  }
  for (const owner of [f.owner, f.ownerChild]) {
    const refreshed = await f.request("/v1/devices/self/session/refresh", owner.token, {});
    expect(refreshed.status).toBe(200);
    expect(refreshed.data.grants.terminalControl).toBe(true);
  }
  const supervise = await f.request("/v1/devices/self/session/refresh", f.token("supervise"), {});
  expect(supervise.status).toBe(200);
  expect(supervise.data.grants.terminalControl).toBe(false);
});

it.each(["games", "joins"])("rechecks the owner at the settings commit (%s)", async (target) => {
  const f = await fixture();
  f.beforePersist(() => f.revoke(f.owner.id));
  const result =
    target === "games"
      ? await f.request("/v1/games/configuration", f.owner.token, (await f.settings.load()).gameplay, "PUT")
      : await f.request("/v1/machine-joins/settings", f.owner.token, { enabled: false }, "PATCH");
  expect(result.status).toBe(409);
  expect((await f.settings.load()).legacyMachineJoins).toBe(true);
});

it("rechecks the owner after waiver policy awaits, before persisting the review decision", async () => {
  const f = await fixture();
  const patch = Buffer.from(
    "diff --git a/proof.txt b/proof.txt\nnew file mode 100644\nindex 0000000..7898192\n--- /dev/null\n+++ b/proof.txt\n@@ -0,0 +1 @@\n+proof\n",
  );
  const hash = spawnSync("git", ["patch-id", "--verbatim"], { input: patch, encoding: "utf8" });
  expect(hash.status).toBe(0);
  const patchId = hash.stdout.trim().split(/\s+/u)[0]!;
  const input = {
    schemaVersion: 1,
    directory: "/fixture",
    reason: "Fixture reviewed decision",
    base: "a".repeat(40),
    head: "b".repeat(40),
    patchId,
    patch: patch.toString("base64"),
  };
  f.beforeReview(() => f.revoke(f.owner.id));
  const refused = await f.request("/v1/operator/reviews/waivers", f.owner.token, input);
  expect(refused.status).toBe(403);
  expect(f.reviews.list()).toHaveLength(0);
  expect((await f.request("/v1/operator/reviews/waivers", f.ownerChild.token, input)).status).toBe(200);
  expect(f.reviews.list()).toHaveLength(1);
});

it("uses the shared owner decision for views and subscription commits", async () => {
  const f = await fixture(true);
  expect((await f.request("/v1/operator/views", f.token("account-child"))).status).toBe(403);
  expect((await f.request("/v1/operator/views", f.ownerChild.token)).status).toBe(503);
  const input = { providerId: "openai-codex", method: "device", model: "openai-codex/gpt-5.4" };
  expect(
    (await f.request("/v1/model-keys/subscriptions/start", f.token("account-child"), input)).status,
  ).toBe(403);
  expect((await f.request("/v1/model-keys/subscriptions/start", f.ownerChild.token, input)).data.ok).toBe(
    true,
  );
  expect(f.subscriptionWrites()).toBe(1);
  f.beforeSubscription(() => f.revoke(f.owner.id));
  const revoked = await f.request("/v1/model-keys/subscriptions/start", f.owner.token, input);
  expect(revoked.data).toMatchObject({ ok: false, error: "forbidden" });
  expect(f.subscriptionWrites()).toBe(1);
});
