import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileDoctrine, loadDoctrineFile, type CompiledDoctrine } from "@sapling/doctrine";
import { SqliteEventStore } from "@sapling/event-store";
import { beforeAll, describe, expect, it } from "vitest";
import { createControlPlane } from "../src/app.ts";

let app: Awaited<ReturnType<typeof createControlPlane>>;
let doctrine: CompiledDoctrine;
let profileHash: string;

beforeAll(async () => {
  const profilePath = resolve(import.meta.dirname, "../../../doctrine/profiles/self-build-lab.yaml");
  doctrine = compileDoctrine([await loadDoctrineFile(profilePath)]);
  profileHash = doctrine.profileHash;
  app = await createControlPlane({ doctrine });
});

describe("control plane", () => {
  it("reports the compiled doctrine and persists a mission draft", async () => {
    const health = await app.request("/health");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      ok: true,
      doctrine: "self-build-lab",
      profileHash,
    });

    const created = await app.request("/v1/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "Prove the lead-agent loop", context: { source: "test" } }),
    });
    expect(created.status).toBe(201);
    const { missionId } = (await created.json()) as { missionId: string };

    const fetched = await app.request(`/v1/missions/${missionId}`);
    expect(fetched.status).toBe(200);
    await expect(fetched.json()).resolves.toMatchObject({
      id: missionId,
      goal: "Prove the lead-agent loop",
      state: "draft",
    });
  });

  it("denies stale doctrine requests and gates merges under the active doctrine", async () => {
    const baseRequest = {
      id: "action-1",
      principal: { kind: "captain", id: "captain-main" },
      action: "github.pr.merge",
      resource: { type: "pull_request", id: "184", repository: "acme/example" },
      context: {
        missionId: "mission-test",
        risk: "low",
        checksPassed: true,
        humanApprovals: 1,
        profileHash,
      },
    } as const;

    const active = await app.request("/v1/actions/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(baseRequest),
    });
    expect(active.status).toBe(200);
    await expect(active.json()).resolves.toMatchObject({ effect: "require_approval" });

    const stale = await app.request("/v1/actions/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...baseRequest,
        id: "action-2",
        context: { ...baseRequest.context, profileHash: "stale-profile" },
      }),
    });
    expect(stale.status).toBe(200);
    await expect(stale.json()).resolves.toMatchObject({
      effect: "deny",
      matchedPolicyIds: ["stale-doctrine"],
    });
  });

  it("rebuilds mission records from the SQLite event store after a restart", async () => {
    const storePath = join(await mkdtemp(join(tmpdir(), "sapling-control-plane-")), "events.db");
    const store = new SqliteEventStore(storePath);
    const durable = await createControlPlane({ doctrine, eventStore: store });

    const created = await durable.request("/v1/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "Survive a restart", context: { source: "test" } }),
    });
    expect(created.status).toBe(201);
    const { missionId } = (await created.json()) as { missionId: string };

    const plan = {
      missionId,
      goal: "Survive a restart",
      rationale: "Restart-recovery coverage for the durable event store.",
      tasks: [
        {
          id: "t-1",
          title: "Prove durability",
          objective: "Confirm the mission record survives a control-plane restart.",
          kind: "verification",
          successCriteria: ["The mission and its plan are rebuilt from the event log."],
        },
      ],
      successCriteria: ["Mission state is identical after restart."],
      profileHash,
    };
    const planned = await durable.request(`/v1/missions/${missionId}/plan`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(plan),
    });
    expect(planned.status).toBe(200);
    store.close();

    const reopenedStore = new SqliteEventStore(storePath);
    const restarted = await createControlPlane({ doctrine, eventStore: reopenedStore });
    const fetched = await restarted.request(`/v1/missions/${missionId}`);
    expect(fetched.status).toBe(200);
    const record = (await fetched.json()) as Record<string, unknown>;
    expect(record).toMatchObject({ id: missionId, goal: "Survive a restart", state: "planned" });
    expect((record.plan as { tasks: unknown[] }).tasks).toHaveLength(1);
    expect(await reopenedStore.verify()).toMatchObject({ valid: true, count: 2 });
    reopenedStore.close();
  });
});
