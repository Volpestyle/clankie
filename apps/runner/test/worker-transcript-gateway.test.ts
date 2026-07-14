import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerTranscriptProjection } from "../src/worker-transcript.ts";
import {
  createWorkerTranscriptGateway,
  type WorkerTranscriptGateway,
} from "../src/worker-transcript-gateway.ts";

const roots: string[] = [];
const gateways: WorkerTranscriptGateway[] = [];
const key = { missionId: "mission-gateway", taskId: "task-gateway", workerRunId: "run-gateway" };

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runner worker transcript gateway", () => {
  it("requires bearer authority for snapshots and streams replay as NDJSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-transcript-gateway-"));
    roots.push(root);
    const projection = await WorkerTranscriptProjection.open(root);
    await projection.append({
      key,
      occurredAt: "2026-07-12T18:00:00.000Z",
      correlationId: "corr-gateway",
      profileHash: "profile-gateway",
      sourceEventId: "event-gateway-1",
      source: "runner_event",
      trust: "runner_observed",
      kind: "status",
      data: { state: "working" },
    });
    const gateway = await createWorkerTranscriptGateway({ projection, token: "runner-secret", port: 0 });
    gateways.push(gateway);
    const base = `http://${gateway.address.host}:${gateway.address.port}`;
    const path = "/v1/missions/mission-gateway/tasks/task-gateway/workers/run-gateway/transcript";

    expect((await fetch(`${base}${path}`)).status).toBe(401);
    const snapshotResponse = await fetch(`${base}${path}`, {
      headers: { authorization: "Bearer runner-secret" },
    });
    expect(snapshotResponse.status).toBe(200);
    const snapshot = (await snapshotResponse.json()) as { nextCursor: string };

    const abort = new AbortController();
    const tailResponse = await fetch(
      `${base}${path}/tail?cursor=${encodeURIComponent(snapshot.nextCursor)}`,
      {
        headers: { authorization: "Bearer runner-secret" },
        signal: abort.signal,
      },
    );
    expect(tailResponse.status).toBe(200);
    const reader = tailResponse.body?.getReader();
    if (!reader) throw new Error("tail body required");
    const next = reader.read();
    await projection.append({
      key,
      occurredAt: "2026-07-12T18:00:01.000Z",
      correlationId: "corr-gateway",
      profileHash: "profile-gateway",
      sourceEventId: "event-gateway-2",
      source: "runner_event",
      trust: "runner_observed",
      kind: "status",
      data: { state: "idle" },
    });
    const frame = await next;
    expect(new TextDecoder().decode(frame.value)).toContain('"sequence":2');
    abort.abort();
  });
});
