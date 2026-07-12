import { readFileSync } from "node:fs";
import type {
  CaptainChannelTurnResult,
  LinearChannelTurnRequest,
  TrackerNarrativeWrite,
  TrackerNarrativeWriteResult,
} from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import {
  VerifiedLinearAgentSessionEventSchema,
  type VerifiedLinearAgentSessionEvent,
} from "../../relay/src/linear-webhook-protocol.ts";
import {
  LinearChannelAdapter,
  type LinearChannelApi,
  type LinearChannelEvidence,
} from "../src/linear-channel-adapter.ts";

const NOW = 1_783_807_200_100;
const IDENTITY = {
  missionId: "mission-linear",
  taskId: "task-linear",
  workerRunId: "worker-linear",
  correlationId: "linear-delivery:test",
  profileHash: "profile-linear",
  workspaceId: "organization-1",
  appUserId: "clankie-app-1",
};

describe("LinearChannelAdapter", () => {
  it("schedules the unconditional acknowledgement before a slow captain", async () => {
    const captain = deferred<CaptainChannelTurnResult>();
    const api = new RecordingApi(() => captain.promise);
    const evidence: LinearChannelEvidence[] = [];
    const adapter = makeAdapter(api, { evidence: (entry) => evidence.push(entry) });

    const pending = adapter.consume(event("agent-session-created.json"));
    await Promise.resolve();

    expect(api.operations).toEqual(["write:tracker.agent-activity.thought.create", "captain"]);
    expect(evidence.find((entry) => entry.outcome === "ack_scheduled")?.ackLatencyMs).toBe(100);
    captain.resolve(settled("The captain completed the requested work."));
    await expect(pending).resolves.toEqual({ status: "handled", disposition: "response" });
    expect(api.operations).toEqual([
      "write:tracker.agent-activity.thought.create",
      "captain",
      "write:tracker.agent-activity.response.create",
    ]);
  });

  it("attempts the acknowledgement even when the captain fails", async () => {
    const api = new RecordingApi(async () => {
      throw new Error("captain unavailable");
    });
    const adapter = makeAdapter(api);

    await expect(adapter.consume(event("agent-session-created.json"))).rejects.toThrow("captain unavailable");
    expect(api.writes[0]?.action).toBe("tracker.agent-activity.thought.create");
  });

  it("deduplicates a concurrent delivery without repeating captain or writes", async () => {
    const captain = deferred<CaptainChannelTurnResult>();
    const api = new RecordingApi(() => captain.promise);
    const adapter = makeAdapter(api);
    const delivery = event("agent-session-created.json");

    const first = adapter.consume(delivery);
    const duplicate = adapter.consume(delivery);
    captain.resolve(settled("One response."));

    await expect(first).resolves.toEqual({ status: "handled", disposition: "response" });
    await expect(duplicate).resolves.toEqual({ status: "ignored", reason: "duplicate_delivery" });
    expect(api.turns).toHaveLength(1);
    expect(api.writes).toHaveLength(2);

    await expect(adapter.consume(delivery)).resolves.toEqual({
      status: "ignored",
      reason: "duplicate_delivery",
    });
    expect(api.turns).toHaveLength(1);
    expect(api.writes).toHaveLength(2);
  });

  it.each([
    "agent-session-self-created.json",
    "agent-session-self-prompted.json",
    "agent-session-cross-issue-comment.json",
  ])("ignores the adversarial identity fixture %s", async (fixture) => {
    const api = new RecordingApi(async () => settled("must not run"));
    const adapter = makeAdapter(api);

    await expect(adapter.consume(event(fixture))).resolves.toMatchObject({ status: "ignored" });
    expect(api.operations).toEqual([]);
  });

  it.each([
    ["workspace", { workspaceId: "organization-other" }],
    ["app", { appUserId: "app-other" }],
    ["session", { activitySessionId: "session-other" }],
    ["root comment", { rootCommentId: "comment-other" }],
  ] as const)("rejects cross-%s identity before ack or captain work", async (_name, identityOverride) => {
    const api = new RecordingApi(async () => settled("must not run"));
    const evidence: LinearChannelEvidence[] = [];
    const adapter = makeAdapter(api, { evidence: (entry) => evidence.push(entry) });

    await expect(
      adapter.consume(
        event("agent-session-prompted.json", {
          deliveryId: `00000000-0000-4000-8000-0000000004${String(evidence.length).padStart(2, "0")}`,
          ...identityOverride,
        }),
      ),
    ).resolves.toMatchObject({ status: "ignored" });
    expect(api.operations).toEqual([]);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ outcome: "ignored" });
    expect(JSON.stringify(evidence)).not.toContain("Also preserve the Linear delivery identifier.");
  });

  it("maps waiting_user to an elicitation activity", async () => {
    const api = new RecordingApi(async () => ({
      state: "waiting_user",
      captainSessionId: "captain-session",
      turnId: "turn-1",
      prompt: "Which package should I update?",
      approvalRequired: false,
    }));
    const adapter = makeAdapter(api);

    await expect(adapter.consume(event("agent-session-prompted.json"))).resolves.toEqual({
      status: "handled",
      disposition: "elicitation",
    });
    expect(api.writes.at(-1)).toMatchObject({
      action: "tracker.agent-activity.elicitation.create",
      content: "Which package should I update?",
    });
  });

  it("refuses approval-shaped input with a deterministic authenticated deep link", async () => {
    const api = new RecordingApi(async () => settled("must not run"));
    const adapter = makeAdapter(api);
    const approval = event("agent-session-prompted.json", {
      deliveryId: "00000000-0000-4000-8000-000000000099",
      promptBody: "Approve and deploy this to production.",
    });

    await expect(adapter.consume(approval)).resolves.toEqual({
      status: "handled",
      disposition: "approval_refused",
    });
    expect(api.turns).toHaveLength(0);
    expect(api.writes.at(-1)?.content).toBe(
      "I can’t grant or execute approvals from Linear. Review this request on the authenticated approval surface: http://127.0.0.1:4310/approvals?issueId=issue-799&agentSessionId=agent-session-1",
    );
  });

  it("refuses a structurally identified Eve approval even without approval prose", async () => {
    const api = new RecordingApi(async () => ({
      state: "waiting_user",
      captainSessionId: "captain-session",
      turnId: "turn-approval",
      prompt: "Proceed with this tool call?",
      approvalRequired: true,
    }));
    const adapter = makeAdapter(api);

    await expect(adapter.consume(event("agent-session-created.json"))).resolves.toEqual({
      status: "handled",
      disposition: "approval_refused",
    });
    expect(api.writes.at(-1)?.action).toBe("tracker.agent-activity.response.create");
  });

  it("denies per-issue and workspace runaway before any acknowledgement", async () => {
    const api = new RecordingApi(async () => settled("bounded"));
    const issueBound = makeAdapter(api, { maxEventsPerIssue: 1 });
    await issueBound.consume(event("agent-session-created.json"));
    await expect(
      issueBound.consume(
        event("agent-session-created.json", {
          deliveryId: "00000000-0000-4000-8000-000000000002",
        }),
      ),
    ).resolves.toEqual({ status: "ignored", reason: "issue_cap" });

    const workspaceApi = new RecordingApi(async () => settled("bounded"));
    const workspaceBound = makeAdapter(workspaceApi, { maxEventsPerWorkspace: 1 });
    await workspaceBound.consume(event("agent-session-created.json"));
    await expect(
      workspaceBound.consume(
        event("agent-session-created.json", {
          deliveryId: "00000000-0000-4000-8000-000000000003",
          issueId: "issue-800",
        }),
      ),
    ).resolves.toEqual({ status: "ignored", reason: "workspace_cap" });
    expect(workspaceApi.writes).toHaveLength(2);
  });

  it("does not retain invalid traffic and fails closed at the delivery ledger bound", async () => {
    let now = NOW;
    const api = new RecordingApi(async () => settled("bounded"));
    const adapter = makeAdapter(api, {
      clock: () => now,
      maxRetainedDeliveries: 1,
    });

    for (let index = 0; index < 3; index += 1) {
      await expect(
        adapter.consume(
          event("agent-session-self-created.json", {
            deliveryId: `00000000-0000-4000-8000-00000000010${String(index)}`,
          }),
        ),
      ).resolves.toMatchObject({ status: "ignored", reason: "unsupported_event" });
    }

    const retained = event("agent-session-created.json");
    await expect(adapter.consume(retained)).resolves.toMatchObject({ status: "handled" });
    await expect(
      adapter.consume(
        event("agent-session-created.json", {
          deliveryId: "00000000-0000-4000-8000-000000000200",
          receivedAtMs: now - 100,
        }),
      ),
    ).rejects.toThrow("delivery retention capacity is exhausted");

    await expect(adapter.consume(retained)).resolves.toEqual({
      status: "ignored",
      reason: "duplicate_delivery",
    });
    now += 7 * 60 * 60 * 1_000 + 1;
    await expect(
      adapter.consume(
        event("agent-session-created.json", {
          deliveryId: "00000000-0000-4000-8000-000000000200",
          receivedAtMs: now - 100,
        }),
      ),
    ).resolves.toMatchObject({ status: "handled" });
  });
});

