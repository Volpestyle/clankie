import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compileDoctrine, loadDoctrineFile } from "@clankie/doctrine";
import {
  SUPERVISE_GRANTS,
  WorkerTranscriptSnapshotSchema,
  WorkerTranscriptTailLineSchema,
  type DeviceGrantSet,
  type WorkerTranscriptKey,
} from "@clankie/protocol";
import type { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { createControlPlane, type TrustedOperatorIdentity } from "../src/app.ts";
import type { WorkerTranscriptReadPort, WorkerTranscriptTailRead } from "../src/worker-transcripts.ts";

const DEVICE_KEY = Uint8Array.from(Buffer.alloc(32, 9));
const OPERATOR = { authorization: "Bearer operator-secret" };
let doctrine: Awaited<ReturnType<typeof loadDoctrine>>;
let fixture: ReturnType<typeof WorkerTranscriptSnapshotSchema.parse>;

async function loadDoctrine() {
  return compileDoctrine([
    await loadDoctrineFile(resolve(import.meta.dirname, "../../../doctrine/profiles/self-build-lab.yaml")),
  ]);
}

beforeAll(async () => {
  doctrine = await loadDoctrine();
  fixture = WorkerTranscriptSnapshotSchema.parse(
    JSON.parse(
      await readFile(
        resolve(
          import.meta.dirname,
          "../../../packages/protocol/test/fixtures/garden-worker-transcript.json",
        ),
        "utf8",
      ),
    ),
  );
});

function operator(request: Request): Promise<TrustedOperatorIdentity | undefined> {
  return Promise.resolve(
    request.headers.get("authorization") === OPERATOR.authorization
      ? { operatorId: "operator-james" }
      : undefined,
  );
}

class FixtureTranscripts implements WorkerTranscriptReadPort {
  public tailOutcome: WorkerTranscriptTailRead | undefined;
  public identityMismatch = false;

  public snapshot(key: WorkerTranscriptKey) {
    if (key.workerRunId === "run-replaced") {
      return Promise.resolve({
        schemaVersion: 1 as const,
        outcome: "run_replaced" as const,
        replacementKey: fixture.key,
        snapshotCursor: fixture.nextCursor,
      });
    }
    return Promise.resolve({
      ...fixture,
      key: this.identityMismatch ? { ...key, missionId: "another-mission" } : key,
      entries: fixture.entries.map((entry) => ({ ...entry, ...key })),
    });
  }

  public openTail(_key: WorkerTranscriptKey, _cursor: string, _signal: AbortSignal) {
    if (this.tailOutcome) return Promise.resolve(this.tailOutcome);
    const entry = { ...fixture.entries[0], ...fixture.key };
    return Promise.resolve({
      outcome: "tail" as const,
      stream: (async function* () {
        yield WorkerTranscriptTailLineSchema.parse({
          schemaVersion: 1,
          type: "worker_transcript.entry",
          entry,
          cursor: fixture.nextCursor,
        });
      })(),
    });
  }
}

async function makeApp(reader?: WorkerTranscriptReadPort, clock?: () => Date): Promise<Hono> {
  return createControlPlane({
    doctrine,
    deviceSessionKey: DEVICE_KEY,
    authenticateOperator: operator,
    ...(reader ? { workerTranscripts: reader } : {}),
    ...(clock ? { clock } : {}),
  });
}

async function pair(app: Hono, acceptedGrants: DeviceGrantSet): Promise<{ token: string; deviceId: string }> {
  const offer = await app.request("/v1/pairing/offer", { method: "POST", headers: OPERATOR });
  const wire = (await offer.json()) as { deepLink: string };
  const offerSecret = new URL(wire.deepLink).searchParams.get("offer");
  const redeemed = await app.request("/v1/pairing/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ offerSecret, device: { name: "Garden fixture", platform: "ios" } }),
  });
  const redemption = (await redeemed.json()) as { completionToken: string; deviceId: string };
  const completed = await app.request("/v1/pairing/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ completionToken: redemption.completionToken, acceptedGrants }),
  });
  const result = (await completed.json()) as { deviceToken: string };
  return { token: result.deviceToken, deviceId: redemption.deviceId };
}

