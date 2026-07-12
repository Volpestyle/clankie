import { resolve } from "node:path";
import { compileDoctrine, loadDoctrineFile } from "@clankie/doctrine";
import type { MissionPlan } from "@clankie/protocol";
import {
  TrackerMirror,
  type TrackerClient,
  type TrackerCommentInput,
  type TrackerIssue,
  type TrackerIssueMutation,
  type TrackerPolicyDecision,
  type TrackerPolicyGateway,
  type TrackerWriteRequest,
} from "@clankie/tracker-connector";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../src/app.ts";

class RecordedTrackerClient implements TrackerClient {
  public readonly connector = "linear";
  public issue: TrackerIssue = {
    ref: { connector: "linear", workspaceId: "workspace-1", issueId: "issue-1" },
    identifier: "VUH-764",
    url: "https://linear.app/example/issue/VUH-764",
    revision: "revision-1",
    intent: { title: "Tracker-owned goal", description: "Tracker-owned description" },
    priority: { value: 2, label: "High" },
    acceptanceCriteria: ["Implementation and verification pass"],
    state: { id: "started", name: "In Progress", type: "started" },
  };
  public readonly comments: TrackerCommentInput[] = [];
  public readonly assignments: Array<Record<string, unknown>> = [];
  public readonly mutations: Array<Record<string, unknown>> = [];

  public getAppIdentity() {
    return Promise.resolve({ kind: "app" as const, id: "clankie-app", displayName: "Clankie" });
  }

  public getIssue() {
    return Promise.resolve(structuredClone(this.issue));
  }

  public postComment(input: TrackerCommentInput) {
    this.comments.push(structuredClone(input));
    return Promise.resolve({ commentId: `comment-${String(this.comments.length)}` });
  }

  public mirrorAssignment(input: {
    ref: TrackerIssue["ref"];
    appIdentityId: string;
    idempotencyKey: string;
  }) {
    this.assignments.push(structuredClone(input));
    return Promise.resolve();
  }

  public mutateIssue(input: {
    ref: TrackerIssue["ref"];
    mutation: TrackerIssueMutation;
    idempotencyKey: string;
  }) {
    this.mutations.push(structuredClone(input));
    return Promise.resolve();
  }
}

class MutablePolicy implements TrackerPolicyGateway {
  public decision: TrackerPolicyDecision = { effect: "allow", reason: "test allow" };
  public readonly requests: TrackerWriteRequest[] = [];

  public authorize(request: TrackerWriteRequest) {
    this.requests.push(structuredClone(request));
    return Promise.resolve(structuredClone(this.decision));
  }
}

describe("control-plane tracker mirror", () => {
  it("imports authority, refuses plan clobbering, mirrors leases, and reports drift", async () => {
    const doctrine = await trackerDoctrine();
    const client = new RecordedTrackerClient();
    const policy = new MutablePolicy();
    const mirror = new TrackerMirror(client, policy, () => new Date("2026-07-11T20:00:00.000Z"));
    const app = await createControlPlane({
      doctrine,
      trackerMirror: mirror,
      authenticateCaptain: (request) =>
        Promise.resolve(request.headers.has("authorization") ? { captainId: "captain" } : undefined),
      authenticateRunner: () => Promise.resolve({ runnerId: "runner" }),
      clock: () => new Date("2026-07-11T20:00:00.000Z"),
    });

    const unauthorized = await app.request("/v1/tracker/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: client.issue.ref }),
    });
    expect(unauthorized.status).toBe(401);

    const imported = await app.request("/v1/tracker/missions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "trusted" },
      body: JSON.stringify({ ref: client.issue.ref }),
    });
    expect(imported.status).toBe(201);
    const { missionId } = (await imported.json()) as { missionId: string };

    const conflict = await app.request(`/v1/missions/${missionId}/plan`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: "trusted" },
      body: JSON.stringify({ ...plan(missionId, doctrine.profileHash), goal: "GitHub-owned goal" }),
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({
      error: "tracker_authority_conflict",
      changedFields: ["product_intent"],
    });

    const planned = await app.request(`/v1/missions/${missionId}/plan`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: "trusted" },
      body: JSON.stringify(plan(missionId, doctrine.profileHash)),
    });
    expect(planned.status).toBe(200);
    const started = await app.request(`/v1/missions/${missionId}/start`, {
      method: "POST",
      headers: { authorization: "trusted" },
    });
    expect(started.status).toBe(202);

    expect(client.comments.some((comment) => comment.body.includes("mission.execution.started"))).toBe(true);

    client.issue = {
      ...client.issue,
      revision: "revision-2",
      priority: { value: 1, label: "Urgent" },
    };
    const reconciled = await app.request(`/v1/tracker/missions/${missionId}/reconcile`, {
      method: "POST",
      headers: { authorization: "trusted" },
    });
    expect(reconciled.status).toBe(202);
    await expect(reconciled.json()).resolves.toMatchObject({
      drift: { changedFields: ["priority"], baselineRevision: "revision-1" },
      event: { type: "tracker.drift.detected" },
    });
    expect(client.comments.some((comment) => comment.body.includes("contract was not overwritten"))).toBe(
      true,
    );
    policy.decision = { effect: "require_approval", reason: "owner required" };
    const denied = await app.request(`/v1/tracker/missions/${missionId}/mutate`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "trusted" },
      body: JSON.stringify({
        idempotencyKey: "complete-1",
        mutation: { completionState: { id: "done", name: "Done", type: "completed" } },
      }),
    });
    expect(denied.status).toBe(403);
    expect(client.mutations).toEqual([]);

    policy.decision = { effect: "allow", reason: "owner approved" };
    const allowed = await app.request(`/v1/tracker/missions/${missionId}/mutate`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "trusted" },
      body: JSON.stringify({
        idempotencyKey: "priority-1",
        mutation: { priority: { value: 3, label: "Medium" } },
      }),
    });
    expect(allowed.status).toBe(200);
    expect(client.mutations).toHaveLength(1);
  });
});

function plan(missionId: string, profileHash: string): MissionPlan {
  return {
    missionId,
    goal: "Tracker-owned goal",
    rationale: "Honor tracker authority.",
    tasks: [
      {
        id: "implementation",
        title: "Implement",
        objective: "Implement the change",
        kind: "implementation",
        role: "implementer",
        dependsOn: [],
        executionClass: "runner_visible",
        risk: "medium",
        writeScope: ["packages/example/**"],
        successCriteria: ["Implementation passes"],
        evidenceRequirements: ["diff"],
        maxAttempts: 1,
        metadata: {},
      },
      {
        id: "verification",
        title: "Verify",
        objective: "Verify the change",
        kind: "verification",
        role: "verifier",
        dependsOn: ["implementation"],
        executionClass: "runner_visible",
        risk: "medium",
        writeScope: [],
        successCriteria: ["Tests pass"],
        evidenceRequirements: ["test report"],
        maxAttempts: 1,
        metadata: {},
      },
    ],
    successCriteria: ["Implementation and verification pass"],
    assumptions: [],
    risks: [],
    humanDecisionsRequired: [],
    plannedActions: [],
    environmentBindings: [],
    profileHash,
  };
}

async function trackerDoctrine() {
  const base = await loadDoctrineFile(
    resolve(import.meta.dirname, "../../../doctrine/profiles/self-build-lab.yaml"),
  );
  return compileDoctrine([
    {
      ...base,
      id: "tracker-control-plane-test",
      authority: {
        ...base.authority,
        product_intent: { kind: "connector", connector: "linear" },
        acceptance_criteria: { kind: "connector", connector: "linear" },
      },
    },
  ]);
}
