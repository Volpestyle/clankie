import type { TrackerNarrativeWrite } from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import {
  CredentialBrokerLinearAgentClient,
  type LinearAgentClient,
  type LinearAgentSession,
} from "../src/linear-agent-client.ts";
import type {
  LinearGraphqlRequest,
  LinearOAuthCredentialBroker,
  LinearOAuthCredentialRef,
} from "../src/linear-agent-auth.ts";
import { CredentialBrokerLinearAgentRuntime } from "../src/linear-agent-runtime.ts";
import type { TrackerClient } from "../src/types.ts";

const IDENTITY = {
  missionId: "mission-linear",
  taskId: "task-linear",
  workerRunId: "worker-linear",
  correlationId: "linear-delivery:test",
  profileHash: "profile-linear",
  workspaceId: "organization-1",
  appUserId: "clankie-app-1",
};

describe("CredentialBrokerLinearAgentRuntime", () => {
  it("rejects a trusted thread whose root comment belongs to another issue", async () => {
    const client = fakeClient({ commentIssueId: "issue-other" });
    const runtime = new CredentialBrokerLinearAgentRuntime(client);

    await expect(runtime.readThread(turnRequest())).rejects.toThrow(
      "root comment belongs to a different issue",
    );
  });

  it("rejects a trusted thread whose root comment differs from the requested root", async () => {
    const client = fakeClient({ rootCommentId: "comment-other" });
    const runtime = new CredentialBrokerLinearAgentRuntime(client);

    await expect(runtime.readThread(turnRequest())).rejects.toThrow(
      "root comment does not match the channel turn",
    );
  });

  it("rejects a narrative result authored by a different app identity", async () => {
    const client = fakeClient({ activityAppUserId: "other-app" });
    const runtime = new CredentialBrokerLinearAgentRuntime(client);

    await expect(runtime.writeNarrative(narrative())).rejects.toThrow(
      "activity result belongs to a different app identity",
    );
  });

  it("writes issue comments through the trusted tracker client with app identity", async () => {
    const client = fakeClient();
    const comments: Array<{ issueId: string; body: string; idempotencyKey: string }> = [];
    const trackerClient = fakeTrackerClient(comments);
    const runtime = new CredentialBrokerLinearAgentRuntime(client, trackerClient);

    await expect(
      runtime.writeNarrative({
        ...narrative(),
        action: "tracker.comment.create",
        idempotencyKey: "delivery:comment",
      }),
    ).resolves.toEqual({
      id: "comment-1",
      action: "tracker.comment.create",
      appUserId: IDENTITY.appUserId,
    });
    expect(comments).toEqual([{ issueId: "issue-799", body: "Done.", idempotencyKey: "delivery:comment" }]);
  });

  it("reads every activity page through the broker-backed client before building context", async () => {
    const broker = new PaginatedBroker();
    const client = new CredentialBrokerLinearAgentClient(broker, {
      credential: { workspaceId: IDENTITY.workspaceId, credentialId: "installation-1" },
      appUserId: IDENTITY.appUserId,
    });
    const runtime = new CredentialBrokerLinearAgentRuntime(client);

    await expect(runtime.readThread(turnRequest())).resolves.toMatchObject({
      activities: [{ id: "activity-1" }, { id: "activity-2" }],
    });
    expect(broker.activityCursors).toEqual([undefined, "cursor-1"]);
    expect(broker.documents).toEqual([
      expect.stringContaining("activities(first: 50, after: $activityAfter)"),
      expect.stringContaining("activities(first: 50, after: $activityAfter)"),
    ]);
  });

  it("fails closed when a thread exceeds the 500-activity protocol bound", async () => {
    const client = fakeClient();
    let page = 0;
    client.getAgentSession = async () => {
      page += 1;
      return sessionFixture(
        Array.from({ length: 50 }, (_, index) => agentActivity(`page-${String(page)}-${String(index)}`)),
        { endCursor: `cursor-${String(page)}`, hasNextPage: true },
      );
    };
    const runtime = new CredentialBrokerLinearAgentRuntime(client);

    await expect(runtime.readThread(turnRequest())).rejects.toThrow(
      "thread exceeds the bounded activity limit",
    );
    expect(page).toBe(10);
  });

  it("fails closed when a paginated thread omits its next cursor", async () => {
    const client = fakeClient();
    client.getAgentSession = async () => sessionFixture([agentActivity("activity-1")], { hasNextPage: true });
    const runtime = new CredentialBrokerLinearAgentRuntime(client);

    await expect(runtime.readThread(turnRequest())).rejects.toThrow("invalid pagination metadata");
  });

  it("fails closed on a non-adjacent repeated activity cursor", async () => {
    const client = fakeClient();
    const cursors = ["cursor-a", "cursor-b", "cursor-a"];
    let page = 0;
    client.getAgentSession = async () =>
      sessionFixture([agentActivity(`activity-${String(page)}`)], {
        endCursor: cursors[page++],
        hasNextPage: true,
      });
    const runtime = new CredentialBrokerLinearAgentRuntime(client);

    await expect(runtime.readThread(turnRequest())).rejects.toThrow("invalid pagination metadata");
    expect(page).toBe(3);
  });

  it("revalidates exact root binding on every activity page", async () => {
    const client = fakeClient();
    let page = 0;
    client.getAgentSession = async () => {
      page += 1;
      return page === 1
        ? sessionFixture([agentActivity("activity-1")], {
            endCursor: "cursor-1",
            hasNextPage: true,
          })
        : sessionFixture([agentActivity("activity-2")], { hasNextPage: false }, "issue-799", "comment-other");
    };
    const runtime = new CredentialBrokerLinearAgentRuntime(client);

    await expect(runtime.readThread(turnRequest())).rejects.toThrow(
      "root comment does not match the channel turn",
    );
    expect(page).toBe(2);
  });
});

