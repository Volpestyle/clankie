import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ClankieSettingsSchema } from "@clankie/settings";
import {
  OperatorConversationServiceResultSchema,
  ProjectsSettingsSchema,
  SUPERVISE_GRANTS,
  TAKE_CONTROL_GRANTS,
  parseProtocolResponse,
  type FeedPage,
  type OperatorConversationServiceRequest,
} from "@clankie/protocol";
import { createClankieApp } from "../src/app.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { QuestionDraftSchema } from "../src/captain/conversation-questions.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { DeviceSessionSigner, mintDeviceSessionClaims } from "../src/device-session.ts";
import { createWorkItemsService } from "../src/work-items.ts";
import { runFeedCommand } from "../../tui/src/command/feed.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const OWNER = `clankie_op_${"f".repeat(43)}`;
const admission = { current: () => true };
const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

/**
 * The real service app over the real conversation store (asks and owner mail) and
 * the real work-items service (a project's tracker and its status update), with
 * paired devices signed the way the relay forwards them.
 */
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "owner-feed-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const garden = join(root, "garden");
  mkdirSync(garden);
  const settings = ClankieSettingsSchema.parse({
    schemaVersion: 1,
    projects: ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "garden",
          name: "Garden",
          workspaces: [{ id: "garden", machineId: "local", path: garden, platform: "posix" }],
        },
      ],
    }),
  });

  // A project tracker with one status update, older than everything else here.
  const workItems = createWorkItemsService({
    stateDirectory: join(root, "work-state"),
    workspace: () => join(root, "work-state"),
    run: async () => {
      throw new Error("no git here");
    },
    clock: () => new Date("2026-01-02T03:04:05.000Z"),
  });
  await workItems.handle(
    { action: "init", repo: garden, backend: "linear", linearTeam: "VUH", linearProject: "Garden" },
    true,
  );
  await workItems.callTracker(
    "save_project",
    { id: "Garden", summary: "Grow it" },
    { repo: garden, local: true },
  );
  await workItems.callTracker(
    "save_status_update",
    {
      type: "project",
      project: "Garden",
      health: "onTrack",
      body: "**Shipped:** the gate.\n\n![The gate open](https://example.com/gate.png)\n\nTry ![bad](javascript:alert(1))",
    },
    { repo: garden, local: true },
  );

  const store = new ConversationStore(join(root, "conversations"), async () => {});
  cleanups.push(() => store.close());
  const made = await store.serve({
    op: "create",
    schemaVersion: 1,
    scope: { kind: "workspace", workspaceId: garden },
    title: "Garden lead",
  });
  if (made.op !== "create") throw new Error("unexpected create result");
  const lead = made.conversation.conversationId;

  const now = Date.now();
  const key = Buffer.alloc(32, 7);
  const signer = new DeviceSessionSigner(key);
  const devices = { control: TAKE_CONTROL_GRANTS, read: SUPERVISE_GRANTS } as const;
  const events = Object.entries(devices).flatMap(([deviceId, grants]) => {
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
          mintedBy: "local-owner",
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
  const eventLogPath = join(root, "events.jsonl");
  writeFileSync(eventLogPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  const tokens = Object.fromEntries(
    Object.keys(devices).map((deviceId) => [
      deviceId,
      signer.issue(
        mintDeviceSessionClaims({ deviceId, nowEpochSeconds: Math.floor(now / 1000), ttlSeconds: 600 }),
      ),
    ]),
  ) as Record<keyof typeof devices, string>;

  const service = await createClankieApp({
    settings: { load: async () => settings },
    captain: createStubCaptain({
      serveOperatorConversation: (request, authority) =>
        store.serve(request as Parameters<typeof store.serve>[0], authority),
      invalidateQuestionPrincipal: (deviceId) => store.invalidateQuestionPrincipal(deviceId),
    }),
    workItems,
    eventLogPath,
    deviceSessionKey: key,
    clock: () => new Date(),
    authenticateCaptain: async (request) =>
      request.headers.get("authorization") === "Bearer captain"
        ? { captainId: "captain", steerSourceLane: "api" }
        : undefined,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === `Bearer ${OWNER}` ? { operatorId: "owner" } : undefined,
  });
  cleanups.push(() => service.close());
  const post = (request: OperatorConversationServiceRequest, token = OWNER) =>
    service.app.request("/operator/v1/dispatch", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  const feed = async (request: Record<string, unknown> = {}, token = OWNER): Promise<FeedPage> => {
    const response = await post({ op: "feed_list", schemaVersion: 1, ...request }, token);
    expect(response.status).toBe(200);
    const result = parseProtocolResponse(OperatorConversationServiceResultSchema, await response.json());
    if (result.op !== "feed_list") throw new Error("unexpected feed result");
    return result.result as FeedPage;
  };
  return { garden, lead, store, service, post, feed, tokens };
}

it("joins asks, owner mail and project updates into one owner feed, pages it and drops answered checks", async () => {
  const f = await fixture();
  const ask = (prompt: string) =>
    f.store.requestSurfaceQuestion(
      f.lead,
      QuestionDraftSchema.parse({
        purpose: "decision",
        kind: "choice",
        prompt,
        options: [{ label: "Yes" }, { label: "No" }],
        recommendation: "Yes",
        waitingOn: "The garden gate",
      }),
      admission,
    );
  const first = await ask("Does the gate open in ten seconds?");
  await pause();
  const mailed = await f.store.mailOwnerUpdate(
    f.lead,
    {
      title: "Gate landed",
      body: "The gate opens from the app.",
      media: [{ url: "https://example.com/gate.mp4", mimeType: "video/mp4", alt: "Gate opening" }],
    },
    "gate-mail",
    admission,
  );
  await pause();
  const elsewhere = await f.store.mailOwnerUpdate(
    "global-default",
    { title: "Unrelated", body: "Not the garden." },
    "elsewhere-mail",
    admission,
  );
  await pause();
  const second = await ask("Is the new path wide enough?");

  const all = await f.feed();
  if (all.outcome !== "ready") throw new Error(all.message);
  expect(all.unreadable).toBeUndefined();
  expect(all.nextCursor).toBeUndefined();
  expect(all.items.map((item) => item.id)).toEqual([
    `check:${second.question!.requestId}`,
    `owner-update:${elsewhere.id}`,
    `owner-update:${mailed.id}`,
    `check:${first.question!.requestId}`,
    expect.stringMatching(/^project-update:/u),
  ]);
  expect(all.items[0]).toMatchObject({
    kind: "check",
    projectId: "garden",
    check: {
      revision: second.revision,
      question: { prompt: "Is the new path wide enough?", status: "pending", waitingOn: "The garden gate" },
    },
  });
  expect(all.items[1]).not.toHaveProperty("projectId");
  expect(all.items[2]).toMatchObject({
    kind: "update",
    projectId: "garden",
    update: {
      title: "Gate landed",
      media: [{ url: "https://example.com/gate.mp4", mimeType: "video/mp4" }],
      ownerUpdate: { id: mailed.id, conversationId: f.lead, state: "unread" },
    },
  });
  // Model-written project text is shown only; a link the feed can't navigate is left out.
  expect(all.items[4]).toMatchObject({
    kind: "update",
    projectId: "garden",
    at: expect.stringMatching(/^2026-01-02T03:04:05\.\d{3}Z$/u),
    update: {
      body: expect.stringContaining("**Shipped:** the gate."),
      media: [{ url: "https://example.com/gate.png", alt: "The gate open" }],
      projectUpdate: { repoId: expect.any(String), health: "onTrack" },
    },
  });

  // The project filter keeps the garden's items; paging walks them without repeats.
  const one = await f.feed({ projectId: "garden", limit: 2 });
  if (one.outcome !== "ready" || !one.nextCursor) throw new Error("expected a first page");
  const two = await f.feed({ projectId: "garden", limit: 2, cursor: one.nextCursor });
  if (two.outcome !== "ready") throw new Error("expected a second page");
  expect(two.nextCursor).toBeUndefined();
  expect([...one.items, ...two.items].map((item) => item.id)).toEqual(
    all.items.filter((item) => item.projectId === "garden").map((item) => item.id),
  );
  expect((await f.post({ op: "feed_list", schemaVersion: 1, cursor: "bm90LWEtY3Vyc29y" })).status).toBe(400);

  // A check is answered with the existing op, against the target the feed carried.
  const check = all.items[0]!;
  if (check.kind !== "check") throw new Error("expected a check");
  const answered = OperatorConversationServiceResultSchema.parse(
    await (
      await f.post({
        op: "input_answer",
        schemaVersion: 1,
        conversationId: check.check.question.conversationId,
        requestId: check.check.question.requestId,
        incarnationId: check.check.question.incarnationId,
        expectedRevision: check.check.revision,
        answer: { kind: "choice", optionId: check.check.question.options[0]!.optionId },
      })
    ).json(),
  );
  expect(answered).toMatchObject({ op: "input_answer", result: { status: "resolved" } });
  // Dismissed mail leaves the feed too, through its own op.
  expect((await f.post({ op: "owner_update_dismiss", schemaVersion: 1, id: elsewhere.id })).status).toBe(200);
  const after = await f.feed();
  if (after.outcome !== "ready") throw new Error(after.message);
  expect(after.items.map((item) => item.id)).toEqual(all.items.slice(2).map((item) => item.id));

  // The CLI reads the same page with the owner credential.
  const output: string[] = [];
  const status = await runFeedCommand(["--project", "garden", "--json"], {
    host: "http://fixture",
    env: { CLANKIE_OPERATOR_TOKEN: OWNER },
    fetchImpl: async (input, init) => f.service.app.fetch(new Request(input, init)),
    stdout: { write: (chunk) => output.push(chunk) },
  });
  expect(status).toBe(0);
  expect(JSON.parse(output.join(""))).toEqual(after);
});

it("serves the feed with the mailbox's authority: the owner and Take Control devices, never a captain", async () => {
  const f = await fixture();
  await f.store.mailOwnerUpdate(f.lead, { title: "News", body: "Owner only." }, "news", admission);
  const control = await f.feed({}, f.tokens.control);
  expect(control).toMatchObject({ outcome: "ready", items: [{ kind: "update" }, { kind: "update" }] });
  const refused = { op: "feed_list" as const, schemaVersion: 1 as const };
  // A captain bearer, a Supervise device and nobody are refused exactly as the mailbox refuses them.
  for (const [token, status] of [
    ["captain", 403],
    [f.tokens.read, 401],
    ["nobody", 401],
  ] as const) {
    expect((await f.post(refused, token)).status).toBe(status);
    expect((await f.post({ op: "owner_update_list", schemaVersion: 1 }, token)).status).toBe(status);
  }
});
