import { afterEach, expect, it } from "vitest";
import { TAKE_CONTROL_GRANTS, type TrackerSyncCommand } from "@clankie/protocol";
import { trackerEvidence } from "./helpers/tracker-evidence.ts";
import { syncFixture } from "./helpers/tracker-sync.ts";

/**
 * ADR 0299 through the real host and relay: only the owner's own paired app gives a
 * verdict on finished work. Agent lanes are covered in tracker-role-budget.
 */
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

type Event = {
  type: string;
  at: string;
  actor: { type: string; id: string };
  via?: string;
  deviceId?: string;
  body?: string;
};

async function fixture() {
  let evidence: ReturnType<typeof trackerEvidence> | undefined;
  const f = await syncFixture({
    validateEvidence: (issueKey, references) => evidence!.validateEvidence(issueKey, references),
  });
  evidence = trackerEvidence(f.root);
  cleanups.push(async () => {
    evidence!.store.close();
    await f.close();
  });
  const builder = { actor: { type: "agent-worker" as const, id: "builder", onBehalfOf: [] } };
  const checker = { actor: { type: "agent-worker" as const, id: "checker", onBehalfOf: [] } };
  /** Landed by a worker, with an independently checked bundle: what the deck shows. */
  const finished = async (title: string) => {
    const issue = (await f.tracker.call("save_issue", { title, team: "LOCAL" }, builder)) as {
      id: string;
      identifier: string;
    };
    await f.tracker.call("post_issue_event", { issueId: issue.id, type: "result", stage: "landed" }, builder);
    const reference = await evidence!.record(issue.identifier);
    const bundle = await publish(issue.id, reference);
    return { issue, bundle, reference };
  };
  const publish = async (issueId: string, reference: unknown) => {
    const bundle = (await f.tracker.call(
      "save_evidence_bundle",
      { issueId, references: [reference], gaps: [] },
      builder,
    )) as { id: string };
    await f.tracker.call("post_bundle_check", { bundleId: bundle.id }, checker);
    return bundle;
  };
  const transaction = (key: string, name: string, args: Record<string, unknown>): TrackerSyncCommand => ({
    action: "transaction",
    idempotencyKey: key,
    operations: [{ name, arguments: args }],
  });
  const events = async (issueId: string) =>
    ((await f.tracker.call("list_issue_events", { issueId })) as { events: Event[] }).events;
  const issue = async (id: string) =>
    (await f.tracker.call("get_issue", { id })) as { stage: string; status: string };
  return { ...f, finished, publish, transaction, events, issue };
}

it("the owner's app verifies the proof it saw, as the owner, and a replay writes nothing more", async () => {
  const f = await fixture();
  const phone = await f.pair("Owner phone");
  const { issue, bundle } = await f.finished("Works");
  // The app's ordinary owner-only move stays refused: the verb is its only verdict.
  expect(
    await f.sync(
      phone.deviceToken,
      f.transaction("direct-verify", "post_issue_event", {
        issueId: issue.id,
        type: "result",
        stage: "owner-verified",
      }),
    ),
  ).toMatchObject({ outcome: "refused", reason: "owner_verification_required" });

  const command = f.transaction("verdict-works", "post_owner_verdict", {
    issueId: issue.id,
    bundleId: bundle.id,
    verdict: "works",
  });
  expect(await f.sync(phone.deviceToken, command)).toMatchObject({ outcome: "applied" });
  expect(await f.issue(issue.id)).toMatchObject({ stage: "owner-verified" });
  const verified = (await f.events(issue.id)).filter((event) => event.type === "verified");
  expect(verified).toEqual([
    expect.objectContaining({
      actor: expect.objectContaining({ type: "human", id: "owner" }),
      via: "owner_app",
      deviceId: phone.deviceId,
    }),
  ]);

  const audit = async () =>
    ((await f.tracker.call("list_audit_events", { limit: 250 })) as { events: unknown[] }).events.length;
  const before = await audit();
  expect(await f.sync(phone.deviceToken, command)).toMatchObject({ outcome: "applied" });
  expect(await audit()).toBe(before);
  expect((await f.events(issue.id)).filter((event) => event.type === "verified")).toHaveLength(1);
});

