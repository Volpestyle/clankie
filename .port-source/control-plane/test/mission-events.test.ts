import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileDoctrine, loadDoctrineFile } from "@clankie/doctrine";
import { SqliteEventStore } from "@clankie/event-store";
import { SUPERVISE_GRANTS, type DeviceGrantSet } from "@clankie/protocol";
import type { StoredAttentionDelivery } from "@clankie/tracker-connector";
import type { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { createControlPlane, type TrustedOperatorIdentity } from "../src/app.ts";
import { EventStoreAttentionDeliveryStore } from "../src/tracker-ceremony.ts";

const DEVICE_KEY = Uint8Array.from(Buffer.alloc(32, 23));
const OPERATOR_HEADERS = { authorization: "Bearer operator-secret" };
const RUNNER_HEADERS = { authorization: "Bearer runner-secret" };
const CAPTAIN_HEADERS = { authorization: "Bearer captain-secret" };
let doctrine: Awaited<ReturnType<typeof loadDoctrine>>;

async function loadDoctrine() {
  return compileDoctrine([
    await loadDoctrineFile(resolve(import.meta.dirname, "../../../doctrine/profiles/self-build-lab.yaml")),
  ]);
}

beforeAll(async () => {
  doctrine = await loadDoctrine();
});

function operator(request: Request): Promise<TrustedOperatorIdentity | undefined> {
  return Promise.resolve(
    request.headers.get("authorization") === OPERATOR_HEADERS.authorization
      ? { operatorId: "operator-james" }
      : undefined,
  );
}

async function pair(app: Hono, grants: DeviceGrantSet): Promise<string> {
  const offer = await app.request("/v1/pairing/offer", { method: "POST", headers: OPERATOR_HEADERS });
  const wire = (await offer.json()) as { deepLink: string };
  const offerSecret = new URL(wire.deepLink).searchParams.get("offer");
  const redeemed = await app.request("/v1/pairing/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ offerSecret, device: { name: "Garden fixture", platform: "ios" } }),
  });
  const redemption = (await redeemed.json()) as { completionToken: string };
  const completed = await app.request("/v1/pairing/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ completionToken: redemption.completionToken, acceptedGrants: grants }),
  });
  return ((await completed.json()) as { deviceToken: string }).deviceToken;
}

async function createStartedMission(app: Hono, goal: string): Promise<string> {
  const created = await app.request("/v1/missions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal }),
  });
  const { missionId } = (await created.json()) as { missionId: string };
  const plan = {
    missionId,
    goal,
    rationale: "Exercise the authenticated semantic feed.",
    tasks: [
      {
        id: "implement",
        title: "Implement",
        objective: "Build the candidate.",
        kind: "implementation",
        role: "implementer",
        writeScope: ["src/**"],
        successCriteria: ["Candidate exists."],
        evidenceRequirements: ["Diff."],
      },
      {
        id: "verify",
        title: "Verify",
        objective: "Verify the candidate.",
        kind: "verification",
        role: "verifier",
        dependsOn: ["implement"],
        successCriteria: ["Checks pass."],
        evidenceRequirements: ["Test report."],
      },
    ],
    successCriteria: ["Candidate is independently verified."],
    profileHash: doctrine.profileHash,
  };
  expect(
    (
      await app.request(`/v1/missions/${missionId}/plan`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(plan),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await app.request(`/v1/missions/${missionId}/start`, {
        method: "POST",
        headers: CAPTAIN_HEADERS,
      })
    ).status,
  ).toBe(202);
  return missionId;
}

function attentionRecord(missionId: string, requestId: string, fingerprint: string): StoredAttentionDelivery {
  const correlationId = `correlation-${requestId}`;
  return {
    result: {
      requestId,
      missionId,
      correlationId,
      aggregate: "delivered",
      actions: [],
      fingerprint,
      deliveredAt: "2026-07-19T20:10:00.000Z",
    },
    pending: {
      workspaceId: "workspace-fixture",
      request: {
        schemaVersion: 1,
        requestId,
        missionId,
        correlationId,
        targetRole: "operator",
        requestKind: "decision_needed",
        actionableAsk: "Confirm the bounded decision.",
        blocking: true,
        authorityImpact: "narrow",
        urgency: "blocking",
        notificationSurfaces: ["operator_inbox"],
        directNotification: "best_effort",
        waitForAuthoritativeResponse: true,
        createdAt: "2026-07-19T20:09:00.000Z",
      },
    },
  };
}

