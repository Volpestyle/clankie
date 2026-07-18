import type { DomainEvent, MissionPlan } from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import {
  LinearTrackerClient,
  TRACKER_AUTHORITY_ROLES,
  TrackerAuthorityConflictError,
  TrackerMirror,
  TrackerPolicyError,
  extractAcceptanceCriteria,
  type LinearClient,
  type TrackerAppIdentity,
  type TrackerClient,
  type TrackerCommentInput,
  type TrackerIssue,
  type TrackerIssueMutation,
  type TrackerIssueRef,
  type TrackerPolicyDecision,
  type TrackerPolicyGateway,
  type TrackerWriteRequest,
} from "../src/index.ts";

const ref: TrackerIssueRef = { connector: "linear", workspaceId: "workspace-1", issueId: "issue-1" };
const description = `Context that belongs to the tracker.

**Acceptance criteria:**

- [ ] Preserve tracker intent
- [x] Report drift

**Out of scope:**

- Repository implementation status
`;

class RecordedLinearClient implements LinearClient {
  public identity: TrackerAppIdentity = { kind: "app", id: "clankie-app", displayName: "Clankie" };
  public issue = {
    id: ref.issueId,
    identifier: "VUH-764",
    url: "https://linear.app/example/issue/VUH-764",
    updatedAt: "2026-07-11T20:00:00.000Z",
    title: "Build the tracker mirror",
    description,
    priority: 2,
    priorityLabel: "High",
    state: { id: "started", name: "In Progress", type: "started" },
  };
  public readonly comments: TrackerCommentInput[] = [];
  public readonly assignments: Array<Record<string, unknown>> = [];
  public readonly mutations: Array<Record<string, unknown>> = [];
  private readonly organizationCredential = "credential-marker-never-observable";

  public getAppIdentity(): Promise<TrackerAppIdentity> {
    return Promise.resolve(structuredClone(this.identity));
  }

  public getIssue(): Promise<typeof this.issue> {
    return Promise.resolve(structuredClone(this.issue));
  }

  public createComment(input: TrackerCommentInput): Promise<{ commentId: string }> {
    if (!this.comments.some((comment) => comment.idempotencyKey === input.idempotencyKey)) {
      this.comments.push(structuredClone(input));
    }
    return Promise.resolve({ commentId: `comment-${String(this.comments.length)}` });
  }

  public setDelegate(input: {
    issueId: string;
    appIdentityId: string;
    idempotencyKey: string;
  }): Promise<void> {
    if (!this.assignments.some((assignment) => assignment.idempotencyKey === input.idempotencyKey)) {
      this.assignments.push(structuredClone(input));
    }
    return Promise.resolve();
  }

  public updateIssue(input: {
    issueId: string;
    mutation: TrackerIssueMutation;
    idempotencyKey: string;
  }): Promise<void> {
    this.mutations.push(structuredClone(input));
    return Promise.resolve();
  }
}

class RecordedPolicy implements TrackerPolicyGateway {
  public readonly requests: TrackerWriteRequest[] = [];
  public decision: TrackerPolicyDecision = { effect: "allow", reason: "recorded allow" };

  public authorize(request: TrackerWriteRequest): Promise<TrackerPolicyDecision> {
    this.requests.push(structuredClone(request));
    return Promise.resolve(structuredClone(this.decision));
  }
}

function plan(successCriteria = ["Preserve tracker intent", "Report drift"]): MissionPlan {
  return {
    missionId: "mission-1",
    goal: "Build the tracker mirror",
    rationale: "Use the tracker authority contract.",
    tasks: [
      {
        id: "task-1",
        title: "Implement",
        objective: "Implement the mirror",
        kind: "implementation",
        role: "implementer",
        dependsOn: [],
        executionClass: "runner_visible",
        risk: "medium",
        writeScope: ["packages/tracker-connector/**"],
        successCriteria: ["Contract tests pass"],
        evidenceRequirements: ["test report"],
        maxAttempts: 1,
        metadata: {},
      },
    ],
    successCriteria,
    assumptions: [],
    risks: [],
    humanDecisionsRequired: [],
    plannedActions: [],
    environmentBindings: [],
    profileHash: "profile-hash",
  };
}