function transcriptPath(workerRunId = fixture.key.workerRunId): string {
  return `/v1/workers/${workerRunId}/transcript?missionId=${fixture.key.missionId}&taskId=${fixture.key.taskId}`;
}

function tailPath(): string {
  return `/v1/workers/${fixture.key.workerRunId}/transcript/tail?missionId=${fixture.key.missionId}&taskId=${fixture.key.taskId}&cursor=${encodeURIComponent(fixture.nextCursor)}`;
}

describe("control-plane worker transcript read/tail API", () => {
  it("fails closed for missing auth, missing chat permission, and missing reader", async () => {
    const reader = new FixtureTranscripts();
    const app = await makeApp(reader);
    const unauthenticated = await app.request(transcriptPath());
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toMatchObject({
      outcome: "auth_failed",
      reason: "authentication_required",
    });

    const noChat = await pair(app, { ...SUPERVISE_GRANTS, chat: false });
    const denied = await app.request(transcriptPath(), {
      headers: { authorization: `Bearer ${noChat.token}` },
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ outcome: "auth_failed", reason: "permission_denied" });

    const unavailableApp = await makeApp();
    const device = await pair(unavailableApp, SUPERVISE_GRANTS);
    expect(
      (
        await unavailableApp.request(transcriptPath(), {
          headers: { authorization: `Bearer ${device.token}` },
        })
      ).status,
    ).toBe(503);

    let now = new Date("2026-07-12T18:00:00.000Z");
    const expiringApp = await makeApp(reader, () => now);
    const expiring = await pair(expiringApp, SUPERVISE_GRANTS);
    now = new Date("2026-07-20T18:00:00.000Z");
    const expired = await expiringApp.request(transcriptPath(), {
      headers: { authorization: `Bearer ${expiring.token}` },
    });
    expect(expired.status).toBe(401);
    expect(await expired.json()).toMatchObject({ outcome: "auth_failed", reason: "session_expired" });
  });

  it("returns a garden-filtered snapshot and rejects an upstream mission identity mismatch", async () => {
    const reader = new FixtureTranscripts();
    const app = await makeApp(reader);
    const device = await pair(app, SUPERVISE_GRANTS);
    const response = await app.request(transcriptPath(), {
      headers: { authorization: `Bearer ${device.token}` },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { entries: unknown[] }).entries).toHaveLength(6);

    reader.identityMismatch = true;
    expect(
      (
        await app.request(transcriptPath(), {
          headers: { authorization: `Bearer ${device.token}` },
        })
      ).status,
    ).toBe(502);
  });

  it("returns typed cursor-expired and run-replaced recovery outcomes", async () => {
    const reader = new FixtureTranscripts();
    reader.tailOutcome = {
      schemaVersion: 1,
      outcome: "cursor_expired",
      retainedFromSequence: 4,
      snapshotCursor: fixture.nextCursor,
    };
    const app = await makeApp(reader);
    const device = await pair(app, SUPERVISE_GRANTS);
    const tail = await app.request(tailPath(), {
      headers: { authorization: `Bearer ${device.token}` },
    });
    expect(tail.status).toBe(409);
    expect(await tail.json()).toMatchObject({ outcome: "cursor_expired" });

    const replaced = await app.request(transcriptPath("run-replaced"), {
      headers: { authorization: `Bearer ${device.token}` },
    });
    expect(replaced.status).toBe(409);
    expect(await replaced.json()).toMatchObject({ outcome: "run_replaced" });
  });

  it("streams typed garden entries as NDJSON and revoked devices lose access", async () => {
    const app = await makeApp(new FixtureTranscripts());
    const device = await pair(app, SUPERVISE_GRANTS);
    const response = await app.request(tailPath(), {
      headers: { authorization: `Bearer ${device.token}` },
    });
    expect(response.status).toBe(200);
    expect(WorkerTranscriptTailLineSchema.parse(JSON.parse((await response.text()).trim())).entry.kind).toBe(
      "status",
    );

    await app.request(`/v1/devices/${device.deviceId}/revoke`, { method: "POST", headers: OPERATOR });
    const revoked = await app.request(transcriptPath(), {
      headers: { authorization: `Bearer ${device.token}` },
    });
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toMatchObject({ outcome: "auth_failed", reason: "device_revoked" });
  });
});