class RecordingApi implements LinearChannelApi {
  public readonly writes: TrackerNarrativeWrite[] = [];
  public readonly turns: LinearChannelTurnRequest[] = [];
  public readonly operations: string[] = [];
  private readonly captain: (request: LinearChannelTurnRequest) => Promise<CaptainChannelTurnResult>;

  public constructor(captain: (request: LinearChannelTurnRequest) => Promise<CaptainChannelTurnResult>) {
    this.captain = captain;
  }

  public async submitCaptainChannelTurn(input: LinearChannelTurnRequest): Promise<CaptainChannelTurnResult> {
    this.operations.push("captain");
    this.turns.push(input);
    return this.captain(input);
  }

  public async writeTrackerNarrative(input: TrackerNarrativeWrite): Promise<TrackerNarrativeWriteResult> {
    this.operations.push(`write:${input.action}`);
    this.writes.push(input);
    return {
      id: `activity-${String(this.writes.length)}`,
      action: input.action,
      appUserId: IDENTITY.appUserId,
    };
  }
}

function makeAdapter(
  api: LinearChannelApi,
  overrides: Partial<ConstructorParameters<typeof LinearChannelAdapter>[0]> = {},
): LinearChannelAdapter {
  return new LinearChannelAdapter({
    api,
    identity: IDENTITY,
    approvalSurfaceUrl: "http://127.0.0.1:4310/approvals",
    clock: () => NOW,
    ...overrides,
  });
}

