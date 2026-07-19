import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileDoctrine, loadDoctrineFile } from "@clankie/doctrine";
import { SqliteEventStore } from "@clankie/event-store";
import { SUPERVISE_GRANTS, type DeviceGrantSet } from "@clankie/protocol";
import type { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { createControlPlane, type TrustedOperatorIdentity } from "../src/app.ts";

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
});
