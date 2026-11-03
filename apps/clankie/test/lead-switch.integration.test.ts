import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import {
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  OperatorConversationServiceResultSchema,
  SUPERVISE_GRANTS,
  TAKE_CONTROL_GRANTS,
} from "@clankie/protocol";
import type { CaptainReadinessResponse } from "@clankie/protocol/captain-readiness";
import { FLEET_LEADS_PATH, FleetLeadsSnapshotSchema } from "@clankie/protocol/fleet-leads";
import { SettingsStore } from "@clankie/settings";
import { expect, it } from "vitest";
import type { SeatRef } from "@clankie/agent-hosts";
import { createClankieApp } from "../src/app.ts";
import { ClaudeHookQuestions } from "../src/captain/claude-hook-questions.ts";
import type { QuestionAuthority } from "../src/captain/conversation-questions.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import type { ConversationTurnContext } from "../src/captain/conversations/types.ts";
import { LeadStore } from "../src/captain/lead.ts";
import { escalateWorkerQuestion } from "../src/captain/worker-question-escalation.ts";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { DeviceSessionSigner, mintDeviceSessionClaims } from "../src/device-session.ts";
import {
  createCaptainConversationDispatch,
  createDeviceConversationDispatch,
} from "../../relay/src/conversation-upstream.ts";
import { ControlPlaneDeviceAuthorizer } from "../../relay/src/device-auth.ts";
import { createOperatorConversationRelayHandler } from "../../relay/src/operator-conversations.ts";

// Clankie's on/off switch (ADR 0350): a real captain and service behind the real
// relay. The owner's own Take Control phone switches him off and on; an app
// signed in to the connector, a Supervise device and the captain bearer can't
// set it either way. Off is shown as off on the hearth, and turning him on
// replays nothing that was held.

const LEAD = "global-default";
const RELAY_BEARER = randomBytes(24).toString("hex");

