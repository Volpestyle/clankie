import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileDoctrine, loadDoctrineFile } from "@clankie/doctrine";
import { SqliteEventStore } from "@clankie/event-store";
import { SUPERVISE_GRANTS, type DeviceGrantSet } from "@clankie/protocol";
import type { Hono } from "hono";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createControlPlane,
  createDeterministicWorkerSteerAuthorizer,
  type WorkerSteerAuthorizer,
} from "../src/app.ts";
import { DeviceSessionSigner } from "../src/device-session.ts";

const DEVICE_KEY = Uint8Array.from(Buffer.alloc(32, 19));
const NOW = new Date("2026-07-19T18:00:00.000Z");
const OPERATOR_HEADERS = { authorization: "Bearer operator-secret" };
const RUNNER_HEADERS = {
  authorization: "Bearer runner-secret",
  "content-type": "application/json",
  "x-clankie-runner-id": "runner-test",
};
const tempDirs: string[] = [];

let doctrine: ReturnType<typeof compileDoctrine>;

beforeAll(async () => {
  doctrine = compileDoctrine([
    await loadDoctrineFile(resolve(import.meta.dirname, "../../../doctrine/profiles/self-build-lab.yaml")),
  ]);
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("paired-device worker steering", () => {
  it("queues an authorized finite intent with honest device authority and preserves envelope checks", async () => {
    const fixture = await makeFixture();
    const device = await pairDevice(fixture.app, SUPERVISE_GRANTS);
    const request = steerRequest("device-steer-1", "device-correlation-1");

    const spoofed = await steer(fixture, device.token, {
      ...request,
      commandId: "device-steer-spoofed",
      sourceLane: "tui",
    });
    expect(spoofed.status).toBe(403);
    await expect(spoofed.json()).resolves.toEqual({ error: "steer_source_lane_mismatch" });

    const accepted = await steer(fixture, device.token, request);
    expect(accepted.status).toBe(202);
    const acceptedBody = await accepted.json();
    expect(acceptedBody).toMatchObject({
      accepted: true,
      command: {
        commandId: request.commandId,
        sourceLane: "api",
        principal: { kind: "device", id: device.deviceId },
        intent: request.intent,
        contentRedacted: true,
      },
    });
    expect(JSON.stringify(acceptedBody)).not.toContain(device.token);
    expect(acceptedBody).not.toHaveProperty("command.grants");

    const duplicate = await steer(fixture, device.token, request);
    expect(duplicate.status).toBe(202);

    const crossPrincipalDuplicate = await steer(fixture, "captain-secret", request);
    expect(crossPrincipalDuplicate.status).toBe(409);
    await expect(crossPrincipalDuplicate.json()).resolves.toEqual({ error: "duplicate_command_id" });

    const claimed = await fixture.app.request("/v1/runner/steering/claim", {
      method: "POST",
      headers: RUNNER_HEADERS,
      body: JSON.stringify({ workerRunId: fixture.workerRunId, attempt: 1 }),
    });
    expect(claimed.status).toBe(200);
    await expect(claimed.json()).resolves.toMatchObject({
      command: {
        commandId: request.commandId,
        sourceLane: "api",
        principal: { kind: "device", id: device.deviceId },
        input: "Focus on the acceptance criteria.",
      },
    });

    const steerEvents = (await fixture.store.readAll()).filter(
      ({ event }) => event.type === "worker.steer.requested",
    );
    expect(steerEvents).toHaveLength(1);
    expect(steerEvents[0]?.event.data).toMatchObject({
      principal: { kind: "device", id: device.deviceId },
      sourceLane: "api",
      intent: request.intent,
      contentRedacted: true,
    });
    const serialized = JSON.stringify(steerEvents);
    expect(serialized).not.toContain(device.token);
    expect(serialized).not.toContain('"grants"');
  });

  it("denies an active device whose current steer grant is disabled without mutation", async () => {
    let policyCalls = 0;
    const fixture = await makeFixture(async (input) => {
      policyCalls += 1;
      return createDeterministicWorkerSteerAuthorizer()(input);
    });
    const device = await pairDevice(fixture.app, { ...SUPERVISE_GRANTS, steer: false });

    const response = await steer(fixture, device.token, {
      ...steerRequest("grant-denied", "grant-correlation"),
      grants: { steer: true },
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "steer_device_grant_required" });
    expect(policyCalls).toBe(0);
    expect((await fixture.store.readAll()).some(({ event }) => event.type === "worker.steer.requested")).toBe(
      false,
    );
  });

  it("fails closed for missing, invalid, expired, pending, and revoked device sessions", async () => {
    const fixture = await makeFixture();
    const request = steerRequest("auth-denied", "auth-correlation");

    const missing = await steer(fixture, undefined, request);
    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toEqual({ error: "steer_device_session_invalid" });

    const invalid = await steer(fixture, "not-a-device-session", request);
    expect(invalid.status).toBe(401);
    await expect(invalid.json()).resolves.toEqual({ error: "steer_device_session_invalid" });

    const expiredToken = new DeviceSessionSigner(DEVICE_KEY).issue({
      version: 1,
      deviceId: "device-expired",
      issuedAt: Math.floor(NOW.getTime() / 1000) - 120,
      expiresAt: Math.floor(NOW.getTime() / 1000) - 60,
      nonce: "expired-session-nonce",
    });
    const expired = await steer(fixture, expiredToken, request);
    expect(expired.status).toBe(401);
    await expect(expired.json()).resolves.toEqual({ error: "steer_device_session_expired" });

    const pending = await redeemDevice(fixture.app);
    const pendingToken = new DeviceSessionSigner(DEVICE_KEY).issue({
      version: 1,
      deviceId: pending.deviceId,
      issuedAt: Math.floor(NOW.getTime() / 1000),
      expiresAt: Math.floor(NOW.getTime() / 1000) + 60,
      nonce: "pending-session-nonce",
    });
    const pendingResponse = await steer(fixture, pendingToken, request);
    expect(pendingResponse.status).toBe(401);
    await expect(pendingResponse.json()).resolves.toEqual({ error: "steer_device_session_invalid" });

    const revokedDevice = await pairDevice(fixture.app, SUPERVISE_GRANTS);
    const revoked = await fixture.app.request(`/v1/devices/${revokedDevice.deviceId}/revoke`, {
      method: "POST",
      headers: OPERATOR_HEADERS,
    });
    expect(revoked.status).toBe(200);
    const revokedSteer = await steer(fixture, revokedDevice.token, request);
    expect(revokedSteer.status).toBe(401);
    await expect(revokedSteer.json()).resolves.toEqual({ error: "steer_device_revoked" });

    expect((await fixture.store.readAll()).some(({ event }) => event.type === "worker.steer.requested")).toBe(
      false,
    );
  });
});

async function makeFixture(authorizeWorkerSteer?: WorkerSteerAuthorizer) {
  const root = await mkdtemp(join(tmpdir(), "clankie-device-steering-"));
  tempDirs.push(root);
  const store = new SqliteEventStore(join(root, "events.db"));
  const app = await createControlPlane({
    doctrine,
    eventStore: store,
    deviceSessionKey: DEVICE_KEY,
    clock: () => NOW,
    authorizeWorkerSteer: authorizeWorkerSteer ?? createDeterministicWorkerSteerAuthorizer(),
    authenticateCaptain: (request) =>
      Promise.resolve(
        request.headers.get("authorization") === "Bearer captain-secret"
          ? { captainId: "captain-test", steerSourceLane: "api" }
          : undefined,
      ),
    authenticateOperator: (request) =>
      Promise.resolve(
        request.headers.get("authorization") === "Bearer operator-secret"
          ? { operatorId: "operator-test", steerSourceLane: "tui" }
          : undefined,
      ),
    authenticateRunner: (request) =>
      Promise.resolve(
        request.headers.get("authorization") === "Bearer runner-secret"
          ? { runnerId: "runner-test" }
          : undefined,
      ),
  });
  const mission = (await (
    await app.request("/v1/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "Exercise paired-device steering" }),
    })
  ).json()) as { missionId: string };
  const plan = {
    missionId: mission.missionId,
    goal: "Exercise paired-device steering",
    rationale: "Keep one worker active while device authority is exercised.",
    tasks: [
      {
        id: "implement",
        title: "Implement",
        objective: "Hold an active worker lease.",
        kind: "implementation",
        role: "implementer",
        writeScope: ["src/**"],
        successCriteria: ["The worker accepts finite steering."],
        evidenceRequirements: ["Steering command receipt."],
      },
      {
        id: "verify",
        title: "Verify",
        objective: "Verify the worker result.",
        kind: "verification",
        role: "verifier",
        dependsOn: ["implement"],
        successCriteria: ["The result is verified."],
        evidenceRequirements: ["Verification report."],
      },
    ],
    successCriteria: ["Paired-device steering is bounded."],
    profileHash: doctrine.profileHash,
  };
  expect(
    (
      await app.request(`/v1/missions/${mission.missionId}/plan`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(plan),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await app.request(`/v1/missions/${mission.missionId}/start`, {
        method: "POST",
        headers: { authorization: "Bearer captain-secret" },
      })
    ).status,
  ).toBe(202);
  const claimed = (await (
    await app.request("/v1/runner/claims", {
      method: "POST",
      headers: RUNNER_HEADERS,
      body: JSON.stringify({
        claimId: "device-steering-claim",
        workers: [
          {
            id: "codex-implementer",
            displayName: "Codex implementer",
            harness: "codex",
            capabilities: {
              kinds: ["implementation"],
              canWrite: true,
              supportsStructuredEvents: true,
              supportsTerminal: true,
              supportsNativeSession: true,
            },
          },
        ],
      }),
    })
  ).json()) as { assignment: { workerRunId: string } };
  return { app, store, workerRunId: claimed.assignment.workerRunId };
}

function steerRequest(commandId: string, correlationId: string) {
  return {
    schemaVersion: 1 as const,
    commandId,
    sourceLane: "api" as const,
    correlationId,
    intent: { type: "focus" as const, target: "acceptance_criteria" as const },
  };
}

function steer(
  fixture: { app: Hono; workerRunId: string },
  token: string | undefined,
  request: Record<string, unknown>,
) {
  return fixture.app.request(`/v1/workers/${fixture.workerRunId}/steer`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(request),
  });
}

async function pairDevice(app: Hono, grants: DeviceGrantSet) {
  const pending = await redeemDevice(app);
  const completed = await app.request("/v1/pairing/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ completionToken: pending.completionToken, acceptedGrants: grants }),
  });
  expect(completed.status).toBe(200);
  const body = (await completed.json()) as { deviceId: string; deviceToken: string };
  return { deviceId: body.deviceId, token: body.deviceToken };
}

async function redeemDevice(app: Hono) {
  const offer = await app.request("/v1/pairing/offer", {
    method: "POST",
    headers: OPERATOR_HEADERS,
  });
  expect(offer.status).toBe(200);
  const { deepLink } = (await offer.json()) as { deepLink: string };
  const offerSecret = new URL(deepLink).searchParams.get("offer");
  expect(offerSecret).toBeTruthy();
  const redeemed = await app.request("/v1/pairing/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      offerSecret,
      device: { name: "Steering iPhone", platform: "ios" },
    }),
  });
  expect(redeemed.status).toBe(200);
  return (await redeemed.json()) as { deviceId: string; completionToken: string };
}
