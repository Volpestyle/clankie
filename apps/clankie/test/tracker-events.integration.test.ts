import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { createLocalTracker } from "@clankie/work-items";
import { createClankieApp } from "../src/app.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { startTrackerOwnerLoop } from "../src/tracker-owner-loop.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";
import { createWorkItemsService } from "../src/work-items.ts";

/**
 * VUH-1917 through the real service surfaces: a fleet worker's clankie_call, the
 * owner's authenticated tracker route, ADR 0245 input_list/input_answer over the
 * operator dispatch route, a real conversation store, and the in-process owner
 * loop. Only the model turn a wake would start is observed at the captain seam.
 */
it("moves an item through every stage, asks the owner to check it, verifies on answer and wakes the lead chat on owner activity only", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-tracker-events-"));
  const settings = new SettingsStore(join(root, "settings.json"));
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  const conversations = new ConversationStore(join(root, "conversations"), async () => {});
  const created = await conversations.serve(
    { op: "create", schemaVersion: 1, scope: { kind: "global" }, title: "Lead" },
    undefined,
  );
  if (created.op !== "create") throw new Error("create failed");
  const leadChat = created.conversation.conversationId;
  const tracker = createLocalTracker({ directory: join(root, "tracker") });
  let workItems!: ReturnType<typeof createWorkItemsService>;
  const host = createMcpHost({
    credentials,
    settings,
    localTracker: tracker,
    curated: [
      {
        id: "linear",
        credential: "linear",
        transport: "http",
        url: "http://127.0.0.1:1/mcp",
        args: [],
        lane: "everywhere",
        initialTools: [],
        enabled: true,
      },
    ],
    trackerForRepo: ({ name, args, repo, local, ...publication }) =>
      workItems.callTracker(name, args, { repo, local, ...publication }),
    trackerRepoForCall: (name, args) => workItems.resolveTrackerRepo(name, args),
    logger: { info() {}, warn() {} },
  });
  workItems = createWorkItemsService({
    stateDirectory: join(root, "work"),
    globalTrackerDirectory: join(root, "tracker"),
    workspace: () => repo,
    mcpHost: host,
  });
  const worker = new WorkerMcp({
    directory: join(root, "grants"),
    credentials,
    host,
    fleetTools: async () => (await settings.load()).fleet.tools,
    fleetToolsSnapshot: async () => {
      const snapshot = await settings.loadFenced();
      return { tools: snapshot.settings.fleet.tools, assertCurrent: snapshot.assertCurrent };
    },
  });
  const wakes: { conversationId: string; text: string }[] = [];
  const captain = createStubCaptain({
    // The ask operations this test sends are conversation-store requests.
    serveOperatorConversation: (request, owner) =>
      conversations.serve(request as Parameters<ConversationStore["serve"]>[0], owner),
    requestOwnerAsk: (conversationId, draft) =>
      conversations.requestSurfaceQuestion(conversationId, draft, { current: () => true }),
    observeQuestionResolutions: (listener) => conversations.observeQuestionResolutions(listener),
    linearWakeTargetAllowed: (conversationId) => conversations.linearWakeTargetAllowed(conversationId),
    wakeConversation: async (owner, text) => {
      wakes.push({ conversationId: (owner as { conversationId: string }).conversationId, text });
      return true;
    },
  });
  const app = await createClankieApp({
    captain,
    workerMcp: worker,
    workItems,
    builtInTracker: tracker,
    fleetLinks: {
      identity: () => undefined,
      authenticate: (token) => (token === "local-fleet-test" ? "test-fleet" : undefined),
    },
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer tracker-owner" ? { operatorId: "owner" } : undefined,
  });
  const stopLoop = await startTrackerOwnerLoop({
    tracker,
    captain,
    settings,
    statePath: join(root, "tracker", "owner-loop.json"),
    logger: { info() {}, warn() {} },
  });
  let sequence = 0;
  let session: string | undefined;
  const rpc = (method: string, params: unknown) =>
    app.app.request("/v1/fleet/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer local-fleet-test",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
    });
  session = (
    await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tracker-events-integration", version: "1" },
    })
  ).headers.get("mcp-session-id")!;
  const raw = async (name: string, args: Record<string, unknown>) => {
    const response = await rpc("tools/call", { name: "clankie_call", arguments: { name, arguments: args } });
    const result = (await response.json()).result as { content: { text: string }[] };
    return JSON.parse(result.content[0]!.text) as { outcome: string; content?: string; detail?: string };
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const reply = await raw(name, args);
    expect(reply, JSON.stringify(reply)).toMatchObject({ outcome: "ok" });
    return JSON.parse(reply.content!);
  };
  const owner = async (name: string, args: Record<string, unknown>) => {
    const response = await app.app.request("/v1/tracker/owner/call", {
      method: "POST",
      headers: { authorization: "Bearer tracker-owner", "content-type": "application/json" },
      body: JSON.stringify({ name, arguments: args }),
    });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body.result;
  };
  const dispatch = async (request: Record<string, unknown>) => {
    const response = await app.app.request("/operator/v1/dispatch", {
      method: "POST",
      headers: { authorization: "Bearer tracker-owner", "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, ...request }),
    });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body;
  };
  const settle = async () => {
    // The owner loop runs in-process and serially; let its queued steps finish.
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  };
  try {
    const project = await owner("save_project", { name: "Clankie Work", addTeams: ["LOCAL"] });
    await settings.update((value) => ({
      ...value,
      linearWebhook: {
        ...value.linearWebhook,
        projectChats: [{ projectId: project.id, name: "Clankie Work", conversationId: leadChat }],
      },
    }));
    const issue = await call("linear_save_issue", {
      team: "LOCAL",
      title: "Stage walk",
      project: project.id,
    });
    expect(issue.stage).toBe("reported");

    // Typed reports derive state: ack accepts, blocked flags until the next progress.
    expect((await call("linear_post_issue_event", { issueId: issue.id, type: "ack" })).stage).toBe(
      "accepted",
    );
    await call("linear_post_issue_event", { issueId: issue.id, type: "plan", body: "Three steps" });
    await call("linear_post_issue_event", { issueId: issue.id, type: "blocked", body: "Waiting on CI" });
    expect((await call("linear_get_issue", { id: issue.id })).blocked).toBe(true);
    await call("linear_post_issue_event", { issueId: issue.id, type: "action", body: "CI green" });
    const progressed = await call("linear_get_issue", { id: issue.id });
    expect(progressed).toMatchObject({ blocked: false, stage: "accepted", status: "In Progress" });

    // Agents cannot close or verify work; only the owner can.
    const closing = await raw("linear_save_issue", { id: issue.id, state: "Done" });
    expect(closing.detail).toContain("owner_verification_required");
    const verifying = await raw("linear_post_issue_event", {
      issueId: issue.id,
      type: "result",
      stage: "owner-verified",
    });
    expect(verifying.detail).toContain("owner_verification_required");

    // Landed raises one "check it works" ask (ADR 0245) in the project's lead chat.
    const landed = await call("linear_post_issue_event", {
      issueId: issue.id,
      type: "result",
      body: "Merged as abc123",
      stage: "landed",
    });
    expect(landed).toMatchObject({ stage: "landed", status: "In Review" });
    await call("linear_post_issue_event", { issueId: issue.id, type: "result", stage: "delivered" });
    await settle();
    const listed = await dispatch({ op: "input_list" });
    const asks = listed.result.questions.filter(
      (entry: { question: { purpose: string } }) => entry.question.purpose === "verify",
    );
    expect(asks).toHaveLength(1);
    const ask = asks[0].question;
    expect(ask).toMatchObject({
      conversationId: leadChat,
      status: "pending",
      issue: { tracker: "clankie-work", key: issue.identifier, url: issue.url },
    });
    // Clankie's and the worker's own events never woke anyone.
    expect(wakes).toEqual([]);

    // The owner comments: owner activity wakes the routed lead chat.
    await owner("save_comment", { issueId: issue.id, body: "Looks close, checking now" });
    await settle();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.conversationId).toBe(leadChat);
    expect(wakes[0]!.text).toContain("Looks close, checking now");

    // Answering the ask sets owner-verified as the owner; the answer wakes its source chat itself.
    const answered = await dispatch({
      op: "input_answer",
      conversationId: ask.conversationId,
      requestId: ask.requestId,
      incarnationId: ask.incarnationId,
      expectedRevision: listed.result.questions.find(
        (entry: { question: { requestId: string } }) => entry.question.requestId === ask.requestId,
      ).revision,
      answer: {
        kind: "choice",
        optionId: ask.options.find((option: { label: string }) => option.label === "It works").optionId,
      },
    });
    expect(answered.result.question.status).toBe("submitted");
    await settle();
    const verified = await call("linear_get_issue", { id: issue.id });
    expect(verified).toMatchObject({ stage: "owner-verified", status: "Done", statusType: "completed" });
    expect(wakes).toHaveLength(1);

    // The stream: typed, derived, hash-linked, resumable, and self-echo flagged.
    const stream = await call("linear_list_issue_events", { issueId: issue.id });
    expect(
      stream.events.map((event: { type: string; to?: string; selfEcho: boolean }) => [
        event.type,
        event.to ?? null,
        event.selfEcho,
      ]),
    ).toEqual([
      ["created", "reported", true],
      ["ack", null, true],
      ["stage", "accepted", true],
      ["plan", null, true],
      ["blocked", null, true],
      ["action", null, true],
      ["result", null, true],
      ["stage", "landed", true],
      ["result", null, true],
      ["stage", "delivered", true],
      ["comment", null, false],
      ["result", null, false],
      ["verified", "owner-verified", false],
    ]);
    const verifiedEvent = stream.events.at(-1);
    expect(verifiedEvent).toMatchObject({ actor: { type: "human", id: "owner" }, via: "owner_ask" });
    const all = (await call("linear_list_issue_events", {})).events as {
      seq: number;
      prevHash: string;
      hash: string;
    }[];
    all.slice(1).forEach((event, index) => expect(event.prevHash).toBe(all[index]!.hash));
    const resumed = await call("linear_list_issue_events", { after: String(all.at(-3)!.seq) });
    expect(resumed.events.map((event: { seq: number }) => event.seq)).toEqual(
      all.slice(-2).map((event) => event.seq),
    );
    expect(resumed.cursor).toBe(String(all.at(-1)!.seq));

    // Reprioritizing is owner activity too; reopening a verified item is the owner's alone.
    await owner("save_issue", { id: issue.id, priority: 1 });
    await settle();
    expect(wakes).toHaveLength(2);
    expect(wakes[1]!.text).toContain('"type":"priority"');
    const reopenByWorker = await raw("linear_save_issue", { id: issue.id, state: "In Progress" });
    expect(reopenByWorker.detail).toContain("owner_verification_required");
  } finally {
    stopLoop();
    app.close();
    await worker.close();
    await host.close();
    await conversations.close();
    await rm(root, { recursive: true, force: true });
  }
});
