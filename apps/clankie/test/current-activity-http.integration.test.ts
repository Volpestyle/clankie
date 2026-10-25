import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { OperatorPresenceResultSchema } from "@clankie/protocol/presence";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
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
    observeFleet: async () => ({ head: { status: working ? "working" : "idle" } }),
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
  const request = (current = true, bearer = "owner") =>
    fetch(`http://127.0.0.1:${address.port}/operator/v1/dispatch`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({
        op: "presence",
        schemaVersion: 1,
        includeActivities: true,
        ...(current ? { includeCurrentActivity: true } : {}),
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
    expect(coding.currentActivity?.text).toContain("pnpm check");
    expect(coding.currentActivity?.text).not.toContain("private-token");
    expect(coding.currentActivity?.text).not.toContain("abcdefghijklmnop");
    expect(await read()).toEqual(coding);
    const unchanged = OperatorPresenceResultSchema.parse(
      await (await request(false, "captain")).json(),
    ).snapshot;
    expect(unchanged).toEqual(legacy);
    expect((await request(true, "captain")).status).toBe(403);
    expect((await request(true, "missing")).status).toBe(403);

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
      text: "exec_command\nFresh session command",
    });
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
