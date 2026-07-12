import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  CredentialBrokerLinearAgentClient,
  LinearAgentSessionEventWebhookSchema,
  LinearOAuthCredentialStatusSchema,
  parseLinearAgentSessionEvent,
  type LinearGraphqlRequest,
  type LinearOAuthCredentialBroker,
  type LinearOAuthCredentialRef,
} from "../src/index.ts";

const credential: LinearOAuthCredentialRef = {
  workspaceId: "workspace-1",
  credentialId: "linear-installation-1",
};
const appUserId = "clankie-app-1";
const timestamp = "2026-07-11T22:00:00.000Z";

function activity(content: Record<string, unknown>) {
  return {
    id: "activity-1",
    createdAt: timestamp,
    updatedAt: timestamp,
    ephemeral: false,
    user: { id: appUserId, name: "Clankie" },
    content,
  };
}

function session(appId = appUserId) {
  return {
    id: "agent-session-1",
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    endedAt: null,
    summary: null,
    url: "https://linear.app/example/issue/VUH-799/session-1",
    appUser: { id: appId, name: "Clankie" },
    creator: { id: "user-1", name: "James" },
    issue: {
      id: "issue-799",
      identifier: "VUH-799",
      title: "Register Clankie as a Linear agent",
      url: "https://linear.app/example/issue/VUH-799/register-clankie",
    },
    comment: { id: "comment-1", body: "@Clankie please implement this", issueId: "issue-799" },
    activities: {
      nodes: [activity({ type: "prompt", body: "Please implement this" })],
      pageInfo: { endCursor: null, hasNextPage: false },
    },
  };
}

class RecordedCredentialBroker implements LinearOAuthCredentialBroker {
  public readonly graphqlRequests: Array<{
    credential: LinearOAuthCredentialRef;
    request: LinearGraphqlRequest;
  }> = [];
  public sessionAppUserId = appUserId;
  public activityAppUserId = appUserId;
  public graphqlFailure: Error | undefined;
  private readonly organizationSecret = "secret-marker-never-observable";

  public exchangeAuthorizationCode(input: {
    credential: LinearOAuthCredentialRef;
    authorizationCodeHandle: string;
    redirectUri: string;
  }): Promise<{
    workspaceId: string;
    appUserId: string;
    expiresAt: string;
    scopes: string[];
  }> {
    expect(input.credential).toEqual(credential);
    return Promise.resolve({
      workspaceId: credential.workspaceId,
      appUserId,
      expiresAt: "2026-07-12T22:00:00.000Z",
      scopes: ["read", "write", "app:mentionable", "app:assignable"],
    });
  }

  public refresh(input: {
    credential: LinearOAuthCredentialRef;
  }): ReturnType<RecordedCredentialBroker["exchangeAuthorizationCode"]> {
    return this.exchangeAuthorizationCode({
      credential: input.credential,
      authorizationCodeHandle: "broker-managed-refresh",
      redirectUri: "https://clankie.example/oauth/callback",
    });
  }

  public executeGraphql(input: {
    credential: LinearOAuthCredentialRef;
    request: LinearGraphqlRequest;
  }): Promise<unknown> {
    if (this.organizationSecret.length === 0) throw new Error("Missing broker credential");
    this.graphqlRequests.push(structuredClone(input));
    if (this.graphqlFailure) return Promise.reject(this.graphqlFailure);
    switch (input.request.operationName) {
      case "AgentSession":
        return Promise.resolve({ agentSession: session(this.sessionAppUserId) });
      case "AgentSessions":
        return Promise.resolve({
          agentSessions: {
            nodes: [session(this.sessionAppUserId)],
            pageInfo: { endCursor: "cursor-1", hasNextPage: false },
          },
        });
      case "AgentActivityCreate": {
        const variables = input.request.variables as {
          input: { content: Record<string, unknown>; ephemeral?: boolean };
        };
        return Promise.resolve({
          agentActivityCreate: {
            success: true,
            agentActivity: {
              ...activity(variables.input.content),
              ephemeral: variables.input.ephemeral ?? false,
              user: { id: this.activityAppUserId, name: "Clankie" },
            },
          },
        });
      }
      case "ReactionCreate": {
        const variables = input.request.variables as { input: { emoji: string } };
        return Promise.resolve({
          reactionCreate: {
            success: true,
            reaction: { id: "reaction-1", emoji: variables.input.emoji },
          },
        });
      }
      default:
        throw new Error(`Unexpected operation ${input.request.operationName}`);
    }
  }
}

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
}