function fakeClient(
  options: { commentIssueId?: string; activityAppUserId?: string; rootCommentId?: string } = {},
): LinearAgentClient {
  return {
    identity: { workspaceId: IDENTITY.workspaceId, appUserId: IDENTITY.appUserId },
    async getAgentSession() {
      return sessionFixture([], { hasNextPage: false }, options.commentIssueId, options.rootCommentId);
    },
    async listAgentSessions() {
      return { nodes: [], pageInfo: { hasNextPage: false } };
    },
    async createAgentActivity(input) {
      return {
        id: "activity-1",
        createdAt: "2026-07-11T22:00:02.000Z",
        updatedAt: "2026-07-11T22:00:02.000Z",
        ephemeral: input.ephemeral ?? false,
        user: { id: options.activityAppUserId ?? IDENTITY.appUserId, name: "App" },
        content: input.content,
      };
    },
    async reactionCreate(input) {
      return { id: "reaction-1", emoji: input.emoji };
    },
  };
}

function fakeTrackerClient(
  comments: Array<{ issueId: string; body: string; idempotencyKey: string }>,
): TrackerClient {
  return {
    connector: "linear",
    async getAppIdentity() {
      return { kind: "app", id: IDENTITY.appUserId, displayName: "Clankie" };
    },
    async getIssue() {
      throw new Error("not used");
    },
    async postComment(input) {
      comments.push({
        issueId: input.ref.issueId,
        body: input.body,
        idempotencyKey: input.idempotencyKey,
      });
      return { commentId: "comment-1" };
    },
    async mirrorAssignment() {
      throw new Error("not used");
    },
    async mutateIssue() {
      throw new Error("not used");
    },
  };
}

class PaginatedBroker implements LinearOAuthCredentialBroker {
  public readonly activityCursors: Array<string | undefined> = [];
  public readonly documents: string[] = [];

  public async exchangeAuthorizationCode(): Promise<never> {
    throw new Error("not used");
  }

  public async refresh(): Promise<never> {
    throw new Error("not used");
  }

  public async executeGraphql(input: {
    credential: LinearOAuthCredentialRef;
    request: LinearGraphqlRequest;
  }): Promise<unknown> {
    expect(input.credential).toEqual({
      workspaceId: IDENTITY.workspaceId,
      credentialId: "installation-1",
    });
    const cursor = input.request.variables.activityAfter;
    const activityAfter = typeof cursor === "string" ? cursor : undefined;
    this.activityCursors.push(activityAfter);
    this.documents.push(input.request.document);
    return {
      agentSession:
        activityAfter === undefined
          ? sessionFixture([agentActivity("activity-1")], {
              endCursor: "cursor-1",
              hasNextPage: true,
            })
          : sessionFixture([agentActivity("activity-2")], {
              endCursor: null,
              hasNextPage: false,
            }),
    };
  }
}

function sessionFixture(
  activities: LinearAgentSession["activities"]["nodes"],
  pageInfo: LinearAgentSession["activities"]["pageInfo"],
  commentIssueId = "issue-799",
  rootCommentId = "comment-root-1",
): LinearAgentSession {
  return {
    id: "agent-session-1",
    status: "active",
    createdAt: "2026-07-11T22:00:00.000Z",
    updatedAt: "2026-07-11T22:00:01.000Z",
    appUser: { id: IDENTITY.appUserId, name: "Clankie" },
    issue: {
      id: "issue-799",
      identifier: "VUH-799",
      title: "Linear bridge",
      url: "https://linear.app/vuhlp/issue/VUH-799/linear-bridge",
    },
    comment: {
      id: rootCommentId,
      body: "Please handle this.",
      issueId: commentIssueId,
    },
    activities: { nodes: activities, pageInfo },
  };
}

function agentActivity(id: string): LinearAgentSession["activities"]["nodes"][number] {
  return {
    id,
    createdAt: "2026-07-11T22:00:02.000Z",
    updatedAt: "2026-07-11T22:00:02.000Z",
    ephemeral: false,
    user: { id: IDENTITY.appUserId, name: "Clankie" },
    content: { type: "thought", body: id },
  };
}

function turnRequest() {
  return {
    schemaVersion: 1 as const,
    deliveryId: "00000000-0000-4000-8000-000000000001",
    action: "created" as const,
    identity: IDENTITY,
    issue: {
      id: "issue-799",
      identifier: "VUH-799",
      url: "https://linear.app/vuhlp/issue/VUH-799/linear-bridge",
    },
    session: { id: "agent-session-1", appUserId: IDENTITY.appUserId },
    trigger: {
      kind: "comment" as const,
      id: "comment-root-1",
      rootCommentId: "comment-root-1",
      actorId: "user-james",
      body: "Please handle this.",
    },
  };
}

function narrative(): TrackerNarrativeWrite {
  return {
    schemaVersion: 1,
    idempotencyKey: "delivery:response",
    action: "tracker.agent-activity.response.create",
    identity: IDENTITY,
    issueId: "issue-799",
    agentSessionId: "agent-session-1",
    content: "Done.",
  };
}