it("lets the owner's own phone switch Clankie off and on through the relay, and nobody else", async () => {
  const root = await mkdtemp(join(tmpdir(), "lead-switch-"));
  let turns = 0;
  const captain = createCaptain(
    {
      herdrAvailable: () => false,
      onTurnSettled: () => turns++,
      runtimes: {
        list: async () => [],
        onChange: () => () => undefined,
        configuredBinding: async () => undefined,
      },
      browser: { catalog: async () => ({ schemaVersion: 1, available: false, tools: [] }) },
      mcp: { catalog: async () => [] },
      media: { finishedRenders: async () => [] },
      embodiment: {
        submitIntent: async () => {
          throw new Error("No body in this fixture");
        },
        getSession: async () => undefined,
        getLiveSession: async () => undefined,
      },
      memory: {
        appendEpisode: async () => ({ corrected: false, retained: false }),
        recallEpisodeCard: async () => "",
        searchEpisodeCard: async () => "",
      },
    } as unknown as CaptainDeps,
    {
      repoRoot: root,
      stateDir: root,
      workingDirectory: root,
      settings: new SettingsStore(join(root, "settings.json")),
    },
  );
  await captain.serveOperatorConversation({ op: "fleet", schemaVersion: 1 });

  // Three paired devices: the owner's phone, a Supervise-only watcher, and Claude
  // signed in to the connector, which holds Take Control grants too.
  const now = Date.now();
  const iso = (offset = 0) => new Date(now + offset).toISOString();
  const key = randomBytes(32);
  const signer = new DeviceSessionSigner(key);
  const devices = {
    phone: { grants: TAKE_CONTROL_GRANTS },
    watcher: { grants: SUPERVISE_GRANTS },
    claude: { grants: TAKE_CONTROL_GRANTS, scope: "connector" as const },
  };
  const events = Object.entries(devices).flatMap(([deviceId, device]) => {
    const event = (type: string, data: object) => ({
      id: randomUUID(),
      type,
      occurredAt: iso(-60_000),
      missionId: `device:${deviceId}`,
      correlationId: "lead-switch-proof",
      profileHash: "fixture",
      data: { schemaVersion: 1, deviceId, ...data },
    });
    return [
      event("device.pairing.redeemed", {
        offerId: deviceId,
        name: deviceId,
        platform: "ios",
        offeredGrants: device.grants,
        mintedBy: "local-operator",
        pendingExpiresAt: iso(60_000),
        ...("scope" in device ? { scope: device.scope } : {}),
      }),
      event("device.activated", { grants: device.grants, sessionExpiresAt: iso(60 * 60_000) }),
    ];
  });
  const eventLogPath = join(root, "devices.jsonl");
  await writeFile(eventLogPath, events.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const token = (deviceId: keyof typeof devices) =>
    signer.issue(
      mintDeviceSessionClaims({ deviceId, nowEpochSeconds: Math.floor(now / 1000), ttlSeconds: 3600 }),
    );

  let readiness: CaptainReadinessResponse = { ready: true, model: "openai/gpt-test", providerId: "openai" };
  const service = await createClankieApp({
    captain,
    deviceSessionKey: key,
    eventLogPath,
    modelKeys: { readiness: async () => readiness } as never,
    authenticateCaptain: async (request) =>
      request.headers.get("authorization") === `Bearer ${RELAY_BEARER}`
        ? { captainId: "relay", steerSourceLane: "api" }
        : undefined,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
  });
  const server = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const handler = createOperatorConversationRelayHandler({
    authorizeDevice: new ControlPlaneDeviceAuthorizer({ baseUrl }),
    dispatch: createCaptainConversationDispatch({ baseUrl, bearerToken: RELAY_BEARER }),
    deviceDispatch: createDeviceConversationDispatch({ baseUrl }),
  });
  const relay = createServer((request, response) => {
    void (async () => {
      if (await handler(request, response)) return;
      response.statusCode = 404;
      response.end();
    })();
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  const relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;

  const viaRelay = (deviceId: keyof typeof devices, command: unknown) =>
    fetch(new URL(OPERATOR_CONVERSATION_DISPATCH_PATH, relayUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${token(deviceId)}`, "content-type": "application/json" },
      body: JSON.stringify({ op: "lead", schemaVersion: 1, command }),
    });
  const leadStatus = async (response: Response) => {
    expect(response.status).toBe(200);
    const parsed = OperatorConversationServiceResultSchema.parse(await response.json());
    if (parsed.op !== "lead") throw new Error(`Unexpected op ${parsed.op}`);
    return parsed.result.status;
  };
  const hearth = async () => {
    const response = await fetch(new URL(FLEET_LEADS_PATH, baseUrl), {
      headers: { authorization: `Bearer ${token("phone")}` },
    });
    expect(response.status).toBe(200);
    return FleetLeadsSnapshotSchema.parse(await response.json()).leads.find((lead) => lead.id === "clankie")!;
  };

  try {
    // He starts on, and the phone reads the switch on its observe grant.
    expect(await leadStatus(await viaRelay("phone", { action: "status" }))).toMatchObject({
      lead: "clankie",
      clankie: { state: "on" },
    });
    expect((await hearth()).active).toBe(true);

    // The connector app and the Supervise watcher can't switch him, either way.
    for (const lead of ["apps", "clankie"]) {
      for (const deviceId of ["claude", "watcher"] as const)
        expect((await viaRelay(deviceId, { action: "set", lead })).status).toBe(403);
      // Nor can the captain bearer the relay itself dispatches on.
      const bearer = await fetch(new URL(OPERATOR_CONVERSATION_DISPATCH_PATH, baseUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${RELAY_BEARER}`, "content-type": "application/json" },
        body: JSON.stringify({ op: "lead", schemaVersion: 1, command: { action: "set", lead } }),
      });
      expect(bearer.status).toBe(403);
      // Nor the connector app's own device bearer straight at the service, which
      // never authenticates a connector outside the relay's allowlist (ADR 0301).
      const direct = await fetch(new URL(OPERATOR_CONVERSATION_DISPATCH_PATH, baseUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${token("claude")}`, "content-type": "application/json" },
        body: JSON.stringify({ op: "lead", schemaVersion: 1, command: { action: "set", lead } }),
      });
      expect(direct.status).toBe(401);
    }
    expect(JSON.parse(await readFile(join(root, "lead.json"), "utf8").catch(() => "{}"))).not.toMatchObject({
      lead: "apps",
    });

    // The owner's phone switches him off; his own turns are held, not run.
    expect(await leadStatus(await viaRelay("phone", { action: "set", lead: "apps" }))).toMatchObject({
      lead: "apps",
      clankie: { state: "off" },
    });
    expect(JSON.parse(await readFile(join(root, "lead.json"), "utf8"))).toMatchObject({ lead: "apps" });
    expect((await hearth()).active).toBe(false);
    expect(
      await captain.wakeConversation(
        { conversationId: LEAD },
        "Timer: check the release.",
        undefined,
        "machine",
        false,
      ),
    ).toBe(true);
    await expect
      .poll(async () => (await leadStatus(await viaRelay("phone", { action: "status" }))).held)
      .toBe(1);
    expect(turns).toBe(0);

    // While off, a model that can't run says so before he is turned on.
    readiness = { ready: false, reason: "no_credential", model: "openai/gpt-test", providerId: "openai" };
    expect(await leadStatus(await viaRelay("phone", { action: "status" }))).toMatchObject({
      lead: "apps",
      clankie: { state: "off", reason: "no_credential", message: expect.stringContaining("openai/gpt-test") },
    });

    // The phone switches him back on: the switch reads "can't start" while his model can't run.
    expect(await leadStatus(await viaRelay("phone", { action: "set", lead: "clankie" }))).toMatchObject({
      lead: "clankie",
      clankie: { state: "cant_start", reason: "no_credential" },
    });
    expect(JSON.parse(await readFile(join(root, "lead.json"), "utf8"))).toMatchObject({ lead: "clankie" });
    expect((await hearth()).active).toBe(true);
    readiness = { ready: true, model: "openai/gpt-test", providerId: "openai" };
    expect(await leadStatus(await viaRelay("phone", { action: "status" }))).toMatchObject({
      lead: "clankie",
      held: 1,
      clankie: { state: "on" },
    });
    // Turning him on flips the setting only: what was held is not replayed.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(turns).toBe(0);
  } finally {
    relay.closeAllConnections();
    relay.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      if ("closeAllConnections" in server) server.closeAllConnections();
    });
    service.close();
    await captain.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}, 60_000);

// The leak this ADR closes: a native worker question resolved elsewhere queues a
// notice with the owner's authority that is not the owner's words. While off,
// the switch holds it; the owner's own message still runs.
it("holds a resolved-elsewhere worker notice while off, and lets the owner's own message through", async () => {
  const root = await mkdtemp(join(tmpdir(), "lead-switch-notice-"));
  const owner: QuestionAuthority = {
    principal: { kind: "operator", id: "owner" },
    current: () => true,
    authorize: async () => true,
  };
  const lead = new LeadStore(join(root, "lead.json"), join(root, "lead-held.json"));
  lead.set("apps");
  const turns: Array<{ message: string; context: ConversationTurnContext }> = [];
  const store = new ConversationStore(join(root, "store"), async (_id, message, _publish, context) => {
    turns.push({ message, context });
  });
  const registry = new ClaudeHookQuestions(join(root, "claims.json"), 10_000);
  const ref: SeatRef = { harness: "claude", paneId: "w1:p1", sessionId: "worker" };
  store.prepareWorkerQuestion = async (seatId, requestId) => {
    const question = registry.pending(ref, requestId)!;
    return {
      seatId,
      sessionId: ref.sessionId,
      requestId,
      questions: question.questions.map(({ options, ...q }) => ({
        ...q,
        ...(options ? { options: [...options] } : {}),
      })),
    };
  };
  store.reconcileWorkerQuestion = async () => (registry.pending(ref, "worker") ? "pending" : "resolved");
  let output: Promise<unknown> | undefined;
  try {
    let notify!: () => void;
    const announced = new Promise<void>((resolve) => {
      notify = resolve;
    });
    output = registry.open(
      ref,
      {
        schemaVersion: 1,
        event: "PreToolUse",
        sessionId: ref.sessionId,
        toolName: "AskUserQuestion",
        toolUseId: "worker",
        toolInput: {
          questions: [
            {
              question: "Choose",
              header: "Route",
              options: [
                { label: "A", description: "A" },
                { label: "B", description: "B" },
              ],
            },
          ],
        },
      },
      async (question) => {
        await escalateWorkerQuestion(store, LEAD, "w1:p1", question, owner);
        notify();
      },
    );
    await announced;
    // The worker's pane answers its own question; reading the asks reconciles it.
    registry.cancel(ref);
    await store.serve({ op: "input_list", schemaVersion: 1 }, owner);
    await expect.poll(() => turns.some((turn) => turn.message.includes("resolved elsewhere"))).toBe(true);
    const notice = turns.find((turn) => turn.message.includes("resolved elsewhere"))!;
    const scope = store.conversation(LEAD)?.scope;
    expect(notice.context).toMatchObject({ internal: true, origin: "input" });
    expect(lead.holdsTurn(scope, notice.context)).toBe(true);

    // The owner's own message is published input, never held.
    const meta = await store.serve({ op: "get", schemaVersion: 1, conversationId: LEAD }, owner);
    if (meta.op !== "get" || meta.conversation === undefined) throw new Error("No conversation");
    const sent = await store.serve(
      {
        op: "send",
        schemaVersion: 1,
        turn: {
          schemaVersion: 1,
          kind: "message",
          conversationId: LEAD,
          expectedRevision: meta.conversation.revision,
          message: "Are you there?",
          surfaceClientId: "phone",
        },
      },
      owner,
    );
    if (sent.op !== "send" || sent.result.status !== "accepted") throw new Error("Owner message refused");
    await store.awaitRun(sent.result.runId);
    const mine = turns.find((turn) => turn.message === "Are you there?")!;
    expect(lead.holdsTurn(scope, mine.context)).toBe(false);
    // Switched on, nothing of his own is held.
    lead.set("clankie");
    expect(lead.holdsTurn(scope, notice.context)).toBe(false);
  } finally {
    registry.cancel(ref);
    await output;
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