const eventContext = {
  deliveryId: "234d1a4e-b617-4388-90fe-adc3633d6b72",
  appUserId,
  missionId: "mission-799",
  taskId: "task-799",
  workerRunId: "worker-799",
  correlationId: "correlation-799",
  profileHash: "profile-799",
} as const;

describe("Linear OAuth app-agent client", () => {
  it("keeps exchange, refresh, and GraphQL execution behind a secret-free broker boundary", async () => {
    const broker = new RecordedCredentialBroker();
    const exchanged = LinearOAuthCredentialStatusSchema.parse(
      await broker.exchangeAuthorizationCode({
        credential,
        authorizationCodeHandle: "broker-code-handle-1",
        redirectUri: "https://clankie.example/oauth/callback",
      }),
    );
    const refreshed = LinearOAuthCredentialStatusSchema.parse(await broker.refresh({ credential }));
    const client = new CredentialBrokerLinearAgentClient(broker, { credential, appUserId });

    expect(exchanged).toEqual(refreshed);
    expect(client.identity).toEqual({ workspaceId: "workspace-1", appUserId });
    expect(JSON.stringify({ exchanged, refreshed, identity: client.identity })).not.toMatch(
      /secret-marker|access.?token|refresh.?token|client.?secret|authorization/iu,
    );
  });

  it("queries sessions and emits thought, response, elicitation, and reactionCreate operations", async () => {
    const broker = new RecordedCredentialBroker();
    const client = new CredentialBrokerLinearAgentClient(broker, { credential, appUserId });

    await expect(client.getAgentSession("agent-session-1")).resolves.toMatchObject({
      id: "agent-session-1",
      appUser: { id: appUserId },
      issue: { identifier: "VUH-799" },
    });
    await expect(client.listAgentSessions({ first: 25 })).resolves.toMatchObject({
      nodes: [{ id: "agent-session-1" }],
      pageInfo: { hasNextPage: false },
    });
    for (const content of [
      { type: "thought", body: "I am starting the task." },
      { type: "response", body: "The task is complete." },
      { type: "elicitation", body: "Which workspace should I use?" },
    ] as const) {
      await expect(
        client.createAgentActivity({ agentSessionId: "agent-session-1", content }),
      ).resolves.toMatchObject({ content });
    }
    await expect(client.reactionCreate({ issueId: "issue-799", emoji: "eyes" })).resolves.toEqual({
      id: "reaction-1",
      emoji: "eyes",
    });
    await expect(client.reactionCreate({ commentId: "comment-1", emoji: "+1" })).resolves.toMatchObject({
      emoji: "+1",
    });

    expect(broker.graphqlRequests.map(({ request }) => request.operationName)).toEqual([
      "AgentSession",
      "AgentSessions",
      "AgentActivityCreate",
      "AgentActivityCreate",
      "AgentActivityCreate",
      "ReactionCreate",
      "ReactionCreate",
    ]);
    expect(JSON.stringify(broker.graphqlRequests)).not.toMatch(
      /secret-marker-never-observable|access.?token|refresh.?token|client.?secret/iu,
    );
  });

  it("rejects ambiguous reaction parents and sessions owned by another app", async () => {
    const broker = new RecordedCredentialBroker();
    const client = new CredentialBrokerLinearAgentClient(broker, { credential, appUserId });
    await expect(
      client.reactionCreate({ issueId: "issue-1", commentId: "comment-1", emoji: "eyes" } as never),
    ).rejects.toThrow();
    broker.sessionAppUserId = "different-app";
    await expect(client.getAgentSession("agent-session-1")).rejects.toThrow(/different app identity/u);
  });

  it("rejects activity results owned by another app and GraphQL failures", async () => {
    const broker = new RecordedCredentialBroker();
    const client = new CredentialBrokerLinearAgentClient(broker, { credential, appUserId });
    broker.activityAppUserId = "different-app";
    await expect(
      client.createAgentActivity({
        agentSessionId: "agent-session-1",
        content: { type: "response", body: "This result has the wrong actor." },
      }),
    ).rejects.toThrow(/activity belongs to a different app identity/u);

    broker.graphqlFailure = new Error("Linear GraphQL request failed");
    await expect(client.getAgentSession("agent-session-1")).rejects.toThrow(/Linear GraphQL request failed/u);
  });
});