async function reserveAndCompleteAttention(
  store: EventStoreAttentionDeliveryStore,
  missionId: string,
  requestId: string,
  factoryCalls: { count: number },
): Promise<StoredAttentionDelivery> {
  const fingerprint = `fingerprint-${requestId}`;
  return store.runExclusive(
    {
      missionId,
      requestId,
      correlationId: `correlation-${requestId}`,
      fingerprint,
    },
    () => {
      factoryCalls.count += 1;
      return Promise.resolve(attentionRecord(missionId, requestId, fingerprint));
    },
  );
}

describe("control-plane mission event feed", () => {
  it("authenticates discovery/snapshot and reports invalid cursor and mission replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-mission-events-"));
    const store = new SqliteEventStore(join(root, "events.db"));
    try {
      const app = await createControlPlane({
        doctrine,
        eventStore: store,
        deviceSessionKey: DEVICE_KEY,
        authenticateOperator: operator,
        authenticateCaptain: (request) =>
          Promise.resolve(
            request.headers.get("authorization") === CAPTAIN_HEADERS.authorization
              ? { captainId: "captain-test" }
              : undefined,
          ),
        authenticateRunner: (request) =>
          Promise.resolve(
            request.headers.get("authorization") === RUNNER_HEADERS.authorization
              ? { runnerId: "runner-test" }
              : undefined,
          ),
      });
      const unauthenticated = await app.request("/v1/missions/active");
      expect(unauthenticated.status).toBe(401);
      expect(await unauthenticated.json()).toMatchObject({
        outcome: "auth_failed",
        reason: "authentication_required",
      });
      const deniedToken = await pair(app, { ...SUPERVISE_GRANTS, chat: false });
      expect(
        (
          await app.request("/v1/missions/active", {
            headers: { authorization: `Bearer ${deniedToken}` },
          })
        ).status,
      ).toBe(403);
      const deviceToken = await pair(app, SUPERVISE_GRANTS);
      const missionId = await createStartedMission(app, "First live mission");

      const claimed = await app.request("/v1/runner/claims", {
        method: "POST",
        headers: { ...RUNNER_HEADERS, "content-type": "application/json" },
        body: JSON.stringify({
          claimId: "claim-1",
          workers: [
            {
              id: "codex-1",
              displayName: "Codex private display",
              harness: "codex",
              model: "private-provider-model",
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
      });
      const assignment = ((await claimed.json()) as { assignment: { workerRunId: string } }).assignment;
      expect(claimed.status).toBe(200);
      expect(
        (
          await app.request(`/v1/runner/workers/${assignment.workerRunId}/events`, {
            method: "POST",
            headers: { ...RUNNER_HEADERS, "content-type": "application/json" },
            body: JSON.stringify({
              attempt: 1,
              eventId: "progress-private",
              type: "worker.waiting_user",
              data: {
                state: "waiting_user",
                source: "codex.app_server",
                tier: 0,
                confidence: 1,
                observedAt: "2026-07-19T20:00:00.000Z",
                questionSummary: "Bearer secret and private prompt text",
              },
            }),
          })
        ).status,
      ).toBe(200);

      const headers = { authorization: `Bearer ${deviceToken}` };
      const discovery = await app.request("/v1/missions/active", { headers });
      expect(discovery.status).toBe(200);
      expect(await discovery.json()).toMatchObject({ activeMission: { missionId } });
      const snapshotResponse = await app.request(`/v1/missions/${missionId}/events`, { headers });
      expect(snapshotResponse.status).toBe(200);
      const snapshot = (await snapshotResponse.json()) as {
        nextCursor: string;
        events: Array<{ type: string; data: Record<string, unknown> }>;
      };
      expect(snapshot.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "worker.leased",
            data: expect.objectContaining({
              workerId: "codex-1",
              harness: "codex",
              taskKind: "implementation",
            }),
          }),
          expect.objectContaining({
            type: "worker.waiting_user",
            data: { summary: "User input required" },
          }),
        ]),
      );
      expect(JSON.stringify(snapshot)).not.toMatch(
        /Bearer secret|private prompt text|private-provider-model|Codex private display|claimId|runnerId/iu,
      );

      const invalid = await app.request(
        `/v1/missions/${missionId}/events/tail?cursor=${encodeURIComponent("tampered.cursor")}`,
        { headers },
      );
      expect(invalid.status).toBe(409);
      expect(await invalid.json()).toMatchObject({ outcome: "cursor_invalid", missionId });

      const replacementId = await createStartedMission(app, "Replacement live mission");
      const replaced = await app.request(
        `/v1/missions/${missionId}/events/tail?cursor=${encodeURIComponent(snapshot.nextCursor)}`,
        { headers },
      );
      expect(replaced.status).toBe(409);
      expect(await replaced.json()).toMatchObject({
        outcome: "mission_replaced",
        requestedMissionId: missionId,
        replacementMission: { missionId: replacementId },
      });
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reconciles attention writers, concurrent public appends, live tails, restart, and replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-mission-event-reconcile-"));
    const path = join(root, "events.db");
    const store = new SqliteEventStore(path);
    const outOfBandStore = new SqliteEventStore(path);
    try {
      const dependencies = {
        doctrine,
        eventStore: store,
        deviceSessionKey: DEVICE_KEY,
        authenticateOperator: operator,
        authenticateCaptain: (request: Request) =>
          Promise.resolve(
            request.headers.get("authorization") === CAPTAIN_HEADERS.authorization
              ? { captainId: "captain-test" }
              : undefined,
          ),
        authenticateRunner: (request: Request) =>
          Promise.resolve(
            request.headers.get("authorization") === RUNNER_HEADERS.authorization
              ? { runnerId: "runner-test" }
              : undefined,
          ),
      };
      const app = await createControlPlane(dependencies);
      const deviceToken = await pair(app, SUPERVISE_GRANTS);
      const headers = { authorization: `Bearer ${deviceToken}` };
      const missionOne = await createStartedMission(app, "Mission before attention events");
      const initialResponse = await app.request(`/v1/missions/${missionOne}/events`, { headers });
      expect(initialResponse.status).toBe(200);
      const initial = (await initialResponse.json()) as { nextCursor: string };

      const tailAbort = new AbortController();
      const tailResponse = await app.request(
        `/v1/missions/${missionOne}/events/tail?cursor=${encodeURIComponent(initial.nextCursor)}`,
        { headers, signal: tailAbort.signal },
      );
      expect(tailResponse.status).toBe(200);
      const tailReader = tailResponse.body?.getReader();
      if (!tailReader) throw new Error("expected tail response body");
      const waitingTailLine = tailReader.read();

      const attention = new EventStoreAttentionDeliveryStore(outOfBandStore, {
        profileHash: doctrine.profileHash,
        idFactory: () => "attention-owner",
        clock: () => new Date("2026-07-19T20:10:00.000Z"),
      });
      const firstFactoryCalls = { count: 0 };
      await reserveAndCompleteAttention(attention, missionOne, "attention-one", firstFactoryCalls);
      expect(firstFactoryCalls.count).toBe(1);

      const claim = await app.request("/v1/runner/claims", {
        method: "POST",
        headers: { ...RUNNER_HEADERS, "content-type": "application/json" },
        body: JSON.stringify({
          claimId: "claim-after-attention",
          workers: [
            {
              id: "codex-after-attention",
              displayName: "Codex",
              harness: "codex",
              model: "fixture-model",
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
      });
      expect(claim.status).toBe(200);

      const delivered = await waitingTailLine;
      expect(delivered.done).toBe(false);
      const tailLine = JSON.parse(new TextDecoder().decode(delivered.value).trim()) as {
        event: { type: string; sourceSequence: number };
      };
      expect(tailLine.event.type).toBe("worker.leased");
      expect(tailLine.event.sourceSequence).toBeGreaterThan(0);
      tailAbort.abort();
      await tailReader.cancel();

      const afterAttentionSnapshot = await app.request(`/v1/missions/${missionOne}/events`, { headers });
      expect(afterAttentionSnapshot.status).toBe(200);
      expect(await afterAttentionSnapshot.json()).toMatchObject({
        outcome: "snapshot",
        events: expect.arrayContaining([expect.objectContaining({ type: "worker.leased" })]),
      });

      const beforeDuplicate = (await store.readAll()).length;
      await reserveAndCompleteAttention(attention, missionOne, "attention-one", firstFactoryCalls);
      expect(firstFactoryCalls.count).toBe(1);
      expect((await store.readAll()).length).toBe(beforeDuplicate);

      const concurrentFactoryCalls = { count: 0 };
      const [, missionTwo] = await Promise.all([
        reserveAndCompleteAttention(attention, missionOne, "attention-concurrent", concurrentFactoryCalls),
        createStartedMission(app, "Replacement concurrent with attention"),
      ]);
      expect(concurrentFactoryCalls.count).toBe(1);
      const activeAfterConcurrent = await app.request("/v1/missions/active", { headers });
      expect(activeAfterConcurrent.status).toBe(200);
      expect(await activeAfterConcurrent.json()).toMatchObject({ activeMission: { missionId: missionTwo } });

      const verification = await store.verify();
      expect(verification).toEqual({ valid: true, count: expect.any(Number) });
      const beforeRestart = await store.readAll();
      expect(beforeRestart.map((entry) => entry.sequence)).toEqual(
        beforeRestart.map((_entry, index) => index + 1),
      );
      expect(
        beforeRestart.filter((entry) => entry.event.type === "tracker.human-attention.reserve"),
      ).toHaveLength(2);
      expect(
        beforeRestart.filter((entry) => entry.event.type === "tracker.human-attention.store"),
      ).toHaveLength(2);

      const restarted = await createControlPlane(dependencies);
      const activeAfterRestart = await restarted.request("/v1/missions/active", { headers });
      expect(activeAfterRestart.status).toBe(200);
      expect(await activeAfterRestart.json()).toMatchObject({ activeMission: { missionId: missionTwo } });

      const restartFactoryCalls = { count: 0 };
      const [, missionThree] = await Promise.all([
        reserveAndCompleteAttention(attention, missionTwo, "attention-after-restart", restartFactoryCalls),
        createStartedMission(restarted, "Replacement after restart and attention"),
      ]);
      expect(restartFactoryCalls.count).toBe(1);
      const activeFinal = await restarted.request("/v1/missions/active", { headers });
      expect(activeFinal.status).toBe(200);
      expect(await activeFinal.json()).toMatchObject({ activeMission: { missionId: missionThree } });

      const visibleOutOfBandMission = "mission-visible-append-expected";
      await outOfBandStore.appendExpected(
        {
          id: "visible-out-of-band-start",
          occurredAt: "2026-07-19T20:11:00.000Z",
          missionId: visibleOutOfBandMission,
          correlationId: "correlation-visible-out-of-band",
          profileHash: doctrine.profileHash,
          type: "mission.execution.started",
          data: { captainId: "out-of-band-fixture" },
        },
        { streamId: visibleOutOfBandMission, expectedRevision: 0 },
      );
      const activeAfterVisibleOutOfBand = await restarted.request("/v1/missions/active", { headers });
      expect(activeAfterVisibleOutOfBand.status).toBe(200);
      expect(await activeAfterVisibleOutOfBand.json()).toMatchObject({
        activeMission: { missionId: visibleOutOfBandMission, generation: "visible-out-of-band-start" },
      });
      expect(await store.verify()).toMatchObject({ valid: true });
    } finally {
      outOfBandStore.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns explicit unavailable outcomes when authoritative reconciliation becomes unreadable", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-mission-event-unreadable-"));
    const durable = new SqliteEventStore(join(root, "events.db"));
    let unreadable = false;
    const store = {
      append: durable.append.bind(durable),
      readAll: () =>
        unreadable ? Promise.reject(new Error("simulated unreadable authority")) : durable.readAll(),
      verify: durable.verify.bind(durable),
    };
    try {
      const app = await createControlPlane({
        doctrine,
        eventStore: store,
        deviceSessionKey: DEVICE_KEY,
        authenticateOperator: operator,
        authenticateCaptain: () => Promise.resolve({ captainId: "captain-test" }),
        authenticateRunner: () => Promise.resolve({ runnerId: "runner-test" }),
      });
      const deviceToken = await pair(app, SUPERVISE_GRANTS);
      const headers = { authorization: `Bearer ${deviceToken}` };
      const missionId = await createStartedMission(app, "Authority failure fixture");
      const snapshot = (await (
        await app.request(`/v1/missions/${missionId}/events`, { headers })
      ).json()) as { nextCursor: string };

      unreadable = true;
      for (const path of [
        "/v1/missions/active",
        `/v1/missions/${missionId}/events`,
        `/v1/missions/${missionId}/events/tail?cursor=${encodeURIComponent(snapshot.nextCursor)}`,
      ]) {
        const response = await app.request(path, { headers });
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: "mission_event_feed_reconciliation_failed" });
      }
    } finally {
      durable.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
