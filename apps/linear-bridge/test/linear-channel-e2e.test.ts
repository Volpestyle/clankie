import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { ClankieApiClient } from "@clankie/api-client";
import type { LinearGraphqlRequest, LinearOAuthCredentialBroker } from "@clankie/tracker-connector";
import {
  CredentialBrokerLinearAgentClient,
  CredentialBrokerLinearAgentRuntime,
} from "@clankie/tracker-connector";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../../control-plane/src/app.ts";
import { EveCaptainChannelTurnPort } from "../../control-plane/src/eve-captain-turn.ts";
import { LinearWebhookLocalBridge } from "../../relay/src/linear-webhook-bridge.ts";
import { LinearWebhookIngress } from "../../relay/src/linear-webhook-ingress.ts";
import { RetainedLinearWebhookQueue } from "../../relay/src/linear-webhook-queue.ts";
import { compileDoctrine, loadDoctrineFile } from "../../../packages/doctrine/src/index.ts";
import { LinearChannelAdapter } from "../src/linear-channel-adapter.ts";

describe("Linear channel recorded end-to-end contract", () => {
  it.each(["agent-session-created.json", "agent-session-prompted.json"] as const)(
    "runs untouched %s through signed ingress -> policy ack -> trusted thread -> Eve -> response",
    async (fixtureName) => {
      const fixture = readFixture(fixtureName);
      const now = fixture.webhookTimestamp + 100;
      const doctrine = compileDoctrine([
        await loadDoctrineFile(
          new URL("../../../doctrine/profiles/self-build-lab.yaml", import.meta.url).pathname,
        ),
      ]);
      const broker = new RecordedLinearBroker(fixture);
      const client = new CredentialBrokerLinearAgentClient(broker, {
        credential: { workspaceId: "organization-1", credentialId: "broker-installation-1" },
        appUserId: "clankie-app-1",
      });
      const runtime = new CredentialBrokerLinearAgentRuntime(client);
      const eveRequests: Array<{ url: string; body?: unknown }> = [];
      const eve = new EveCaptainChannelTurnPort({
        baseUrl: "http://127.0.0.1:4321",
        fetchImpl: async (input, init) => {
          const url = String(input);
          eveRequests.push({
            url,
            ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
          });
          if (init?.method === "POST") {
            return Response.json(
              { sessionId: "eve-session-1", continuationToken: "continuation-1" },
              { status: 202 },
            );
          }
          return new Response(
            [
              { type: "turn.started", data: { turnId: "eve-turn-1" } },
              {
                type: "message.completed",
                data: {
                  turnId: "eve-turn-1",
                  finishReason: "stop",
                  message: "Implemented the bounded Linear bridge.",
                },
              },
              { type: "session.waiting", data: { turnId: "eve-turn-1" } },
            ]
              .map((event) => JSON.stringify(event))
              .join("\n"),
            { headers: { "content-type": "application/x-ndjson" } },
          );
        },
      });
      const controlPlane = await createControlPlane({
        doctrine,
        linearAgentRuntime: runtime,
        captainChannelTurns: eve,
        clock: () => new Date(now),
      });
      const api = new ClankieApiClient({
        baseUrl: "http://127.0.0.1:4310",
        fetchImpl: async (input, init) => controlPlane.fetch(new Request(input, init)),
      });
      const adapter = new LinearChannelAdapter({
        api,
        identity: {
          missionId: "mission-linear",
          taskId: "task-linear",
          workerRunId: "worker-linear",
          profileHash: doctrine.profileHash,
          workspaceId: "organization-1",
          appUserId: "clankie-app-1",
        },
        approvalSurfaceUrl: "http://127.0.0.1:4310/approvals",
        clock: () => now,
      });
      const signingSecret = "linear-channel-e2e-secret";
      const queue = new RetainedLinearWebhookQueue({ clock: () => now });
      const localBridge = new LinearWebhookLocalBridge({ signingSecret, clock: () => now });
      const connection = await localBridge.dial(queue);
      const ingress = new LinearWebhookIngress({ signingSecret, queue, clock: () => now });
      const rawBody = Buffer.from(JSON.stringify(fixture));
      const deliveryId =
        fixture.action === "created"
          ? "00000000-0000-4000-8000-000000000010"
          : "00000000-0000-4000-8000-000000000011";
      const ingressResult = ingress.handle({
        method: "POST",
        headers: new Headers({
          "content-type": "application/json",
          "linear-delivery": deliveryId,
          "linear-event": "AgentSessionEvent",
          "linear-signature": createHmac("sha256", signingSecret).update(rawBody).digest("hex"),
          "linear-timestamp": String(fixture.webhookTimestamp),
        }),
        rawBody,
      });
      let channelOutcome: Awaited<ReturnType<LinearChannelAdapter["consume"]>> | undefined;

      expect(ingressResult).toMatchObject({ status: 200, outcome: "accepted" });
      await expect(
        connection.processNext(async (verified) => {
          channelOutcome = await adapter.consume(verified);
        }),
      ).resolves.toBe("delivered");
      expect(channelOutcome).toEqual({ status: "handled", disposition: "response" });

      expect(broker.operations.map((entry) => entry.operationName)).toEqual([
        "AgentActivityCreate",
        "AgentSession",
        "AgentActivityCreate",
      ]);
      expect(broker.activities.map((activity) => activity.content)).toEqual([
        { type: "thought", body: "I’m looking into this." },
        { type: "response", body: "Implemented the bounded Linear bridge." },
      ]);
      const createBody = eveRequests[0]?.body as {
        message?: string;
        clientContext?: { identity?: { deliveryId?: string }; thread?: { rootComment?: { body?: string } } };
      };
      expect(createBody.message).toBe(
        fixture.action === "prompted"
          ? fixture.agentActivity?.content.body
          : "@Clankie implement the agent-owned criteria.",
      );
      expect(createBody.clientContext?.identity?.deliveryId).toBe(deliveryId);
      expect(createBody.clientContext?.thread?.rootComment?.body).toBe(
        "@Clankie implement the agent-owned criteria.",
      );
      await connection.close();
    },
  );

  it("rejects non-narrative tracker actions at the control-plane schema boundary", async () => {
    const doctrine = compileDoctrine([
      await loadDoctrineFile(
        new URL("../../../doctrine/profiles/self-build-lab.yaml", import.meta.url).pathname,
      ),
    ]);
    const response = await (
      await createControlPlane({
        doctrine,
        linearAgentRuntime: new CredentialBrokerLinearAgentRuntime(
          new CredentialBrokerLinearAgentClient(
            new RecordedLinearBroker(readFixture("agent-session-created.json")),
            {
              credential: { workspaceId: "organization-1", credentialId: "broker-installation-1" },
              appUserId: "clankie-app-1",
            },
          ),
        ),
      })
    ).request("/v1/tracker/narratives", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        idempotencyKey: "escape",
        action: "tracker.status.update",
        identity: {
          missionId: "mission-linear",
          taskId: "task-linear",
          workerRunId: "worker-linear",
          correlationId: "linear-delivery:escape",
          profileHash: doctrine.profileHash,
          workspaceId: "organization-1",
          appUserId: "clankie-app-1",
        },
        issueId: "issue-799",
        agentSessionId: "agent-session-1",
        content: "Done",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_tracker_narrative" });
  });
});

class RecordedLinearBroker implements LinearOAuthCredentialBroker {
  public readonly operations: LinearGraphqlRequest[] = [];
  public readonly activities: Array<{ content: unknown }> = [];
  private readonly fixture: ReturnType<typeof readFixture>;

  public constructor(fixture: ReturnType<typeof readFixture>) {
    this.fixture = fixture;
  }

  public async exchangeAuthorizationCode(): Promise<never> {
    throw new Error("not used");
  }

  public async refresh(): Promise<never> {
    throw new Error("not used");
  }

  public async executeGraphql(input: { request: LinearGraphqlRequest }): Promise<unknown> {
    this.operations.push(input.request);
    if (input.request.operationName === "AgentSession") {
      const session = this.fixture.agentSession;
      return {
        agentSession: {
          id: session.id,
          status: session.status,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          url: session.url,
          appUser: { id: this.fixture.appUserId, name: "Clankie" },
          creator: { id: session.creator.id, name: session.creator.name },
          issue: session.issue,
          comment: session.comment,
          activities: { nodes: [], pageInfo: { hasNextPage: false } },
        },
      };
    }
    if (input.request.operationName === "AgentActivityCreate") {
      const variables = input.request.variables as {
        input: { id: string; ephemeral?: boolean; content: { type: string; body: string } };
      };
      this.activities.push({ content: variables.input.content });
      return {
        agentActivityCreate: {
          success: true,
          agentActivity: {
            id: variables.input.id,
            createdAt: "2026-07-11T22:00:02.000Z",
            updatedAt: "2026-07-11T22:00:02.000Z",
            ephemeral: variables.input.ephemeral ?? false,
            user: { id: this.fixture.appUserId, name: "Clankie" },
            content: variables.input.content,
          },
        },
      };
    }
    throw new Error(`Unexpected operation ${input.request.operationName}`);
  }
}

function readFixture(name: string): {
  action: "created" | "prompted";
  webhookTimestamp: number;
  appUserId: string;
  agentActivity?: { content: { body: string } };
  agentSession: {
    id: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    url: string;
    creator: { id: string; name: string };
    issue: { id: string; identifier: string; title: string; url: string };
    comment: { id: string; body: string; issueId: string };
  };
} & Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      new URL(`../../../packages/tracker-connector/test/fixtures/${name}`, import.meta.url),
      "utf8",
    ),
  ) as ReturnType<typeof readFixture>;
}