describe("Linear AgentSessionEvent contract", () => {
  it("maps a recorded created event with issue, comment, actor, session, delivery, and correlation identity", async () => {
    const event = parseLinearAgentSessionEvent(await fixture("agent-session-created"), eventContext);
    expect(event).toMatchObject({
      id: `linear-agent-session:${eventContext.deliveryId}`,
      type: "tracker.agent-session.created",
      missionId: "mission-799",
      taskId: "task-799",
      workerRunId: "worker-799",
      correlationId: "correlation-799",
      causationId: "webhook-1",
      data: {
        delivery: { id: eventContext.deliveryId, webhookId: "webhook-1" },
        correlation: { id: "correlation-799" },
        issue: { id: "issue-799", identifier: "VUH-799" },
        comment: { id: "comment-source-1", rootId: "comment-root-1", actorId: "user-james" },
        actor: { id: "user-james", name: "James Volpe" },
        session: {
          id: "agent-session-1",
          appUserId,
          organizationId: "organization-1",
          issueId: "issue-799",
        },
      },
    });
  });

  it("maps a recorded prompted event to the prompting actor and source comment", async () => {
    const event = parseLinearAgentSessionEvent(await fixture("agent-session-prompted"), eventContext);
    expect(event).toMatchObject({
      type: "tracker.agent-session.prompted",
      data: {
        comment: { id: "comment-prompt-1", rootId: "comment-root-1", actorId: "user-james" },
        actor: { id: "user-james" },
        activity: {
          id: "agent-activity-prompt-1",
          type: "prompt",
          body: "Also preserve the Linear delivery identifier.",
          actorId: "user-james",
          sourceCommentId: "comment-prompt-1",
        },
      },
    });
  });

  it("accepts absent documented optional context without losing required identities", async () => {
    const raw = (await fixture("agent-session-created")) as Record<string, unknown>;
    delete raw.guidance;
    delete raw.previousComments;
    const sessionPayload = raw.agentSession as Record<string, unknown>;
    delete sessionPayload.url;
    const event = parseLinearAgentSessionEvent(raw, eventContext);
    expect(event.data).toMatchObject({ issue: { id: "issue-799" }, session: { id: "agent-session-1" } });
  });

  it("rejects invalid actions, self events, cross-issue comments, and inconsistent identities", async () => {
    for (const name of ["agent-session-invalid-action", "agent-session-invalid-identity"]) {
      expect(LinearAgentSessionEventWebhookSchema.safeParse(await fixture(name)).success, name).toBe(false);
    }
    for (const [name, message] of [
      ["agent-session-self-created", "Agent session event is self-authored"],
      ["agent-session-self-prompted", "Agent session event is self-authored"],
      ["agent-session-cross-issue-comment", "Session comment belongs to a different issue"],
      ["agent-session-cross-issue-previous-comment", "Previous comment belongs to a different issue"],
    ] as const) {
      const result = LinearAgentSessionEventWebhookSchema.safeParse(await fixture(name));
      expect(result.success, name).toBe(false);
      if (!result.success) {
        expect(result.error.issues, name).toEqual(
          expect.arrayContaining([expect.objectContaining({ message })]),
        );
      }
    }
    const created = await fixture("agent-session-created");
    expect(() =>
      parseLinearAgentSessionEvent(created, {
        ...eventContext,
        deliveryId: "not-a-linear-delivery-uuid",
      }),
    ).toThrow();
    expect(() =>
      parseLinearAgentSessionEvent(created, {
        ...eventContext,
        appUserId: "different-configured-app",
      }),
    ).toThrow(/configured app identity/u);
  });
});
