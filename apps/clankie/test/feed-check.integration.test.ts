import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ClankieSettingsSchema } from "@clankie/settings";
import {
  OperatorConversationServiceResultSchema,
  ProjectsSettingsSchema,
  TAKE_CONTROL_GRANTS,
  parseProtocolResponse,
  type FeedCheckResult,
  type FeedPage,
  type OperatorConversationServiceRequest,
} from "@clankie/protocol";
import { createLocalTracker, TRACKER_LEAD, TRACKER_OWNER, type TrackerActor } from "@clankie/work-items";
import { createClankieApp } from "../src/app.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { QuestionDraftSchema } from "../src/captain/conversation-questions.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { DeviceSessionSigner, mintDeviceSessionClaims } from "../src/device-session.ts";
import { EvidenceStore } from "../src/evidence-store.ts";
import { formatFeedPage, runFeedCommand } from "../../tui/src/command/feed.ts";

/**
 * Step 5, C4: quick checks. The real service app over the real conversation store
 * (asks), the real built-in tracker (finished items the lead marked with an owner
 * check) and the real local evidence store (what the owner looks at); the CLI runs
 * over HTTP with the operator credential, and the owner's paired phone answers a
 * proof with its own device session. The captain is the one stand-in: its host
 * ask is the store's own surface ask, as the captain's `requestOwnerAsk` makes it.
 */
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const OWNER = `clankie_op_${"e".repeat(43)}`;
const admission = { current: () => true };
const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
/** A real 1x1 PNG and a few bytes of an MP4, so the evidence store records image and video types. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const LEAD: TrackerActor = { ...TRACKER_LEAD, onBehalfOf: [TRACKER_OWNER] };
const BUILDER: TrackerActor = { type: "agent-worker", id: "builder", onBehalfOf: [] };
const CHECKER: TrackerActor = { type: "agent-worker", id: "checker", onBehalfOf: [] };

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "feed-check-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const garden = join(root, "garden");
  mkdirSync(garden);

  const evidence = EvidenceStore.local(join(root, "evidence"));
  cleanups.push(() => evidence.close());
  const store_ = async (bytes: Buffer, contentType: string, fileName: string, issueKey?: string) => {
    const actor = { kind: "worker" as const, id: "feed-check-builder", onBehalfOf: [] };
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const receipt = await evidence.upload(actor, {
      idempotencyKey: `feed-check-${sha256}`,
      sha256,
      size: bytes.length,
      contentType,
      fileName,
      ...(issueKey === undefined ? {} : { issueKey }),
    });
    if (receipt.state === "pending")
      await evidence.acceptBlob(
        EvidenceStore.actorKey(actor),
        receipt.receiptId,
        (async function* () {
          yield bytes;
        })(),
      );
    const record = await evidence.recordForBlob(sha256);
    if (!record) throw new Error("Upload did not settle");
    const [listed] = await evidence.list({ issueKey: issueKey ?? "none" }).catch(() => []);
    return { sha256, link: `clankie://evidence/sha256/${sha256}`, recordId: listed?.id };
  };

  const tracker = createLocalTracker({
    directory: join(root, "tracker"),
    validateEvidence: async (_issueKey, references) => {
      for (const reference of references) {
        const record = await evidence.record(reference.recordId);
        if (!record || record.sha256 !== reference.sha256) throw new Error("Unknown evidence record");
      }
    },
  });
  const trackerProject = (await tracker.call(
    "save_project",
    { name: "Garden", addTeams: ["LOCAL"] },
    { actor: LEAD },
  )) as { id: string };

  const settings = ClankieSettingsSchema.parse({
    schemaVersion: 1,
    projects: ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "garden",
          name: "Garden",
          trackerProjectId: trackerProject.id,
          workspaces: [{ id: "garden", machineId: "local", path: garden, platform: "posix" }],
        },
      ],
    }),
  });

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

  // The owner's phone: a Take Control device paired on this machine.
  const now = Date.now();
  const key = Buffer.alloc(32, 9);
  const signer = new DeviceSessionSigner(key);
  const base = {
    occurredAt: new Date(now).toISOString(),
    missionId: "device:phone",
    correlationId: "fixture",
    profileHash: "fixture",
  };
  const eventLogPath = join(root, "events.jsonl");
  writeFileSync(
    eventLogPath,
    [
      {
        ...base,
        id: randomUUID(),
        type: "device.pairing.redeemed",
        data: {
          schemaVersion: 1,
          deviceId: "phone",
          offerId: "phone",
          name: "Owner phone",
          platform: "ios",
          offeredGrants: TAKE_CONTROL_GRANTS,
          mintedBy: "local-owner",
          pendingExpiresAt: new Date(now + 600_000).toISOString(),
        },
      },
      {
        ...base,
        id: randomUUID(),
        type: "device.activated",
        data: {
          schemaVersion: 1,
          deviceId: "phone",
          grants: TAKE_CONTROL_GRANTS,
          sessionExpiresAt: new Date(now + 600_000).toISOString(),
        },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n",
  );
  const phone = signer.issue(
    mintDeviceSessionClaims({ deviceId: "phone", nowEpochSeconds: Math.floor(now / 1000), ttlSeconds: 600 }),
  );

  // An ask whose store write throws: the answer is lost, though the ask may stand.
  const faults = { failNextAsk: false };
  const service = await createClankieApp({
    settings: { load: async () => settings },
    feedCheckReceiptPath: join(root, "state", "feed-check-receipts.json"),
    captain: createStubCaptain({
      serveOperatorConversation: (request, authority) =>
        store.serve(request as Parameters<typeof store.serve>[0], authority),
      invalidateQuestionPrincipal: (deviceId) => store.invalidateQuestionPrincipal(deviceId),
      requestOwnerAsk: async (conversationId, draft, publicationId, options) => {
        const asked = store.requestSurfaceQuestion(conversationId, draft, {
          current: () => store.conversation(conversationId) !== undefined,
          ...(publicationId === undefined ? {} : { publicationId }),
          ...(options?.exactPublication ? { exactPublication: true } : {}),
        });
        if (!faults.failNextAsk) return asked;
        faults.failNextAsk = false;
        await asked;
        throw new Error("The ask's answer was lost");
      },
    }),
    builtInTracker: tracker,
    evidenceStore: evidence,
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
  const request = (path: string, body: unknown, token = OWNER) =>
    service.app.request(path, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const post = (body: OperatorConversationServiceRequest | Record<string, unknown>, token = OWNER) =>
    request("/operator/v1/dispatch", body, token);
  const feed = async (
    body: Record<string, unknown> = {},
    token = OWNER,
  ): Promise<FeedPage & { outcome: "ready" }> => {
    const response = await post({ op: "feed_list", schemaVersion: 1, ...body }, token);
    expect(response.status).toBe(200);
    const result = parseProtocolResponse(OperatorConversationServiceResultSchema, await response.json());
    if (result.op !== "feed_list" || result.result.outcome !== "ready")
      throw new Error("unexpected feed result");
    return result.result as FeedPage & { outcome: "ready" };
  };
  const check = async (body: Record<string, unknown>, token = OWNER) => {
    const response = await post({ op: "feed_check", schemaVersion: 1, ...body }, token);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const cli = async (args: string[]) => {
    const output: string[] = [];
    const status = await runFeedCommand(args, {
      host: "http://fixture",
      env: { CLANKIE_OPERATOR_TOKEN: OWNER },
      fetchImpl: async (input, init) => service.app.fetch(new Request(input, init)),
      stdout: { write: (chunk) => output.push(chunk) },
    });
    return { status, output: output.join("") };
  };
  /** Landed by a worker with a checked bundle of a clip and a screenshot, then marked by the lead. */
  const finished = async (title: string, ownerCheck: string) => {
    const issue = (await tracker.call(
      "save_issue",
      { title, team: "LOCAL", project: trackerProject.id },
      { actor: BUILDER },
    )) as { id: string; identifier: string; url: string };
    await tracker.call(
      "post_issue_event",
      { issueId: issue.id, type: "result", stage: "landed" },
      { actor: BUILDER },
    );
    const shot = await store_(
      Buffer.concat([PNG, Buffer.from(title)]),
      "image/png",
      "gate.png",
      issue.identifier,
    );
    const clip = await store_(Buffer.from(`ftypmp42 ${title}`), "video/mp4", "gate.mp4", issue.identifier);
    const records = await evidence.list({ issueKey: issue.identifier });
    const reference = (sha: string, type: string) => {
      const record = records.find((entry) => entry.sha256 === sha)!;
      return { recordId: record.id, sha256: sha, url: `clankie://evidence/sha256/${sha}`, type };
    };
    const bundle = (await tracker.call(
      "save_evidence_bundle",
      {
        issueId: issue.id,
        references: [reference(shot.sha256, "screenshot"), reference(clip.sha256, "video")],
        gaps: [],
      },
      { actor: BUILDER },
    )) as { id: string };
    await tracker.call("post_bundle_check", { bundleId: bundle.id }, { actor: CHECKER });
    await tracker.call("save_issue", { id: issue.id, ownerCheck }, { actor: LEAD });
    return { issue, bundle, shot, clip };
  };
  return {
    faults,
    garden,
    lead,
    store,
    service,
    tracker,
    evidence,
    store_,
    post,
    request,
    feed,
    check,
    cli,
    finished,
    phone,
  };
}

