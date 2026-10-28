import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import {
  OperatorCurrentActivitySchema,
  OperatorPresenceSnapshotSchema,
  OperatorPresenceResultSchema,
} from "@clankie/protocol/presence";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { QuestionDraftSchema } from "../src/captain/conversation-questions.ts";
import {
  createOperatorService,
  type CreateOperatorServiceContext,
} from "../src/captain/captain-operator-service.ts";
import { FleetChangeClock } from "../src/captain/herdr-fleet-changes.ts";
import { DesktopExpressions } from "../src/captain/desktop.ts";
import { BodyLeaseStore } from "../src/body-leases.ts";
import { BodyLeaseRouter } from "../src/body-lease-router.ts";

it("serves opt-in owner activity from live native events and call ownership, preserves legacy presence, and clears settled work", async () => {
  const root = await mkdtemp(join(tmpdir(), "current-activity-http-"));
  const settings = new SettingsStore(join(root, "settings.json"));
  const conversations = new ConversationStore(join(root, "conversations"), async () => {});
  const leases = new BodyLeaseStore(join(root, "leases"));
  conversations.presenceVoiceLease = () => new BodyLeaseRouter(leases).activeIncarnation("voice");
  let headOccupant: string | undefined;
  let working = true,
    validOwner = true;
  const service = createOperatorService({
    personas: { ready: async () => undefined },
    conversations,
    settingsStore: settings,
    deps: {
      presence: { listSessions: async () => [] },
      embodiment: { getLiveSession: async () => undefined },
      bodyLeases: new BodyLeaseRouter(leases),
    },
    fleetChanges: new FleetChangeClock(),
    liveSeats: [],
    refreshFleet: async () => [],
    observeFleet: async () => ({ head: { status: working ? "working" : "idle", occupantId: headOccupant } }),
    sessions: new Map(),
    desktop: new DesktopExpressions(async () => (await settings.load()).desktop),
    shutdown: new AbortController(),
  } as unknown as CreateOperatorServiceContext);
  const app = await createClankieApp({
    settings,
    eventLogPath: join(root, "events.jsonl"),
    captain: createStubCaptain({ serveOperatorConversation: service }),
    authenticateCaptain: async (r) =>
      r.headers.get("authorization") === "Bearer captain"
        ? { captainId: "fixture", steerSourceLane: "api" }
        : undefined,
    authenticateOperator: async (r) =>
      validOwner && r.headers.get("authorization") === "Bearer owner" ? { operatorId: "fixture" } : undefined,
  });
  const server = serve({ fetch: app.app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not listen");
  const request = (current = true, bearer = "owner", tools = true) =>
    fetch(`http://127.0.0.1:${address.port}/operator/v1/dispatch`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({
        op: "presence",
        schemaVersion: 1,
        includeActivities: true,
        ...(current ? { includeCurrentActivity: true, ...(tools ? { includeToolActivity: true } : {}) } : {}),
      }),
    });
  const legacyResult = OperatorPresenceResultSchema.extend({
    snapshot: OperatorPresenceSnapshotSchema.extend({
      currentActivity: OperatorCurrentActivitySchema.omit({ kind: true }).strict().optional(),
    }),
  });
  const read = async () => OperatorPresenceResultSchema.parse(await (await request()).json()).snapshot;
  try {
    await conversations.serve({ op: "get", schemaVersion: 1, conversationId: "global-default" });
    const legacy = OperatorPresenceResultSchema.parse(
      await (await request(false, "captain")).json(),
    ).snapshot;
    conversations.publishHeadEvent({
      type: "tool",
      toolCallId: "coding-tool",
      name: "exec_command",
      phase: "started",
      detail: JSON.stringify({ cmd: "pnpm check", token: "private-token", note: "Bearer abcdefghijklmnop" }),
    });
    const coding = await read();
    expect(coding.currentActivity).toMatchObject({
      source: "coding",
      target: { kind: "conversation", conversationId: "global-default" },
    });
    expect.soft(coding.currentActivity?.text).toBe("Running a check");
    expect.soft(coding.currentActivity).toMatchObject({ kind: "tool" });
    expect(coding.currentActivity?.text).not.toContain("private-token");
    expect(coding.currentActivity?.text).not.toContain("abcdefghijklmnop");
    expect(await read()).toEqual(coding);
    // An old strict client opts into current activity, but knows no kind field.
    // It gets no tool bubble; speech and questions still use their original shape.
    const oldClient = legacyResult.parse(await (await request(true, "owner", false)).json()).snapshot;
    expect(oldClient.currentActivity).toBeUndefined();
    const unchanged = OperatorPresenceResultSchema.parse(
      await (await request(false, "captain")).json(),
    ).snapshot;
    expect(unchanged).toEqual(legacy);
    expect((await request(true, "captain")).status).toBe(403);
    expect((await request(true, "missing")).status).toBe(403);

    for (const [name, args, expected] of [
      [
        "Bash",
        {
          command: "cd ~/Library/secret && cat private.json",
          description: "Check available space\nwithout changing files",
        },
        "Check available space without changing files",
      ],
      ["hire", { taskTitle: "Fix the desktop pet", prompt: "PRIVATE_BRIEF" }, "Fix the desktop pet"],
      ["mcp__worker__message_peer", { text: "PRIVATE_MESSAGE" }, "Messaging a worker"],
      ["unknown_native_tool", { command: "PRIVATE_COMMAND" }, "Working"],
      ["Bash", { command: "PRIVATE_COMMAND", description: "   " }, "Running a check"],
    ] as const) {
      conversations.publishHeadEvent({
        type: "tool",
        toolCallId: "safe-tool",
        name,
        phase: "started",
        detail: JSON.stringify(args),
      });
      expect.soft((await read()).currentActivity).toMatchObject({ kind: "tool", text: expected });
    }

    conversations.publishHeadEvent({
      type: "tool",
      toolCallId: "issue-tool",
      name: "mcp__worker__clankie_call",
      phase: "started",
      detail: JSON.stringify({
        name: "linear_get_issue",
        arguments: { id: "VUH-2819", apiKey: "hidden-key" },
      }),
    });
    expect((await read()).currentActivity).toMatchObject({
      source: "issue",
      kind: "tool",
      text: "Updating VUH-2819",
      target: { kind: "issue", key: "VUH-2819" },
    });
    expect(JSON.stringify(await read())).not.toContain("hidden-key");
    conversations.publishHeadEvent({
      type: "tool",
      toolCallId: "issue-tool",
      name: "mcp__worker__clankie_call",
      phase: "completed",
    });
    expect((await read()).currentActivity).toBeUndefined();

    conversations.publishHeadEvent({
      type: "tool",
      toolCallId: "discord-tool",
      name: "discord_read_messages",
      phase: "started",
      detail: "Reading the owner's approved chat",
    });
    expect((await read()).currentActivity?.source).toBe("discord");
    working = false;
    expect((await read()).currentActivity).toBeUndefined();
    working = true;
    expect((await read()).currentActivity).toBeUndefined();

    const lease = leases.acquire("voice", "global-default", 30000);
    if (lease.outcome !== "acquired") throw new Error("Voice unavailable");
    conversations.recordVoiceCallLine(
      "global-default",
      "clankie",
      "Here is the full spoken reply. api_key=hidden-call-secret",
    );
    expect((await read()).currentActivity).toMatchObject({
      source: "call",
      text: "Here is the full spoken reply. [REDACTED]",
      target: { kind: "conversation", conversationId: "global-default" },
    });
    leases.release(lease.lease);
    // No presence sample in the gap: the next call must never inherit this call's speech.
    const replacementCall = leases.acquire("voice", "global-default", 30000);
    if (replacementCall.outcome !== "acquired") throw new Error("Replacement call unavailable");
    expect((await read()).currentActivity).toBeUndefined();
    conversations.recordVoiceCallLine("global-default", "clankie", "Fresh replacement call");
    expect((await read()).currentActivity).toMatchObject({ source: "call", text: "Fresh replacement call" });
    leases.release(replacementCall.lease);
    expect((await read()).currentActivity).toBeUndefined();

    const room = conversations.roomConversation("discord_presence", "mixed-room");
    conversations.publishRoomEvent(room, {
      type: "message",
      role: "captain",
      text: "PRIVATE_MIXED_ROOM",
      streaming: false,
    });
    expect(JSON.stringify(await read())).not.toContain("PRIVATE_MIXED_ROOM");

    const first = {
      id: "history",
      type: "message" as const,
      role: "agent" as const,
      text: "HISTORICAL_CONTENT",
      occurredAt: new Date().toISOString(),
    };
    conversations.syncHeadTranscript("head", { sessionKey: "codex:fixture", entries: [first] });
    expect((await read()).currentActivity).toBeUndefined();
    conversations.syncHeadTranscript("head", {
      sessionKey: "codex:fixture",
      entries: [first, { ...first, id: "new", text: "Live owner chat" }],
    });
    expect((await read()).currentActivity).toMatchObject({ source: "chat", text: "Live owner chat" });
    const legacyChat = legacyResult.parse(await (await request(true, "owner", false)).json()).snapshot
      .currentActivity;
    expect(legacyChat).toMatchObject({ source: "chat", text: "Live owner chat" });
    expect(legacyChat).not.toHaveProperty("kind");
    conversations.publishHeadEvent({
      type: "tool",
      toolCallId: "old-session-tool",
      name: "exec_command",
      phase: "started",
      detail: "OLD_SESSION_COMMAND",
    });
    // Remains working throughout; replacement's first historical fold is not live content.
    conversations.syncHeadTranscript("head", {
      sessionKey: "codex:replacement",
      entries: [{ ...first, id: "replacement-history" }],
    });
    expect((await read()).currentActivity).toBeUndefined();
    conversations.publishHeadEvent({
      type: "tool",
      toolCallId: "new-session-tool",
      name: "exec_command",
      phase: "started",
      detail: "Fresh session command",
    });
    expect((await read()).currentActivity).toMatchObject({
      source: "coding",
      kind: "tool",
      text: "Running a check",
    });
    headOccupant = "native-A";
    conversations.rememberNativeHead("global-default", headOccupant);
    conversations.publishHeadEvent({
      type: "tool",
      toolCallId: "head-A-tool",
      name: "exec_command",
      phase: "started",
      detail: "HEAD_A_COMMAND",
    });
    const headA = (await read()).currentActivity;
    expect(headA?.text).toBe("Running a check");
    expect((await read()).currentActivity).toEqual(headA);
    // Census observes B before B has a transcript, while working remains true.
    headOccupant = "native-B";
    expect((await read()).currentActivity).toBeUndefined();
    conversations.rememberNativeHead("global-default", headOccupant);
    conversations.publishHeadEvent({
      type: "tool",
      toolCallId: "head-B-tool",
      name: "exec_command",
      phase: "started",
      detail: "HEAD_B_COMMAND",
    });
    expect((await read()).currentActivity?.text).toBe("Running a check");
    conversations.publishHeadEvent({
      type: "tool",
      toolCallId: "head-B-tool",
      name: "exec_command",
      phase: "completed",
    });
    const workspace = join(root, "question-workspace");
    await mkdir(workspace);
    const made = await conversations.serve({
      op: "create",
      schemaVersion: 1,
      scope: { kind: "workspace", workspaceId: workspace },
      title: "Owner question",
    });
    if (made.op !== "create") throw new Error("Question thread unavailable");
    const questionThread = made.conversation.conversationId;
    const admission = { current: () => true, authorize: async () => true };
    const owner = { ...admission, principal: { kind: "operator" as const, id: "fixture" } };
    const prompt =
      "Which project should I use? " +
      "Keep the complete question available in its own thread. ".repeat(12) +
      "api_key=private-question-secret";
    const ask = (conversationId: string, text: string) =>
      conversations.requestSurfaceQuestion(
        conversationId,
        QuestionDraftSchema.parse({
          purpose: "decision",
          kind: "choice",
          prompt: text,
          waitingOn: "The project selection",
          recommendation: "This project",
          options: [{ label: "This project" }, { label: "Another project" }],
        }),
        admission,
      );
    const asked = await ask(questionThread, prompt);
    if (!asked.question || asked.revision === undefined) throw new Error("Question not published");
    conversations.publishHeadEvent({
      type: "tool",
      toolCallId: "question-interrupted-tool",
      name: "exec_command",
      phase: "started",
      detail: "STALE_QUESTION_TOOL",
    });
    const questionActivity = (await read()).currentActivity;
    // Waiting on a question must not suspend the underlying event's lifetime checks.
    working = false;
    expect((await read()).currentActivity).toEqual(questionActivity);
    working = true;
    expect(questionActivity).toMatchObject({
      source: "chat",
      target: { kind: "conversation", conversationId: questionThread },
    });
    expect(questionActivity?.text).toBe(prompt.replace("api_key=private-question-secret", "[REDACTED]"));
    expect(questionActivity!.text.length).toBeGreaterThan(200);
    expect(
      legacyResult.parse(await (await request(true, "owner", false)).json()).snapshot.currentActivity,
    ).toEqual(questionActivity);
    expect((await read()).currentActivity).toEqual(questionActivity);
    const ordinary = OperatorPresenceResultSchema.parse(
      await (await request(false, "captain")).json(),
    ).snapshot;
    expect(ordinary.currentActivity).toBeUndefined();
    expect(ordinary.pendingOwnerItem).toMatchObject({
      conversationId: questionThread,
      questionId: asked.question.requestId,
      title: prompt.slice(0, 200),
    });
    expect((await request(true, "captain")).status).toBe(403);
    const answered = await conversations.serve(
      {
        op: "input_answer",
        schemaVersion: 1,
        conversationId: questionThread,
        requestId: asked.question.requestId,
        incarnationId: asked.question.incarnationId,
        expectedRevision: asked.revision,
        answer: { kind: "choice", optionId: asked.question.options[0]!.optionId },
      },
      owner,
    );
    expect(answered).toMatchObject({ op: "input_answer", result: { question: { status: "submitted" } } });
    expect((await read()).currentActivity).toBeUndefined();
    const replacement = await ask(questionThread, "Which project should I use instead?");
    if (!replacement.question || replacement.revision === undefined)
      throw new Error("Replacement question unavailable");
    expect((await read()).currentActivity?.id).not.toBe(questionActivity?.id);
    await conversations.cancelSurfaceQuestion(
      questionThread,
      {
        requestId: replacement.question.requestId,
        incarnationId: replacement.question.incarnationId,
        expectedRevision: replacement.revision,
      },
      admission,
    );
    expect((await read()).currentActivity).toBeUndefined();
    const roomQuestion = await ask(room, "PRIVATE_MIXED_ROOM_QUESTION");
    if (!roomQuestion.question || roomQuestion.revision === undefined)
      throw new Error("Room question unavailable");
    expect((await read()).currentActivity).toBeUndefined();
    await conversations.cancelSurfaceQuestion(
      room,
      {
        requestId: roomQuestion.question.requestId,
        incarnationId: roomQuestion.question.incarnationId,
        expectedRevision: roomQuestion.revision,
      },
      admission,
    );
    const cursor = (await read()).cursor;
    const pending = fetch(`http://127.0.0.1:${address.port}/operator/v1/dispatch`, {
      method: "POST",
      headers: { authorization: "Bearer owner", "content-type": "application/json" },
      body: JSON.stringify({
        op: "presence",
        schemaVersion: 1,
        includeCurrentActivity: true,
        includeActivities: true,
        cursor,
        waitMs: 100,
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    validOwner = false;
    expect((await pending).status).toBe(403);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    app.close();
    await conversations.close();
    leases.close();
    await rm(root, { recursive: true, force: true });
  }
});