function event(type: string, data: Record<string, unknown> = {}): DomainEvent {
  return {
    id: `event-${type}`,
    occurredAt: "2026-07-11T20:01:00.000Z",
    missionId: "mission-1",
    taskId: "task-1",
    workerRunId: "worker-run-1",
    correlationId: "correlation-1",
    profileHash: "profile-hash",
    type,
    data,
  };
}

describe("tracker authority mirror", () => {
  it("imports Linear authority into an immutable contract and rejects plan clobbering", async () => {
    expect(extractAcceptanceCriteria(description)).toEqual(["Preserve tracker intent", "Report drift"]);
    const linear = new RecordedLinearClient();
    const mirror = new TrackerMirror(
      new LinearTrackerClient(linear),
      new RecordedPolicy(),
      () => new Date("2026-07-11T20:00:30.000Z"),
    );

    const contract = await mirror.importMission("mission-1", ref);
    expect(contract).toMatchObject({
      schemaVersion: 1,
      missionId: "mission-1",
      appIdentity: { kind: "app", id: "clankie-app" },
      source: {
        intent: { title: "Build the tracker mirror" },
        priority: { value: 2, label: "High" },
        acceptanceCriteria: ["Preserve tracker intent", "Report drift"],
      },
    });
    expect(() => mirror.validatePlan(plan())).not.toThrow();
    expect(() => mirror.validatePlan({ ...plan(), goal: "Repository says something else" })).toThrowError(
      TrackerAuthorityConflictError,
    );
    expect(() => mirror.validatePlan(plan(["Weakened criterion"]))).toThrow(/acceptance_criteria/u);
  });

  it("imports tracker-authoritative priority and reports priority-only drift", async () => {
    expect(TRACKER_AUTHORITY_ROLES).toContain("priority");
    const linear = new RecordedLinearClient();
    const mirror = new TrackerMirror(new LinearTrackerClient(linear), new RecordedPolicy());

    const contract = await mirror.importMission("mission-1", ref);
    expect(contract.source.priority).toEqual({ value: 2, label: "High" });

    linear.issue.priority = 1;
    linear.issue.priorityLabel = "Urgent";
    linear.issue.updatedAt = "2026-07-11T21:00:00.000Z";

    expect(await mirror.reconcile("mission-1")).toMatchObject({
      changedFields: ["priority"],
      baseline: { priority: { value: 2, label: "High" } },
      upstream: { priority: { value: 1, label: "Urgent" } },
    });
  });

  it("reports mid-mission authoritative drift without replacing the baseline", async () => {
    const linear = new RecordedLinearClient();
    const mirror = new TrackerMirror(new LinearTrackerClient(linear), new RecordedPolicy());
    await mirror.importMission("mission-1", ref);
    linear.issue.title = "Edited upstream intent";
    linear.issue.priority = 1;
    linear.issue.priorityLabel = "Urgent";
    linear.issue.description = description.replace("Report drift", "Report drift loudly");
    linear.issue.updatedAt = "2026-07-11T21:00:00.000Z";

    const first = await mirror.reconcile("mission-1");
    expect(first).toMatchObject({
      baselineRevision: "2026-07-11T20:00:00.000Z",
      upstreamRevision: "2026-07-11T21:00:00.000Z",
      changedFields: ["intent", "priority", "acceptanceCriteria"],
      baseline: { intent: { title: "Build the tracker mirror" } },
      upstream: { intent: { title: "Edited upstream intent" } },
    });
    expect(await mirror.reconcile("mission-1")).toEqual(first);
    expect(() => mirror.validatePlan(plan())).not.toThrow();
  });

  it("mirrors engine events idempotently under one app identity with worker attribution", async () => {
    const linear = new RecordedLinearClient();
    const policy = new RecordedPolicy();
    const mirror = new TrackerMirror(new LinearTrackerClient(linear), policy);
    await mirror.importMission("mission-1", ref);

    const leased = event("worker.leased", { workerId: "codex-worker" });
    await mirror.publish(leased, { role: "implementer", nativeSessionIds: ["native-session-1"] });
    await mirror.publish(leased, { role: "implementer", nativeSessionIds: ["native-session-1"] });
    await mirror.publish(
      event("worker.settled", {
        result: {
          summary: "Implementation passed.",
          evidence: [{ label: "Tests", summary: "All focused checks passed." }],
        },
      }),
      { role: "implementer", nativeSessionIds: ["native-session-1"] },
    );

    expect(linear.assignments).toEqual([
      {
        issueId: "issue-1",
        appIdentityId: "clankie-app",
        idempotencyKey: "clankie:event-worker.leased:assignment",
      },
    ]);
    expect(linear.comments).toHaveLength(1);
    expect(linear.comments[0]?.body).toContain("workerRunId: `worker-run-1`");
    expect(linear.comments[0]?.body).toContain("role: `implementer`");
    expect(linear.comments[0]?.body).toContain("native-session-1");
    expect(linear.comments[0]?.body).toContain("Tests: All focused checks passed.");
    expect(policy.requests.map((request) => request.action)).toEqual([
      "tracker.assignment.mirror",
      "tracker.assignment.mirror",
      "tracker.comment.create",
    ]);
    expect(JSON.stringify({ comments: linear.comments, assignments: linear.assignments })).not.toMatch(
      /credential-marker-never-observable|authorization|access.?token/iu,
    );
  });

  it("fails every mutation closed unless trusted policy returns allow", async () => {
    const linear = new RecordedLinearClient();
    const policy = new RecordedPolicy();
    const mirror = new TrackerMirror(new LinearTrackerClient(linear), policy);
    await mirror.importMission("mission-1", ref);
    policy.decision = { effect: "require_approval", reason: "owner approval required" };

    await expect(
      mirror.mutate(
        "mission-1",
        { completionState: { id: "done", name: "Done", type: "completed" } },
        "mutation-1",
      ),
    ).rejects.toBeInstanceOf(TrackerPolicyError);
    await expect(
      mirror.publish(event("task.failed", { summary: "Blocked" }), { role: "implementer" }),
    ).rejects.toBeInstanceOf(TrackerPolicyError);
    expect(linear.mutations).toEqual([]);
    expect(linear.comments).toEqual([]);

    policy.decision = { effect: "allow", reason: "trusted allow" };
    await mirror.mutate(
      "mission-1",
      {
        priority: { value: 1, label: "Urgent" },
        completionState: { id: "done", name: "Done", type: "completed" },
      },
      "mutation-2",
    );
    expect(policy.requests.slice(-2).map((request) => [request.action, request.riskClass])).toEqual([
      ["tracker.priority.update", "reversible-write"],
      ["tracker.completion.update", "irreversible-write"],
    ]);
    expect(linear.mutations).toHaveLength(1);
  });

  it("rejects member aliases and supports another tracker without doctrine changes", async () => {
    const invalidLinear = new RecordedLinearClient();
    invalidLinear.identity = {
      kind: "user",
      id: "alias-seat",
      displayName: "Alias",
    } as unknown as TrackerAppIdentity;
    const invalid = new TrackerMirror(new LinearTrackerClient(invalidLinear), new RecordedPolicy());
    await expect(invalid.importMission("mission-1", ref)).rejects.toThrow();

    const jiraIssue: TrackerIssue = {
      ref: { connector: "jira", workspaceId: "cloud-1", issueId: "PROJ-1" },
      identifier: "PROJ-1",
      url: "https://jira.example/browse/PROJ-1",
      revision: "42",
      intent: { title: "Build the tracker mirror", description: "Jira-owned intent" },
      priority: { value: 2, label: "High" },
      acceptanceCriteria: ["Preserve tracker intent", "Report drift"],
      state: { id: "doing", name: "Doing", type: "started" },
    };
    const jira: TrackerClient = {
      connector: "jira",
      getAppIdentity: () => Promise.resolve({ kind: "app", id: "clankie-jira", displayName: "Clankie" }),
      getIssue: () => Promise.resolve(structuredClone(jiraIssue)),
      postComment: () => Promise.resolve({ commentId: "comment-1" }),
      mirrorAssignment: () => Promise.resolve(),
      mutateIssue: () => Promise.resolve(),
    };
    const mirror = new TrackerMirror(jira, new RecordedPolicy());
    await expect(mirror.importMission("mission-1", jiraIssue.ref)).resolves.toMatchObject({
      source: { ref: { connector: "jira" } },
    });
    expect(() => mirror.validatePlan(plan())).not.toThrow();
  });
});