it("an agent asks the owner for a quick check; the feed shows its line, evidence and longer mark, and an answer clears it", async () => {
  const f = await fixture();
  const shot = await f.store_(PNG, "image/png", "path.png");
  const line = "Open Garden, tap the gate: it swings open and the path shows";

  // The CLI asks with the operator credential. The project has no bound lead chat, so
  // the main chat takes the answer, as tracker work routes it; the ask keeps its project.
  const asked = await f.cli([
    "check",
    "--project",
    "garden",
    "--evidence",
    shot.link,
    "--key",
    "a".repeat(20),
    line,
  ]);
  expect(asked.status).toBe(0);
  expect(asked.output).toContain(`Asked: ${line}`);
  expect(asked.output).toContain("conversation global-default");

  // A longer look still shows, marked; the API answers with the check as the feed shows it.
  // Named by conversation, it belongs to the project whose workspace that chat is in.
  const longer = await f.check({
    idempotencyKey: "b".repeat(20),
    conversationId: f.lead,
    check: "Read the new onboarding copy aloud: does it sound like Clankie?",
    longer: true,
  });
  expect(longer.status).toBe(200);
  const raised = longer.body.result as FeedCheckResult & { outcome: "raised" };
  expect(raised).toMatchObject({
    outcome: "raised",
    duplicate: false,
    item: {
      kind: "check",
      check: {
        line: "Read the new onboarding copy aloud: does it sound like Clankie?",
        longer: true,
        question: { purpose: "verify", conversationId: f.lead, status: "pending", longer: true },
      },
    },
  });
  expect(raised.item.check.question.options.map((option) => option.label)).toEqual([
    "It works",
    "Send it back",
  ]);

  // The same key and check asks nothing new; the same key with another check is refused.
  const again = await f.check({
    idempotencyKey: "b".repeat(20),
    conversationId: f.lead,
    check: "Read the new onboarding copy aloud: does it sound like Clankie?",
    longer: true,
  });
  expect(again.body.result).toMatchObject({
    outcome: "raised",
    duplicate: true,
    item: { id: raised.item.id },
  });
  expect(
    (
      await f.check({
        idempotencyKey: "b".repeat(20),
        conversationId: f.lead,
        check: "Something else entirely",
      })
    ).body.result,
  ).toMatchObject({ outcome: "refused", reason: "idempotency_conflict" });

  const page = await f.feed({ projectId: "garden" });
  const checks = page.items.filter((item) => item.kind === "check");
  expect(checks).toHaveLength(2);
  expect(checks[0]).toMatchObject({ id: raised.item.id, projectId: "garden", check: { longer: true } });
  expect(checks[0]!.kind === "check" && checks[0]!.check.media).toBeUndefined();
  // Its evidence is filled from the real evidence store: the link and its type.
  expect(checks[1]).toMatchObject({
    kind: "check",
    projectId: "garden",
    check: {
      line,
      media: [{ url: shot.link, mimeType: "image/png" }],
      question: { prompt: line, check: line, evidence: shot.link, projectId: "garden" },
    },
  });
  expect(checks[1]).not.toHaveProperty("check.longer");
  // People read the picture first, then the line, under the project's name (#187).
  expect(checks[1]!.view).toMatchObject({
    caption: line,
    project: "Garden",
    visual: { url: shot.link, mimeType: "image/png" },
  });
  const text = formatFeedPage(page);
  expect(text).toMatch(/^Garden\n\n {2}Check, takes longer than a quick look · /u);
  expect(text).toContain(`  Picture: ${shot.link}\n  ${line}\n`);
  expect(text).not.toContain(checks[1]!.kind === "check" ? checks[1]!.check.question.requestId : "?");
  expect(formatFeedPage(page, {}, { details: true })).toContain(
    `Request: ${checks[1]!.kind === "check" ? checks[1]!.check.question.requestId : "?"}`,
  );

  // Answering with the existing op, against the target the feed carried, takes it out.
  const target = checks[1]!;
  if (target.kind !== "check") throw new Error("expected a check");
  const answered = OperatorConversationServiceResultSchema.parse(
    await (
      await f.post({
        op: "input_answer",
        schemaVersion: 1,
        conversationId: target.check.question.conversationId,
        requestId: target.check.question.requestId,
        incarnationId: target.check.question.incarnationId,
        expectedRevision: target.check.revision,
        answer: { kind: "choice", optionId: target.check.question.options[0]!.optionId },
      })
    ).json(),
  );
  expect(answered).toMatchObject({ op: "input_answer", result: { status: "resolved" } });
  expect((await f.feed({ projectId: "garden" })).items.map((item) => item.id)).toEqual([raised.item.id]);
});