function event(
  fixture: string,
  overrides: {
    activitySessionId?: string;
    appUserId?: string;
    deliveryId?: string;
    issueId?: string;
    promptBody?: string;
    receivedAtMs?: number;
    rootCommentId?: string;
    workspaceId?: string;
  } = {},
): VerifiedLinearAgentSessionEvent {
  const payload = structuredClone(readFixture(fixture));
  if (payload.action === "prompted") {
    if (overrides.promptBody !== undefined) {
      payload.agentActivity.content.body = overrides.promptBody;
    }
  }
  if (overrides.issueId !== undefined) {
    payload.agentSession.issueId = overrides.issueId;
    payload.agentSession.issue.id = overrides.issueId;
    payload.agentSession.issue.identifier = "VUH-800";
    payload.agentSession.comment.issueId = overrides.issueId;
    for (const comment of payload.previousComments ?? []) comment.issueId = overrides.issueId;
  }
  if (overrides.workspaceId !== undefined) {
    payload.organizationId = overrides.workspaceId;
    payload.agentSession.organizationId = overrides.workspaceId;
  }
  if (overrides.appUserId !== undefined) {
    payload.appUserId = overrides.appUserId;
    payload.agentSession.appUserId = overrides.appUserId;
  }
  if (overrides.activitySessionId !== undefined && payload.action === "prompted") {
    payload.agentActivity.agentSessionId = overrides.activitySessionId;
  }
  if (overrides.rootCommentId !== undefined) {
    payload.agentSession.commentId = overrides.rootCommentId;
  }
  return VerifiedLinearAgentSessionEventSchema.parse({
    version: 1,
    kind: "linear.agent-session-event",
    deliveryId: overrides.deliveryId ?? "00000000-0000-4000-8000-000000000001",
    correlationId: IDENTITY.correlationId,
    receivedAtMs: overrides.receivedAtMs ?? NOW - 100,
    payload,
  });
}

function readFixture(name: string): any {
  return JSON.parse(
    readFileSync(
      new URL(`../../../packages/tracker-connector/test/fixtures/${name}`, import.meta.url),
      "utf8",
    ),
  );
}

function settled(response: string): CaptainChannelTurnResult {
  return { state: "settled", captainSessionId: "captain-session", turnId: "turn-1", response };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
