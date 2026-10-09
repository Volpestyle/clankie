import { ClankieSettingsSchema } from "@clankie/settings";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { QuestionDraftSchema } from "../src/captain/conversation-questions.ts";
import { DeviceSessionSigner, mintDeviceSessionClaims } from "../src/device-session.ts";
import { HostedPairing } from "../src/hosted-pairing.ts";
import { HostedBodyClient } from "../src/hosted-body.ts";
import { hostedFixture } from "./fixtures/hosted-body.ts";
import {
  createCaptainOperatorConversationClient,
  createCaptainRouteClient,
} from "../../tui/src/session/operator-conversations.ts";
import {
  TAKE_CONTROL_GRANTS,
  SUPERVISE_GRANTS,
  OperatorConversationServiceRequestSchema,
  type OperatorConversationServiceRequest,
} from "@clankie/protocol";
const roots: string[] = [],
  services: Awaited<ReturnType<typeof createClankieApp>>[] = [];
afterEach(() => {
  services.splice(0).forEach((s) => s.close());
  roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true }));
});
async function fixture(hosted = false) {
  const root = mkdtempSync(join(tmpdir(), "question-auth-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  let now = 1_790_000_000_000,
    operatorValid = true;
  const key = Buffer.alloc(32, 4),
    signer = new DeviceSessionSigner(key);
  const events = ["control", "read", "hosted", "other"].flatMap((deviceId) => {
    const grants = deviceId === "read" ? SUPERVISE_GRANTS : TAKE_CONTROL_GRANTS;
    const base = {
      occurredAt: new Date(now).toISOString(),
      missionId: `device:${deviceId}`,
      correlationId: "fixture",
      profileHash: "fixture",
    };
    return [
      {
        ...base,
        id: randomUUID(),
        type: "device.pairing.redeemed",
        data: {
          schemaVersion: 1,
          deviceId,
          offerId: deviceId,
          name: deviceId,
          platform: "ios",
          offeredGrants: grants,
          mintedBy: deviceId === "hosted" ? "hosted-account-operator" : "local-operator",
          pendingExpiresAt: new Date(now + 600_000).toISOString(),
        },
      },
      {
        ...base,
        id: randomUUID(),
        type: "device.activated",
        data: { schemaVersion: 1, deviceId, grants, sessionExpiresAt: new Date(now + 60_000).toISOString() },
      },
    ];
  });
  const log = join(root, "events.jsonl");
  writeFileSync(log, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const tokens = Object.fromEntries(
    ["control", "read", "hosted", "other"].map((deviceId) => [
      deviceId,
      signer.issue(mintDeviceSessionClaims({ deviceId, nowEpochSeconds: now / 1000, ttlSeconds: 60 })),
    ]),
  );
  const continuation = vi.fn();
  const store = new ConversationStore(
    join(root, "conversations"),
    async (id, _message, _publish, context) => {
      if (context.inputAnswer) {
        continuation(context);
        return;
      }
      if (context.ownerAuthority)
        await store.requestQuestion(
          id,
          QuestionDraftSchema.parse({
            kind: "choice",
            prompt: "Size?",
            options: [{ label: "Small" }, { label: "Large" }],
          }),
          context,
        );
    },
  );
  const made = await store.serve({
    op: "create",
    schemaVersion: 1,
    scope: { kind: "workspace", workspaceId: workspace },
    title: "Fixture",
  });
  if (made.op !== "create") throw new Error("unexpected");
  const id = made.conversation.conversationId;
  const f = hostedFixture();
  const writeSettings = vi.fn(async () => {
    throw new Error("Preference flow must not change settings");
  });
  const service = await createClankieApp({
    settings: { load: async () => ClankieSettingsSchema.parse({ schemaVersion: 1 }), update: writeSettings },
    captain: createStubCaptain({
      serveOperatorConversation: (request, authority) =>
        store.serve(request as Parameters<typeof store.serve>[0], authority),
      invalidateQuestionPrincipal: (deviceId) => store.invalidateQuestionPrincipal(deviceId),
    }),
    eventLogPath: log,
    deviceSessionKey: key,
    clock: () => new Date(now),
    authenticateCaptain: async (r) =>
      r.headers.get("authorization") === "Bearer captain"
        ? { captainId: "captain", steerSourceLane: "api" }
        : undefined,
    authenticateOperator: async (r) =>
      operatorValid && r.headers.get("authorization") === "Bearer owner"
        ? { operatorId: "operator" }
        : undefined,
    ...(hosted
      ? {
          hostedPairing: new HostedPairing(
            new HostedBodyClient(f.bootstrap, { clock: () => now }),
            generateKeyPairSync("ed25519").privateKey,
            { clock: () => now },
          ),
        }
      : {}),
  });
  services.push(service);
  const post = (request: OperatorConversationServiceRequest, token: string) =>
    service.app.request("/operator/v1/dispatch", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  const bridge = (request: OperatorConversationServiceRequest, token: string) =>
    service.app.request("/v1/hosted/operator", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ method: "POST", path: "/operator/v1/dispatch", body: JSON.stringify(request) }),
    });
  const fetchImpl: typeof fetch = async (input, init) => service.app.fetch(new Request(input, init));
  const client = (token: string) =>
    createCaptainOperatorConversationClient(
      createCaptainRouteClient({ host: "http://fixture", captainToken: token, fetchImpl }),
    );
  const send = async (token = "owner") => {
    const result = await client(token).send({
      schemaVersion: 1,
      kind: "message",
      conversationId: id,
      surfaceClientId: "test",
      expectedRevision: store.conversation(id)!.revision,
      message: "ask",
    });
    if (result.status !== "accepted") throw new Error("not accepted");
    await store.awaitRun(result.runId);
    return result;
  };
  return {
    id,
    store,
    client,
    send,
    post,
    bridge,
    tokens,
    continuation,
    writeSettings,
    expire: () => {
      now += 61_000;
    },
    rotate: () => {
      operatorValid = false;
    },
    service,
  };
}
it("actual operator send -> shared client pending -> another Take Control device answer -> one continuation", async () => {
  const f = await fixture();
  await f.send();
  const device = f.client(f.tokens.control!);
  const pending = await device.inputGet!(f.id),
    q = pending.question!;
  const target = {
    conversationId: f.id,
    requestId: q.requestId,
    incarnationId: q.incarnationId,
    expectedRevision: pending.revision!,
  };
  const invalid = await device.inputAnswer!({
    ...target,
    answer: { kind: "choice", optionId: randomUUID() },
  });
  expect(invalid.reason).toBe("invalid_answer"); // label isn't identity; exact generated option required
  const answer = await device.inputAnswer!({
    ...target,
    answer: { kind: "choice", optionId: q.options[0]!.optionId },
  });
  expect(answer.question?.resolvedBy).toEqual({ kind: "device", id: "control" });
  await f.store.awaitRun(answer.question!.continuation!.runId);
  expect(f.continuation).toHaveBeenCalledTimes(1);
  expect(f.continuation.mock.calls[0]![0].ownerAuthority.principal).toEqual({
    kind: "device",
    id: "control",
  });
  const duplicate = await f.client("owner").inputAnswer!({
    ...target,
    answer: { kind: "choice", optionId: q.options[0]!.optionId },
  });
  expect(duplicate.question!.continuation!.runId).toBe(answer.question!.continuation!.runId);
  expect(f.continuation).toHaveBeenCalledTimes(1);
  expect(f.writeSettings).not.toHaveBeenCalled();
  await f.store.close();
});
it("Take Control device initiated question can be answered by TUI operator", async () => {
  const f = await fixture();
  await f.send(f.tokens.control!);
  const client = f.client("owner"),
    snapshot = await client.inputGet!(f.id),
    q = snapshot.question!;
  const answer = await client.inputAnswer!({
    conversationId: f.id,
    requestId: q.requestId,
    incarnationId: q.incarnationId,
    expectedRevision: snapshot.revision!,
    answer: { kind: "choice", optionId: q.options[1]!.optionId },
  });
  await f.store.awaitRun(answer.question!.continuation!.runId);
  expect(f.continuation).toHaveBeenCalledTimes(1);
  expect(f.writeSettings).not.toHaveBeenCalled();
  await f.store.close();
});
it("owner mailbox lists the same question target through the shared HTTP client and refuses captain/read devices", async () => {
  const f = await fixture();
  await f.send();
  const pending = await f.client("owner").inputGet!(f.id);
  const mailbox = await f.client(f.tokens.control!).inputList!({ status: "pending" });
  expect(mailbox.questions).toEqual([pending]);
  const request = { op: "input_list", schemaVersion: 1, status: "pending" } as const;
  expect((await f.post(request, "captain")).status).toBe(403);
  expect((await f.post(request, f.tokens.read!)).status).toBeGreaterThanOrEqual(400);
  await f.store.close();
});
it.each(["read", "captain", "expired", "revoked", "rotated"])(
  "refuses %s credentials without an answer or continuation",
  async (kind) => {
    const f = await fixture();
    await f.send();
    const snapshot = await f.client("owner").inputGet!(f.id),
      q = snapshot.question!;
    const request = OperatorConversationServiceRequestSchema.parse({
      op: "input_answer",
      schemaVersion: 1,
      conversationId: f.id,
      requestId: q.requestId,
      incarnationId: q.incarnationId,
      expectedRevision: snapshot.revision!,
      answer: { kind: "choice", optionId: q.options[0]!.optionId },
    });
    if (kind === "expired") f.expire();
    if (kind === "revoked")
      await f.service.app.request("/v1/devices/control/revoke", {
        method: "POST",
        headers: { authorization: "Bearer owner" },
      });
    if (kind === "rotated") f.rotate();
    const token =
      kind === "read"
        ? f.tokens.read!
        : kind === "captain"
          ? "captain"
          : kind === "rotated"
            ? "owner"
            : f.tokens.control!;
    expect((await f.post(request, token)).status).toBeGreaterThanOrEqual(400);
    expect(f.continuation).not.toHaveBeenCalled();
    expect(f.writeSettings).not.toHaveBeenCalled();
    await f.store.close();
  },
);
it("hosted bridge requires its minted operator device and reauthenticates ORIGINAL token on use", async () => {
  const f = await fixture(true);
  await f.send();
  const request = { op: "input_get", schemaVersion: 1, conversationId: f.id } as const;
  expect((await f.bridge(request, f.tokens.other!)).status).toBe(403);
  expect((await f.bridge(request, f.tokens.hosted!)).status).toBe(200);
  f.expire();
  expect((await f.bridge(request, f.tokens.hosted!)).status).toBeGreaterThanOrEqual(400);
  expect(f.continuation).not.toHaveBeenCalled();
  expect(f.writeSettings).not.toHaveBeenCalled();
  await f.store.close();
});
it("captain-only ordinary sends retain no question authority", async () => {
  const f = await fixture();
  await f.send("captain");
  expect((await f.client("owner").inputGet!(f.id)).question).toBeUndefined();
  expect(f.writeSettings).not.toHaveBeenCalled();
  await f.store.close();
});

it("owner update HTTP and hosted routes require current owner authority without waking a continuation", async () => {
  const f = await fixture(true);
  try {
    const update = await f.store.mailOwnerUpdate(
      f.id,
      {
        title: "Mailbox landed",
        body: "Informational, with nothing waiting on it.",
        issue: { tracker: "linear", key: "VUH-1809", url: "https://linear.app/vuhlp/issue/VUH-1809" },
      },
      "http-update",
      { current: () => true },
    );
    const requests = [
      { op: "owner_update_list", schemaVersion: 1, conversationId: f.id },
      { op: "owner_update_read", schemaVersion: 1, id: update.id },
      { op: "owner_update_dismiss", schemaVersion: 1, id: update.id },
    ].map((request) => OperatorConversationServiceRequestSchema.parse(request));
    for (const request of requests) {
      expect((await f.post(request, "captain")).status).toBe(403);
      expect((await f.post(request, f.tokens.read!)).status).toBeGreaterThanOrEqual(400);
      expect((await f.bridge(request, f.tokens.other!)).status).toBe(403);
    }
    for (const request of requests) {
      const operator = await f.post(request, "owner");
      expect(operator.status).toBe(200);
      const body = await operator.json();
      if (request.op === "owner_update_list") {
        expect(body).toMatchObject({
          result: { updates: [{ id: update.id, state: "unread", issue: { key: "VUH-1809" } }] },
        });
      } else {
        expect(body).toMatchObject({
          result: {
            update: { id: update.id, state: request.op === "owner_update_read" ? "read" : "dismissed" },
          },
        });
      }
      expect((await f.post(request, f.tokens.control!)).status).toBe(200);
      expect((await f.bridge(request, f.tokens.hosted!)).status).toBe(200);
    }
    await f.service.app.request("/v1/devices/control/revoke", {
      method: "POST",
      headers: { authorization: "Bearer owner" },
    });
    for (const request of requests)
      expect((await f.post(request, f.tokens.control!)).status).toBeGreaterThanOrEqual(400);
    f.expire();
    for (const request of requests)
      expect((await f.bridge(request, f.tokens.hosted!)).status).toBeGreaterThanOrEqual(400);
    expect(f.continuation).not.toHaveBeenCalled();
    expect(f.writeSettings).not.toHaveBeenCalled();
  } finally {
    await f.store.close();
  }
});

it("authenticated device cancellation exposes its identity and reason through HTTP", async () => {
  const f = await fixture();
  await f.send();
  const client = f.client(f.tokens.control!);
  const pending = await client.inputGet!(f.id);
  const q = pending.question!;
  const cancelled = await client.inputCancel!({
    conversationId: f.id,
    requestId: q.requestId,
    incarnationId: q.incarnationId,
    expectedRevision: pending.revision!,
  });
  expect(cancelled.question).toMatchObject({
    status: "cancelled",
    reason: "owner_cancelled",
    resolvedBy: { kind: "device", id: "control" },
    resolvedAt: expect.any(String),
  });
  expect(cancelled.question?.answer).toBeUndefined();
  expect((await f.client("owner").inputGet!(f.id, q.requestId)).question).toEqual(cancelled.question);
  expect(f.continuation).not.toHaveBeenCalled();
  await f.store.close();
});