it("two keys asking the same check each get their own ask, so each retry finds it after an answer", async () => {
  const f = await fixture();
  const body = { conversationId: f.lead, check: "Tap the shed: its door opens" };
  const first = (await f.check({ idempotencyKey: "k".repeat(20), ...body })).body
    .result as FeedCheckResult & {
    outcome: "raised";
  };
  const second = (await f.check({ idempotencyKey: "l".repeat(20), ...body })).body
    .result as FeedCheckResult & {
    outcome: "raised";
  };
  expect(second).toMatchObject({ outcome: "raised", duplicate: false });
  expect(second.item.id).not.toBe(first.item.id);

  // The owner answers the second key's check; its caller lost the reply and retries.
  const question = second.item.check.question;
  await f.post({
    op: "input_answer",
    schemaVersion: 1,
    conversationId: question.conversationId,
    requestId: question.requestId,
    incarnationId: question.incarnationId,
    expectedRevision: second.item.check.revision,
    answer: { kind: "choice", optionId: question.options[0]!.optionId },
  });
  const retried = (await f.check({ idempotencyKey: "l".repeat(20), ...body })).body
    .result as FeedCheckResult & {
    outcome: "raised";
  };
  expect(retried).toMatchObject({
    outcome: "raised",
    duplicate: true,
    item: { id: second.item.id, check: { question: { status: "submitted" } } },
  });
  // Nothing new was asked: only the first key's check still waits.
  expect((await f.feed({ projectId: "garden" })).items.map((item) => item.id)).toEqual([first.item.id]);
});

