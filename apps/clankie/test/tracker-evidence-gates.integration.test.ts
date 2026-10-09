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
import { trackerEvidence } from "./helpers/tracker-evidence.ts";
import { TRACKER_LEAD } from "@clankie/work-items";
import { createWorkItemsService } from "../src/work-items.ts";

/**
 * VUH-1917 through the real service surfaces: a fleet worker's clankie_call, the
 * owner's authenticated tracker route, ADR 0245 input_list/input_answer over the
 * operator dispatch route, a real conversation store, and the in-process owner
 * loop. Only the model turn a wake would start is observed at the captain seam.
 */
it("requires independently checked real evidence, blocks a run on an owner gate and records run controls", async () => {
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
  const evidence = trackerEvidence(root);
  const tracker = createLocalTracker({
    directory: join(root, "tracker"),
    validateEvidence: evidence.validateEvidence,
  });
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
    requestOwnerAsk: (conversationId, draft, publicationId) =>
      conversations.requestSurfaceQuestion(conversationId, draft, {
        current: () => true,
        ...(publicationId === undefined ? {} : { publicationId }),
      }),
    readOwnerAsk: (requestId) => conversations.readOwnerAsk(requestId),
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
  let stopLoop = await startTrackerOwnerLoop({
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
    const issue = await call("linear_save_issue", { team: "LOCAL", title: "Evidence and gate round trip" });
    const run = await call("linear_save_run", { issueId: issue.id, worktree: repo, branch: "proof" });
    await call("linear_post_issue_event", { issueId: issue.id, type: "result", stage: "landed" });
    expect(
      (await raw("linear_post_issue_event", { issueId: issue.id, type: "result", stage: "delivered" }))
        .detail,
    ).toContain("evidence_bundle_required");
    expect((await raw("linear_save_issue", { id: issue.id, state: "Delivered" })).detail).toContain(
      "evidence_bundle_required",
    );
    // Owner verification has the same completion gate, including the hand-set Done route.
    const without = await app.app.request("/v1/tracker/owner/call", {
      method: "POST",
      headers: { authorization: "Bearer tracker-owner", "content-type": "application/json" },
      body: JSON.stringify({ name: "save_issue", arguments: { id: issue.id, state: "Done" } }),
    });
    expect((await without.json()).detail).toContain("evidence_bundle_required");
    const reference = await evidence.record(issue.identifier);
    const bundle = await call("linear_save_evidence_bundle", {
      issueId: issue.id,
      references: [reference],
      gaps: ["No visual needed for this API contract."],
    });
    const runBundle = await call("linear_save_evidence_bundle", {
      issueId: issue.id,
      runId: run.id,
      references: [reference],
      gaps: [],
    });
    expect((await call("linear_list_runs", { issueId: issue.id })).runs[0].bundle.id).toBe(runBundle.id);
    expect((await raw("linear_post_bundle_check", { bundleId: bundle.id })).detail).toContain(
      "bundle_self_check",
    );
    expect(
      (await raw("linear_post_issue_event", { issueId: issue.id, type: "result", stage: "delivered" }))
        .detail,
    ).toContain("bundle_check_required");
    await owner("post_bundle_check", {
      bundleId: bundle.id,
      body: "Independent owner inspected the real log.",
    });
    await call("linear_post_issue_event", { issueId: issue.id, type: "result", stage: "delivered" });
    expect(
      (await raw("linear_save_evidence_bundle", { issueId: issue.id, references: [reference], gaps: [] }))
        .detail,
    ).toContain("bundle_locked");
    await owner("save_issue", { id: issue.id, state: "In Review" });
    const replacement = await call("linear_save_evidence_bundle", {
      issueId: issue.id,
      references: [reference],
      gaps: [],
    });
    expect((await call("linear_get_evidence_bundle", { issueId: issue.id })).checked).toBeUndefined();
    expect((await raw("linear_post_bundle_check", { bundleId: bundle.id })).detail).toContain(
      "bundle_superseded",
    );
    await settle();
    const verifyList = await dispatch({ op: "input_list" });
    const verify = verifyList.result.questions.find((entry: any) => entry.question?.purpose === "verify");
    await dispatch({
      op: "input_answer",
      conversationId: verify.conversationId,
      incarnationId: verify.incarnationId,
      requestId: verify.question.requestId,
      expectedRevision: verify.revision,
      answer: {
        kind: "choice",
        optionId: verify.question.options.find((option: any) => option.label === "It works").optionId,
      },
    });
    await settle();
    expect((await call("linear_get_issue", { id: issue.id })).stage).toBe("owner-verified");
    const events = (await call("linear_list_issue_events", { issueId: issue.id })).events;
    expect(
      events.some(
        (event: any) =>
          event.type === "bundle_checked" && event.bundleId === replacement.id && event.via === "owner_ask",
      ),
    ).toBe(true);

    const gate = await call("linear_post_issue_ask", {
      issueId: issue.id,
      runId: run.id,
      purpose: "gate",
      gate: "merge",
      body: "Approve merging this run's result?",
      idempotencyKey: "request-merge-gate",
    });
    expect((await raw("linear_save_run", { id: run.id, status: "succeeded" })).detail).toContain(
      "run_blocked",
    );
    await settle();
    const linked = await call("linear_get_issue", { id: issue.id });
    expect(linked.ownerAsks.some((ref: any) => ref.eventId === gate.id && ref.runId === run.id)).toBe(true);
    const asks = await dispatch({ op: "input_list" });
    const ask = asks.result.questions.find((entry: any) => entry.question?.purpose === "gate");
    expect(ask.question.issue.key).toBe(issue.identifier);
    const unauthorized = await app.app.request("/operator/v1/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        op: "input_answer",
        conversationId: ask.conversationId,
        incarnationId: ask.incarnationId,
        requestId: ask.question.requestId,
        expectedRevision: ask.revision,
        answer: { kind: "choice", optionId: ask.question.options[0].optionId },
      }),
    });
    expect(unauthorized.status).not.toBe(200);
    expect((await raw("linear_post_run_control", { runId: run.id, action: "stop" })).detail).toContain(
      "run_control_reserved",
    );
    // A caller-selected public receipt key cannot shadow the host's resolution.
    await call("linear_create_comment", {
      issueId: issue.id,
      body: "Worker report before approval.",
      idempotencyKey: `owner-ask:${ask.question.requestId}`,
    });
    // Approval can commit while the tracker loop is stopped; restart reconciles it.
    await stopLoop();
    await dispatch({
      op: "input_answer",
      conversationId: ask.conversationId,
      incarnationId: ask.incarnationId,
      requestId: ask.question.requestId,
      expectedRevision: ask.revision,
      answer: {
        kind: "choice",
        optionId: ask.question.options.find((option: any) => option.label === "Approve").optionId,
      },
    });
    stopLoop = await startTrackerOwnerLoop({
      tracker,
      captain,
      settings,
      statePath: join(root, "tracker", "owner-loop.json"),
      logger: { info() {}, warn() {} },
    });
    await settle();
    expect((await call("linear_list_runs", { issueId: issue.id })).runs[0].blocked).toBe(false);
    await call("linear_save_run", { id: run.id, tokens: 42 });
    // Lead controls are stamped as the lead, rather than an owner approval.
    const lead = { ...TRACKER_LEAD, onBehalfOf: [] };
    await tracker.call(
      "post_run_control",
      { runId: run.id, action: "steer", body: "Inspect the diff before finishing." },
      { actor: lead },
    );
    await tracker.call("post_run_control", { runId: run.id, action: "pause" }, { actor: lead });
    expect((await raw("linear_save_run", { id: run.id, status: "succeeded" })).detail).toContain(
      "run_blocked",
    );
    await owner("post_run_control", { runId: run.id, action: "stop", body: "Stop this attempt." });
    const controls = (await call("linear_list_issue_events", { issueId: issue.id })).events;
    expect(controls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "gate",
          to: "approved",
          actor: { type: "human", id: "owner", name: "Owner", onBehalfOf: [] },
        }),
        expect.objectContaining({
          type: "steer",
          runId: run.id,
          actor: expect.objectContaining({ id: "clankie" }),
        }),
        expect.objectContaining({ type: "pause", runId: run.id }),
        expect.objectContaining({ type: "stop", runId: run.id }),
      ]),
    );
    expect((await call("linear_list_runs", { issueId: issue.id })).runs[0].status).toBe("canceled");
  } finally {
    await stopLoop();
    evidence.store.close();
    await app.close();
    await worker.close();
    await host.close();
    await conversations.close();
    await rm(root, { recursive: true, force: true });
  }
});
