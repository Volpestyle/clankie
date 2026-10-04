import { SettingsStore } from "@clankie/settings";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { projectOnboarding } from "../src/captain/project-onboarding.ts";
import { ProjectProposalDraftSchema } from "@clankie/protocol/projects";
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
        data: { schemaVersion: 1, deviceId, grants, sessionExpiresAt: new Date(now + 600_000).toISOString() },
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
        await store.proposeProjectCreate(
          id,
          ProjectProposalDraftSchema.parse({ projectId: "first", name: "First", prompt: "Review" }),
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
  const settings = new SettingsStore(join(root, "settings.json"));
  const writeSettings = vi.fn(settings.update.bind(settings));
  store.projectOnboarding = projectOnboarding({ load: () => settings.load(), update: writeSettings });
  const hooks: { authorize?: () => Promise<void> } = {};
  const service = await createClankieApp({
    settings: { load: () => settings.load(), update: writeSettings },
    captain: createStubCaptain({
      serveOperatorConversation: (request, authority) =>
        store.serve(
          request as Parameters<typeof store.serve>[0],
          authority
            ? {
                ...authority,
                authorize: async () => {
                  await hooks.authorize?.();
                  return authority.authorize();
                },
              }
            : undefined,
        ),
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
    hooks,
    refresh: () =>
      signer.issue(
        mintDeviceSessionClaims({ deviceId: "control", nowEpochSeconds: now / 1000, ttlSeconds: 60 }),
      ),
    revoke: async () =>
      service.app.request("/v1/devices/control/revoke", {
        method: "POST",
        headers: { authorization: "Bearer owner" },
      }),
  };
}
async function proposal(f: Awaited<ReturnType<typeof fixture>>, token: string) {
  const client = f.client(token);
  const q = (await client.inputGet!(f.id)).question!;
  return (
    await client.projectProposalGet!({
      conversationId: f.id,
      incarnationId: q.incarnationId,
      requestId: q.requestId,
    })
  ).proposal!;
}
it.each([false, true])(
  "actual signed Take Control confirms with hosted=%s; fresh receipt needs no live issuer",
  async (hosted) => {
    const f = await fixture(hosted);
    await f.send(f.tokens.control!);
    const p = await proposal(f, f.tokens.control!);
    const result = await f.client(f.tokens.control!).projectProposalConfirm!(p.target);
    expect(result.status).toBe("created");
    expect(f.writeSettings).toHaveBeenCalledTimes(1);
    f.expire();
    const token = f.refresh();
    expect(await f.client(token).projectProposalConfirm!(p.target)).toEqual(result);
    expect(f.writeSettings).toHaveBeenCalledTimes(1);
    await f.store.close();
  },
);
it("chat-only, captain, wrong signer and different original owner cannot create", async () => {
  const f = await fixture();
  await f.send(f.tokens.control!);
  const p = await proposal(f, f.tokens.control!);
  const wrong = new DeviceSessionSigner(Buffer.alloc(32, 9)).issue(
    mintDeviceSessionClaims({ deviceId: "control", nowEpochSeconds: 1_790_000_000, ttlSeconds: 60 }),
  );
  for (const token of [f.tokens.read!, "captain", wrong, f.tokens.other!, "owner"]) {
    const r = await f.post({ op: "project_proposal_confirm", schemaVersion: 1, ...p.target }, token);
    expect([401, 403]).toContain(r.status);
  }
  expect(f.writeSettings).not.toHaveBeenCalled();
  await f.store.close();
});
it("revoking the original device while a commit awaits prevents project creation", async () => {
  const f = await fixture();
  await f.send(f.tokens.control!);
  const p = await proposal(f, f.tokens.control!);
  const apply = f.store.projectOnboarding!.apply;
  f.store.projectOnboarding!.apply = async (a, g) => {
    expect((await f.revoke()).status).toBe(200);
    return apply(a, g);
  };
  const r = await f.client(f.tokens.control!).projectProposalConfirm!(p.target);
  expect(r.status).toBe("uncertain");
  expect(f.writeSettings).not.toHaveBeenCalled();
  await f.store.close();
});
it("fresh same principal cannot refresh the pending proposal's original JWT", async () => {
  const f = await fixture();
  await f.send(f.tokens.control!);
  const p = await proposal(f, f.tokens.control!);
  f.expire();
  const result = await f.client(f.refresh()).projectProposalConfirm!(p.target);
  expect(result.status).toBe("refused");
  expect(f.writeSettings).not.toHaveBeenCalled();
  await f.store.close();
});
it("revocation during a pending read's final authority check prevents publication", async () => {
  const f = await fixture();
  await f.send(f.tokens.control!);
  const p = await proposal(f, f.tokens.control!);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => {
      enter = r;
    }),
    held = new Promise<void>((r) => {
      release = r;
    });
  f.hooks.authorize = async () => {
    enter();
    await held;
  };
  const reading = f.post(
    {
      op: "project_proposal_get",
      schemaVersion: 1,
      conversationId: f.id,
      requestId: p.target.requestId,
      incarnationId: p.target.incarnationId,
    },
    f.tokens.control!,
  );
  await entered;
  await f.revoke();
  release();
  expect([401, 403]).toContain((await reading).status);
  expect(f.writeSettings).not.toHaveBeenCalled();
  await f.store.close();
});