it("two calls racing with one new key and different checks ask only one of them", async () => {
  const f = await fixture();
  const results = await Promise.all(
    ["Tap the gate: it swings", "Tap the shed: its door opens"].map(
      async (check) =>
        (await f.check({ idempotencyKey: "n".repeat(20), conversationId: f.lead, check })).body
          .result as FeedCheckResult,
    ),
  );
  expect(results.map((result) => result.outcome).sort()).toEqual(["raised", "refused"]);
  expect(results.find((result) => result.outcome === "refused")).toMatchObject({
    reason: "idempotency_conflict",
  });
  expect((await f.feed()).items.filter((item) => item.kind === "check")).toHaveLength(1);
});

it("an old key never asks again after the chat's question history lets its answer go", async () => {
  const f = await fixture();
  const body = { conversationId: f.lead, check: "Tap the well: water rises" };
  const first = (await f.check({ idempotencyKey: "m".repeat(20), ...body })).body
    .result as FeedCheckResult & {
    outcome: "raised";
  };
  const answer = async (raised: FeedCheckResult & { outcome: "raised" }) => {
    const question = raised.item.check.question;
    await f.post({
      op: "input_answer",
      schemaVersion: 1,
      conversationId: question.conversationId,
      requestId: question.requestId,
      incarnationId: question.incarnationId,
      expectedRevision: raised.item.check.revision,
      answer: { kind: "choice", optionId: question.options[0]!.optionId },
    });
  };
  await answer(first);
  // More answered checks than the chat keeps push the first one out of its history.
  for (let index = 0; index < 34; index += 1) {
    const later = (
      await f.check({
        idempotencyKey: `later-${String(index).padStart(14, "0")}`,
        ...body,
        check: `Look at stone ${index}`,
      })
    ).body.result as FeedCheckResult & { outcome: "raised" };
    await answer(later);
  }
  const kept = await Promise.all(
    (["pending", "submitted", "cancelled"] as const).map(async (status) => {
      const listed = OperatorConversationServiceResultSchema.parse(
        await (await f.post({ op: "input_list", schemaVersion: 1, status })).json(),
      );
      return listed.op === "input_list"
        ? listed.result.questions.map((entry) => entry.question?.requestId)
        : [];
    }),
  );
  expect(kept.flat()).not.toContain(first.item.check.question.requestId);

  // Retrying the first key asks nothing; another check under it is still a conflict.
  expect((await f.check({ idempotencyKey: "m".repeat(20), ...body })).body.result).toMatchObject({
    outcome: "refused",
    reason: "already_asked",
  });
  expect(
    (await f.check({ idempotencyKey: "m".repeat(20), ...body, check: "Something else" })).body.result,
  ).toMatchObject({ outcome: "refused", reason: "idempotency_conflict" });
  expect((await f.feed()).items.filter((item) => item.kind === "check")).toEqual([]);
});

