import { resolve } from "node:path";
import { compileDoctrine, loadDoctrineFile } from "@clankie/doctrine";
import type {
  LinearAgentThreadContext,
  LinearChannelTurnRequest,
  TrackerNarrativeWrite,
} from "@clankie/protocol";
import type { LinearAgentRuntimePort } from "@clankie/tracker-connector";
import { beforeAll, describe, expect, it } from "vitest";
import { createControlPlane } from "../src/app.ts";
import { EveCaptainChannelTurnPort } from "../src/eve-captain-turn.ts";

let doctrine: Awaited<ReturnType<typeof compileDoctrine>>;

beforeAll(async () => {
  doctrine = compileDoctrine([
    await loadDoctrineFile(resolve(import.meta.dirname, "../../../doctrine/profiles/self-build-lab.yaml")),
  ]);
});

describe("Linear channel control-plane runtime", () => {
  it("deduplicates a delivery before trusted thread read or captain submission", async () => {
    const runtime = new RecordingRuntime();
    let submissions = 0;
    const app = await createControlPlane({
      doctrine,
      linearAgentRuntime: runtime,
      captainChannelTurns: {
        async submit() {
          submissions += 1;
          return {
            state: "settled",
            captainSessionId: "captain-session",
            turnId: "turn-1",
            response: "Done.",
          };
        },
      },
    });
    const request = turnRequest();

    const first = await post(app, "/v1/captain/channel-turns", request);
    const duplicate = await post(app, "/v1/captain/channel-turns", request);
    const conflict = await post(app, "/v1/captain/channel-turns", {
      ...request,
      trigger: { ...request.trigger, body: "Different body" },
    });

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect(conflict.status).toBe(409);
    expect(runtime.reads).toBe(1);
    expect(submissions).toBe(1);
  });

  it("retains one narrative evaluator and enforces its mission window", async () => {
    const runtime = new RecordingRuntime();
    const app = await createControlPlane({
      doctrine,
      linearAgentRuntime: runtime,
      clock: () => new Date("2026-07-11T22:00:00.000Z"),
    });

    for (let index = 0; index < 20; index += 1) {
      const response = await post(app, "/v1/tracker/narratives", narrative(index));
      expect(response.status).toBe(200);
    }
    const denied = await post(app, "/v1/tracker/narratives", narrative(20));

    expect(denied.status).toBe(403);
    expect(runtime.writes).toBe(20);
  });

  it("routes all five narrative kinds through the retained policy evaluator", async () => {
    const runtime = new RecordingRuntime();
    const app = await createControlPlane({
      doctrine,
      linearAgentRuntime: runtime,
      clock: () => new Date("2026-07-11T22:00:00.000Z"),
    });
    const writes: TrackerNarrativeWrite[] = [
      { ...narrative(100), action: "tracker.comment.create", ephemeral: undefined },
      { ...narrative(101), action: "tracker.agent-activity.thought.create" },
      {
        ...narrative(102),
        action: "tracker.agent-activity.response.create",
        ephemeral: undefined,
      },
      {
        ...narrative(103),
        action: "tracker.agent-activity.elicitation.create",
        ephemeral: undefined,
      },
      {
        ...narrative(104),
        action: "tracker.reaction.create",
        commentId: "comment-root-1",
        content: "eyes",
        ephemeral: undefined,
      },
    ];

    for (const write of writes) {
      const response = await post(app, "/v1/tracker/narratives", write);
      expect(response.status).toBe(200);
    }
    expect(runtime.writes).toBe(5);
  });

  it("maps only a real Eve input request to waiting_user", async () => {
    const requests: Array<{ url: string; body?: unknown }> = [];
    const port = new EveCaptainChannelTurnPort({
      baseUrl: "http://127.0.0.1:4321",
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
        });
        if (init?.method === "POST") {
          return Response.json({ sessionId: "eve-session", continuationToken: "token-1" }, { status: 202 });
        }
        return new Response(
          [
            { type: "turn.started", data: { turnId: "turn-1" } },
            {
              type: "input.requested",
              data: {
                turnId: "turn-1",
                requests: [
                  {
                    requestId: "question-1",
                    prompt: "Which package?",
                    display: "select",
                    allowFreeform: true,
                    options: [
                      { id: "approve", label: "Approve this wording" },
                      { id: "deny", label: "Use different wording" },
                    ],
                    action: {
                      kind: "tool-call",
                      callId: "question-1",
                      toolName: "ask_question",
                      input: { prompt: "Which package?" },
                    },
                  },
                ],
              },
            },
            { type: "session.waiting", data: { turnId: "turn-1" } },
          ]
            .map((event) => JSON.stringify(event))
            .join("\n"),
        );
      },
    });

    await expect(port.submit({ request: turnRequest(), thread: thread() })).resolves.toEqual({
      state: "waiting_user",
      captainSessionId: "eve-session",
      turnId: "turn-1",
      prompt: "Which package?",
      approvalRequired: false,
    });
    expect(requests[0]?.body).toMatchObject({
      message: "Please handle this.",
      clientContext: {
        channel: { kind: "linear", authority: "ambient", issueId: "issue-799" },
      },
    });
  });

  it.each([
    [
      "confirmation display with alternate reversed options",
      {
        requestId: "approval-1",
        prompt: "Proceed with this tool call?",
        display: "confirmation",
        options: [
          { id: "cancel-operation", label: "Stop" },
          { id: "continue-operation", label: "Proceed" },
        ],
        action: {
          kind: "tool-call",
          callId: "tool-1",
          toolName: "write_file",
          input: {},
        },
      },
    ],
    [
      "tool action metadata without confirmation display",
      {
        requestId: "approval-2",
        prompt: "Allow the file write?",
        display: "select",
        options: [
          { id: "no", label: "No" },
          { id: "yes", label: "Yes" },
        ],
        action: {
          kind: "tool-call",
          callId: "tool-2",
          toolName: "write_file",
          input: {},
        },
      },
    ],
  ] as const)("identifies %s as approval and abandons its Eve cursor", async (_name, inputRequest) => {
    const postUrls: string[] = [];
    let sessions = 0;
    const port = new EveCaptainChannelTurnPort({
      baseUrl: "http://127.0.0.1:4321",
      fetchImpl: async (input, init) => {
        if (init?.method === "POST") {
          postUrls.push(String(input));
          sessions += 1;
          return Response.json(
            { sessionId: `eve-session-${String(sessions)}`, continuationToken: `token-${String(sessions)}` },
            { status: 202 },
          );
        }
        if (sessions === 1) {
          return ndjson([
            { type: "turn.started", data: { turnId: "turn-approval" } },
            {
              type: "input.requested",
              data: {
                requests: [inputRequest],
              },
            },
            { type: "session.waiting", data: { turnId: "turn-approval" } },
          ]);
        }
        return ndjson([
          { type: "turn.started", data: { turnId: "turn-fresh" } },
          {
            type: "message.completed",
            data: { turnId: "turn-fresh", finishReason: "stop", message: "Fresh turn." },
          },
          { type: "session.waiting", data: { turnId: "turn-fresh" } },
        ]);
      },
    });

    await expect(port.submit({ request: turnRequest(), thread: thread() })).resolves.toMatchObject({
      state: "waiting_user",
      approvalRequired: true,
    });
    await expect(port.submit({ request: turnRequest(), thread: thread() })).resolves.toMatchObject({
      state: "settled",
      response: "Fresh turn.",
    });
    expect(postUrls).toEqual([
      "http://127.0.0.1:4321/eve/v1/session",
      "http://127.0.0.1:4321/eve/v1/session",
    ]);
  });
});

