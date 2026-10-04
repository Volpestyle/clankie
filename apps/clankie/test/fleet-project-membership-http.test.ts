import { TAKE_CONTROL_GRANTS, type DeviceGrantSet } from "@clankie/protocol";
import { DeviceSessionSigner, mintDeviceSessionClaims } from "../src/device-session.ts";
import { FleetProjectMembership } from "../src/fleet-project-membership.ts";
import { ProjectHires } from "../src/captain/project-hires.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { expect, it, vi } from "vitest";
import { ClankieSettingsSchema } from "@clankie/settings";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { FLEET_PROJECT_MEMBERSHIP_PATH } from "@clankie/protocol/projects";

it("mounts the optional owner-only read in the production app without altering legacy fleet dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "membership-http-"));
  const input = { schemaVersion: 1 as const, seats: [{ seatId: "seat", occupantId: "occupant" }] };
  const result = {
    schemaVersion: 1 as const,
    projectsRevision: "a".repeat(64),
    observedAt: new Date().toISOString(),
    seats: [
      {
        ...input.seats[0]!,
        membership: { outcome: "unknown" as const, reason: "no_confirmed_hire" as const },
      },
    ],
  };
  const read = vi.fn(async () => result);
  const service = await createClankieApp({
    captain: createStubCaptain(),
    settings: { load: async () => ClankieSettingsSchema.parse({ schemaVersion: 1 }) },
    eventLogPath: join(root, "events.jsonl"),
    deviceSessionKey: randomBytes(32),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer fixture-owner"
        ? { operatorId: "fixture-owner" }
        : undefined,
    authenticateCaptain: async () => ({ captainId: "model-only" }),
    fleetProjectMembership: { read },
  });
  try {
    const call = (token?: string) =>
      service.app.request(FLEET_PROJECT_MEMBERSHIP_PATH, {
        method: "POST",
        body: JSON.stringify(input),
        ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      });
    expect((await call()).status).toBe(401);
    expect(read).not.toHaveBeenCalled();
    const response = await call("fixture-owner");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

/** Real app pairing/current device projection and signer; all state stays in this temp directory. */
async function deviceFixture() {
  const root = await mkdtemp(join(tmpdir(), "membership-device-"));
  const key = randomBytes(32);
  const now = new Date("2026-10-04T12:00:00.000Z");
  const settings = ClankieSettingsSchema.parse({
    schemaVersion: 1,
    projects: { projects: [{ id: "repo", name: "Repository" }] },
  });
  const session = { source: "herdr:codex", kind: "id" as const, value: "fixture-native-session" };
  const agent = {
    paneId: "w1:p1",
    terminalId: "seat",
    agent: "codex",
    status: "idle",
    title: "Fixture",
    session,
  };
  const proof = {
    fleet: "default",
    pane: agent.paneId,
    nativeOccupantId: occupantIdForHerdrSession(session),
    binding: { socketPath: "/fixture/host.sock", session: "original" },
    shell: { pid: 21, startTime: "Sun Oct  4 10:00:00 2026" },
    processes: [{ pid: 22, startTime: "Sun Oct  4 10:00:01 2026" }],
  };
  const hires = new ProjectHires(join(root, "hires.json"));
  const allocation = hires.reserve(settings.projects, "repo", {
    schemaVersion: 1,
    harness: "codex",
    title: "Fixture",
    workingDirectory: root,
  });
  hires.launch(allocation.id, settings.projects);
  hires.pane(allocation.id, agent.paneId);
  hires.observe(allocation.id, agent.terminalId, proof.nativeOccupantId, proof);
  hires.confirmed(allocation.id);
  const input = {
    schemaVersion: 1 as const,
    seats: [{ seatId: agent.terminalId, occupantId: proof.nativeOccupantId }],
  };
  const roster = vi.fn(async () => [agent]);
  const observe = vi.fn(async () => proof);
  const projection = new FleetProjectMembership({
    settings: async () => settings.projects,
    binding: async () => ({ runtime: "external", ...proof.binding }),
    roster,
    observe,
    hires: {
      projectHireMembershipCandidate: (fleet, pane) => hires.membershipCandidate(fleet, pane),
      confirmedProjectHireAssignment: (fleet, pane, revision, current) =>
        hires.confirmedAssignment(fleet, pane, revision, current),
    },
  });
  const service = await createClankieApp({
    captain: createStubCaptain(),
    settings: { load: async () => settings },
    eventLogPath: join(root, "events.jsonl"),
    deviceSessionKey: key,
    clock: () => now,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer fixture-owner"
        ? { operatorId: "fixture-owner" }
        : undefined,
    authenticateCaptain: async (request) =>
      request.headers.get("authorization") === "Bearer fixture-captain"
        ? { captainId: "model-only" }
        : undefined,
    fleetProjectMembership: projection,
  });
  const post = async (path: string, body: unknown, token?: string) =>
    service.app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  return {
    roster,
    observe,
    signer: new DeviceSessionSigner(key),
    epoch: Math.floor(now.getTime() / 1000),
    read: (token: string) => post(FLEET_PROJECT_MEMBERSHIP_PATH, input, token),
    revoke: (id: string) => post(`/v1/devices/${id}/revoke`, {}, "fixture-owner"),
    async pair(grants: DeviceGrantSet) {
      const offer = await post("/v1/pairing/offer", {}, "fixture-owner");
      expect(offer.status).toBe(200);
      const deepLink = ((await offer.json()) as { deepLink: string }).deepLink;
      const redeemed = await post("/v1/pairing/redeem", {
        offerSecret: new URL(deepLink).searchParams.get("offer"),
        device: { name: "Membership fixture", platform: "ios" },
      });
      expect(redeemed.status).toBe(200);
      const pending = (await redeemed.json()) as { deviceId: string; completionToken: string };
      const completed = await post("/v1/pairing/complete", {
        completionToken: pending.completionToken,
        acceptedGrants: grants,
      });
      expect(completed.status).toBe(200);
      return {
        deviceId: pending.deviceId,
        token: ((await completed.json()) as { deviceToken: string }).deviceToken,
      };
    },
    async close() {
      service.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it("accepts a real current Take Control device token and proves membership through the production app", async () => {
  const f = await deviceFixture();
  try {
    const device = await f.pair(TAKE_CONTROL_GRANTS);
    expect(f.signer.verify(device.token, f.epoch).deviceId).toBe(device.deviceId);
    const response = await f.read(device.token);
    expect(response.status).toBe(200);
    expect((await response.json()).seats[0].membership).toEqual({
      outcome: "member",
      source: "hire",
      projectId: "repo",
    });
    expect(f.observe).toHaveBeenCalledTimes(2);
  } finally {
    await f.close();
  }
});

it.each(["chat-only", "captain", "other-signer", "revoked", "unknown-device"] as const)(
  "refuses %s device authority before native reads",
  async (kind) => {
    const f = await deviceFixture();
    try {
      const device = await f.pair(
        kind === "chat-only"
          ? { chat: true, steer: false, terminalObserve: false, terminalControl: false }
          : TAKE_CONTROL_GRANTS,
      );
      let token = device.token;
      if (kind === "captain") token = "fixture-captain";
      if (kind === "other-signer")
        token = new DeviceSessionSigner(randomBytes(32)).issue(f.signer.verify(device.token, f.epoch));
      if (kind === "unknown-device")
        token = f.signer.issue(
          mintDeviceSessionClaims({ deviceId: "unregistered", nowEpochSeconds: f.epoch }),
        );
      if (kind === "revoked") expect((await f.revoke(device.deviceId)).status).toBe(200);
      const response = await f.read(token);
      expect(response.status).toBe(kind === "chat-only" ? 403 : 401);
      expect(f.observe).not.toHaveBeenCalled();
      expect(f.roster).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

it.each([2, 3])(
  "current device revocation at native roster wait %i prevents final publication",
  async (rosterWait) => {
    const f = await deviceFixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let awaitingAuthorization = false;
    const original = f.roster.getMockImplementation()!;
    let calls = 0;
    f.roster.mockImplementation(async () => {
      const rows = await original();
      if (++calls === rosterWait) {
        awaitingAuthorization = true;
        await held;
      }
      return rows;
    });
    let read: Promise<Response> | undefined;
    try {
      const device = await f.pair(TAKE_CONTROL_GRANTS);
      read = f.read(device.token);
      await vi.waitFor(() => expect(awaitingAuthorization).toBe(true));
      expect(f.observe).toHaveBeenCalledTimes(rosterWait - 1);
      expect((await f.revoke(device.deviceId)).status).toBe(200);
      release();
      const response = await read;
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "membership_authentication_required" });
      expect(f.observe).toHaveBeenCalledTimes(rosterWait - 1); // No further proof or membership after revocation.
    } finally {
      release();
      await read;
      await f.close();
    }
  },
);
