import { resolve } from "node:path";
import { compileDoctrine, loadDoctrineFile } from "@sapling/doctrine";
import { beforeAll, describe, expect, it } from "vitest";
import { createControlPlane } from "../src/app.ts";

let app: ReturnType<typeof createControlPlane>;
let profileHash: string;

beforeAll(async () => {
  const profilePath = resolve(import.meta.dirname, "../../../doctrine/profiles/self-build-lab.yaml");
  const doctrine = compileDoctrine([await loadDoctrineFile(profilePath)]);
  profileHash = doctrine.profileHash;
  app = createControlPlane({ doctrine });
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
});