class RecordingRuntime implements LinearAgentRuntimePort {
  public reads = 0;
  public writes = 0;

  public async readThread(): Promise<LinearAgentThreadContext> {
    this.reads += 1;
    return thread();
  }

  public async writeNarrative(write: TrackerNarrativeWrite) {
    this.writes += 1;
    return { id: `activity-${String(this.writes)}`, action: write.action, appUserId: "clankie-app-1" };
  }
}

function turnRequest(): LinearChannelTurnRequest {
  return {
    schemaVersion: 1,
    deliveryId: "00000000-0000-4000-8000-000000000001",
    action: "created",
    identity: {
      missionId: "mission-linear",
      taskId: "task-linear",
      workerRunId: "worker-linear",
      correlationId: "linear-delivery:test",
      profileHash: doctrine.profileHash,
      workspaceId: "organization-1",
      appUserId: "clankie-app-1",
    },
    issue: {
      id: "issue-799",
      identifier: "VUH-799",
      url: "https://linear.app/vuhlp/issue/VUH-799/linear-bridge",
    },
    session: { id: "agent-session-1", appUserId: "clankie-app-1" },
    trigger: {
      kind: "comment",
      id: "comment-root-1",
      rootCommentId: "comment-root-1",
      actorId: "user-james",
      body: "Please handle this.",
    },
  };
}

function narrative(index: number): TrackerNarrativeWrite {
  return {
    schemaVersion: 1,
    idempotencyKey: `delivery-${String(index)}:ack`,
    action: "tracker.agent-activity.thought.create",
    identity: turnRequest().identity,
    issueId: "issue-799",
    agentSessionId: "agent-session-1",
    content: `Acknowledgement ${String(index)}`,
    ephemeral: true,
  };
}

function thread(): LinearAgentThreadContext {
  return {
    workspaceId: "organization-1",
    appUserId: "clankie-app-1",
    sessionId: "agent-session-1",
    issue: {
      id: "issue-799",
      identifier: "VUH-799",
      title: "Linear bridge",
      url: "https://linear.app/vuhlp/issue/VUH-799/linear-bridge",
    },
    rootComment: { id: "comment-root-1", body: "Please handle this.", issueId: "issue-799" },
    activities: [],
  };
}

async function post(app: Awaited<ReturnType<typeof createControlPlane>>, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function ndjson(events: readonly unknown[]): Response {
  return new Response(events.map((event) => JSON.stringify(event)).join("\n"));
}