it("prints the key the CLI made when the answer is unavailable, so its retry asks nothing new", async () => {
  const f = await fixture();
  const line = "Tap the bench: it rocks";
  f.faults.failNextAsk = true;
  const lost = await f.cli(["check", "--project", "garden", line]);
  expect(lost.status).toBe(1);
  const key = /Retry with --key (\S+): it never asks twice\./u.exec(lost.output)?.[1];
  expect(key).toBeDefined();
  const retried = await f.cli(["check", "--project", "garden", "--key", key!, line]);
  expect(retried.status).toBe(0);
  expect(retried.output).toContain(`Already asked: ${line}`);
  expect((await f.feed()).items.filter((item) => item.kind === "check")).toHaveLength(1);

  // JSON carries the same key.
  f.faults.failNextAsk = true;
  const json = await f.cli(["check", "--project", "garden", "--json", "Tap the gate: it swings"]);
  expect(JSON.parse(json.output)).toMatchObject({
    outcome: "unavailable",
    idempotencyKey: expect.any(String),
  });
});

it("refuses a check line over 140 characters with a 400 naming the limit, at the API and the ask tool", async () => {
  const f = await fixture();
  const long = `Open Garden and ${"look ".repeat(30)}`.trim();
  expect(long.length).toBeGreaterThan(140);
  const refused = await f.check({ idempotencyKey: "c".repeat(20), projectId: "garden", check: long });
  expect(refused.status).toBe(400);
  expect(refused.body).toEqual({
    error: "invalid_request",
    message: "check: A check line is at most 140 characters: say exactly what to look at",
  });
  const exact = "x".repeat(140);
  expect((await f.check({ idempotencyKey: "d".repeat(20), check: exact })).body.result).toMatchObject({
    outcome: "raised",
    item: { check: { line: exact } },
  });
  // Other refusals name their fix too.
  expect((await f.check({ idempotencyKey: "e".repeat(20), check: "One\nTwo" })).body).toMatchObject({
    message: "check: A check line is one line",
  });
  expect(
    (
      await f.check({
        idempotencyKey: "f".repeat(20),
        check: "Look",
        projectId: "garden",
        conversationId: f.lead,
      })
    ).body,
  ).toMatchObject({ message: "Name a project or a conversation for the answer, not both" });
  expect(
    (await f.check({ idempotencyKey: "g".repeat(20), check: "Look", projectId: "orchard" })).body.result,
  ).toMatchObject({ outcome: "refused", reason: "unknown_project" });
  expect(
    (
      await f.check({
        idempotencyKey: "h".repeat(20),
        check: "Look",
        evidence: `clankie://evidence/sha256/${"0".repeat(64)}`,
      })
    ).body.result,
  ).toMatchObject({ outcome: "refused", reason: "evidence_missing" });

  // The CLI refuses before sending, with the same words.
  await expect(f.cli(["check", "--project", "garden", long])).rejects.toThrow(
    "A check line is at most 140 characters: say exactly what to look at",
  );
  // The ask tool's own schema holds the same limit.
  expect(() =>
    QuestionDraftSchema.parse({
      purpose: "verify",
      kind: "choice",
      prompt: "Check the gate",
      check: long,
      waitingOn: "The gate",
      options: [{ label: "It works" }, { label: "Send it back" }],
    }),
  ).toThrow("A check line is at most 140 characters");

  // Only this machine's operator asks: the owner's phone and a captain bearer are refused.
  expect((await f.check({ idempotencyKey: "i".repeat(20), check: "Look" }, f.phone)).status).toBe(403);
  expect((await f.check({ idempotencyKey: "j".repeat(20), check: "Look" }, "captain")).status).toBe(401);
});