it("send back posts the owner's note and reopens the item in one write; a note is required", async () => {
  const f = await fixture();
  const phone = await f.pair("Owner phone");
  const { issue, bundle } = await f.finished("Not yet");
  const args = { issueId: issue.id, bundleId: bundle.id, verdict: "send_back" };
  expect(await f.sync(phone.deviceToken, f.transaction("no-note", "post_owner_verdict", args))).toMatchObject(
    {
      outcome: "refused",
      reason: "note_required",
    },
  );
  expect(await f.issue(issue.id)).toMatchObject({ stage: "landed" });

  const note = "The idle wave still plays at double speed on iPad";
  expect(
    await f.sync(phone.deviceToken, f.transaction("with-note", "post_owner_verdict", { ...args, note })),
  ).toMatchObject({ outcome: "applied" });
  expect(await f.issue(issue.id)).toMatchObject({ stage: "accepted" });
  const comments = (await f.tracker.call("list_comments", { issueId: issue.id })) as {
    comments: { body: string }[];
  };
  expect(comments.comments.map((comment) => comment.body)).toEqual([note]);
  const stream = await f.events(issue.id);
  const owner = expect.objectContaining({ type: "human", id: "owner" });
  const comment = stream.find((event) => event.type === "comment")!;
  const reopened = stream.find((event) => event.type === "reopened")!;
  expect(comment).toMatchObject({ actor: owner, via: "owner_app", deviceId: phone.deviceId, body: note });
  expect(reopened).toMatchObject({ actor: owner, via: "owner_app", deviceId: phone.deviceId, body: note });
  // One write: the comment and the reopen share a commit, with no derived state event.
  expect(stream.filter((event) => event.type === "state" && event.at === reopened.at)).toEqual([]);
  expect(comment.at).toBe(reopened.at);
});

it("refuses the operator bearer and an automation pairing, though both can otherwise write", async () => {
  const f = await fixture();
  const { issue, bundle } = await f.finished("Not theirs to verify");
  const args = { issueId: issue.id, bundleId: bundle.id, verdict: "works" };

  const operator = await f.request(
    "/operator/v1/dispatch",
    { op: "tracker_sync", schemaVersion: 1, command: f.transaction("operator", "post_owner_verdict", args) },
    "owner",
  );
  expect((await operator.json()).result).toMatchObject({ outcome: "refused", reason: "owner_app_required" });

  const proof = await f.pair("Disposable proof", TAKE_CONTROL_GRANTS, {
    run: { runId: "owner-verdict-proof", purpose: "test", ttlSeconds: 900 },
  });
  expect(
    await f.sync(proof.deviceToken, f.transaction("automation", "post_owner_verdict", args)),
  ).toMatchObject({ outcome: "refused", reason: "owner_app_required" });
  // The same automation device still writes ordinary owner-app edits.
  expect(
    await f.sync(
      proof.deviceToken,
      f.transaction("automation-comment", "save_comment", { issueId: issue.id, body: "Seen" }),
    ),
  ).toMatchObject({ outcome: "applied" });
  expect(await f.issue(issue.id)).toMatchObject({ stage: "landed" });
});

it("refuses a verdict on a superseded bundle, then accepts the current one", async () => {
  const f = await fixture();
  const phone = await f.pair("Owner phone");
  const { issue, bundle: first, reference } = await f.finished("Proof replaced");
  const current = await f.publish(issue.id, reference);
  expect(
    await f.sync(
      phone.deviceToken,
      f.transaction("stale", "post_owner_verdict", {
        issueId: issue.id,
        bundleId: first.id,
        verdict: "works",
      }),
    ),
  ).toMatchObject({ outcome: "refused", reason: "bundle_superseded" });
  expect(await f.issue(issue.id)).toMatchObject({ stage: "landed" });
  expect(
    await f.sync(
      phone.deviceToken,
      f.transaction("current", "post_owner_verdict", {
        issueId: issue.id,
        bundleId: current.id,
        verdict: "works",
      }),
    ),
  ).toMatchObject({ outcome: "applied" });
});