it("a finished item the lead marked shows as a proof with its clip and screenshot until the owner's phone answers it", async () => {
  const f = await fixture();
  const gate = await f.finished("Gate latch", "Open Garden, tap the gate twice: it latches");
  // Unmarked finished work never reaches the owner.
  const quiet = (await f.tracker.call(
    "save_issue",
    { title: "Refactor", team: "LOCAL" },
    { actor: BUILDER },
  )) as { id: string };
  await f.tracker.call(
    "post_issue_event",
    { issueId: quiet.id, type: "result", stage: "landed" },
    { actor: BUILDER },
  );

  const page = await f.feed({ projectId: "garden" });
  expect(page.items).toEqual([
    {
      kind: "proof",
      id: `proof:${gate.issue.id}`,
      at: expect.any(String),
      projectId: "garden",
      proof: {
        issueId: gate.issue.id,
        key: gate.issue.identifier,
        title: "Gate latch",
        line: "Open Garden, tap the gate twice: it latches",
        bundleId: gate.bundle.id,
        stage: "landed",
        url: gate.issue.url,
        media: [
          { url: gate.clip.link, mimeType: "video/mp4" },
          { url: gate.shot.link, mimeType: "image/png" },
        ],
      },
      // The clip leads; the item's key and bundle wait in the details.
      view: {
        caption: "Open Garden, tap the gate twice: it latches",
        project: "Garden",
        visual: { url: gate.clip.link, mimeType: "video/mp4" },
        details: expect.arrayContaining([
          { label: "Item", value: `${gate.issue.identifier}: Gate latch` },
          { label: "Proof bundle", value: gate.bundle.id },
        ]),
      },
    },
  ]);
  expect(formatFeedPage(page)).toContain(
    "Answer on your paired phone: It works, or Send it back with a note",
  );

  // A pending verify ask on the item is its check instead: the item's line and first clip ride the ask.
  const ask = await f.store.requestSurfaceQuestion(
    f.lead,
    QuestionDraftSchema.parse({
      purpose: "verify",
      kind: "choice",
      prompt: `${gate.issue.identifier} landed: "Gate latch". Check that it works.`,
      options: [{ label: "It works" }, { label: "Send it back" }],
      allowFreeform: true,
      waitingOn: `${gate.issue.identifier} owner verification`,
      issue: { tracker: "clankie-work", key: gate.issue.identifier, url: gate.issue.url },
    }),
    admission,
  );
  const asked = await f.feed({ projectId: "garden" });
  expect(asked.items).toHaveLength(1);
  expect(asked.items[0]).toMatchObject({
    kind: "check",
    id: `check:${ask.question!.requestId}`,
    check: {
      line: "Open Garden, tap the gate twice: it latches",
      media: [{ url: gate.clip.link, mimeType: "video/mp4" }],
    },
  });
  await f.post({
    op: "input_cancel",
    schemaVersion: 1,
    conversationId: f.lead,
    requestId: ask.question!.requestId,
    incarnationId: ask.question!.incarnationId,
    expectedRevision: ask.revision!,
  });
  expect((await f.feed({ projectId: "garden" })).items.map((item) => item.kind)).toEqual(["proof"]);

  // Routed to the main chat with only the issue to go on, the check still belongs to the project.
  const main = await f.store.requestSurfaceQuestion(
    "global-default",
    QuestionDraftSchema.parse({
      purpose: "verify",
      kind: "choice",
      prompt: `${gate.issue.identifier} landed: "Gate latch". Check that it works.`,
      options: [{ label: "It works" }, { label: "Send it back" }],
      allowFreeform: true,
      waitingOn: `${gate.issue.identifier} owner verification`,
      issue: { tracker: "clankie-work", key: gate.issue.identifier, url: gate.issue.url },
    }),
    admission,
  );
  expect((await f.feed({ projectId: "garden" })).items).toMatchObject([
    { kind: "check", id: `check:${main.question!.requestId}`, projectId: "garden" },
  ]);
  await f.post({
    op: "input_cancel",
    schemaVersion: 1,
    conversationId: "global-default",
    requestId: main.question!.requestId,
    incarnationId: main.question!.incarnationId,
    expectedRevision: main.revision!,
  });
  expect((await f.feed({ projectId: "garden" })).items.map((item) => item.kind)).toEqual(["proof"]);

  // The owner's phone gives its verdict on the bundle it saw; the proof leaves the feed.
  const verdict = await f.request(
    "/v1/tracker/call",
    {
      name: "post_owner_verdict",
      arguments: { issueId: gate.issue.id, bundleId: gate.bundle.id, verdict: "works" },
    },
    f.phone,
  );
  expect(verdict.status).toBe(200);
  expect((await f.feed({ projectId: "garden" })).items).toEqual([]);
});

it("pages checks, proofs and asks together without repeats", async () => {
  const f = await fixture();
  const ids: string[] = [];
  for (const [index, title] of ["Gate", "Path", "Shed"].entries()) {
    const done = await f.finished(title, `Open Garden, tap the ${title.toLowerCase()}: it opens`);
    ids.push(`proof:${done.issue.id}`);
    await pause();
    const raised = await f.check({
      idempotencyKey: `${String(index)}`.repeat(20),
      projectId: "garden",
      check: `Look at the ${title.toLowerCase()} on the map: it is there`,
    });
    ids.push((raised.body.result as FeedCheckResult & { outcome: "raised" }).item.id);
    await pause();
  }
  const all = await f.feed({ projectId: "garden" });
  expect(new Set(all.items.map((item) => item.id))).toEqual(new Set(ids));
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await f.feed({ projectId: "garden", limit: 2, ...(cursor ? { cursor } : {}) });
    seen.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor;
  } while (cursor);
  expect(seen).toEqual(all.items.map((item) => item.id));
  expect(seen).toHaveLength(6);
});
