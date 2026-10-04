import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { LinearAttributionJournal } from "../src/linear-attribution.ts";
import {
  classifyLinearDelivery,
  LinearWriteReceipts,
  type LinearActivityEvent,
} from "../src/linear-webhook.ts";
import type { LinearRecipient } from "../src/captain/conversation-owner.ts";
import type { ProviderAccount } from "@clankie/credential-broker";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const NOW = new Date("2026-10-03T01:00:00.000Z");
const ISSUE = "a06a1c92-8a14-4240-8802-a0bb868d639c";
const OTHER_ISSUE = "be9a13a6-2236-4da1-bc7f-a275392e69b8";
const URL = "https://linear.app/workspace/issue/ABC-1/title#comment-c1";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "linear-attribution-"));
  roots.push(root);
  const path = join(root, "journal.json");
  return { path, journal: new LinearAttributionJournal(path) };
}
function activity(overrides: Partial<LinearActivityEvent> = {}): LinearActivityEvent {
  return {
    eventId: "e1",
    deliveryId: "d1",
    type: "Comment",
    action: "create",
    organizationId: "org",
    actorId: "owner",
    actorType: "user",
    actorName: "Owner",
    actorEmail: "owner@example.test",
    createdAt: NOW.toISOString(),
    url: URL,
    data: { id: "c1" },
    updatedFrom: undefined,
    ...overrides,
  };
}
const notification = { type: "issueNewComment", createdAt: "2026-10-03T01:00:00.400Z", url: URL };
it("attributes actor-less notifications from signed events, survives restart and ignores issue slug changes", () => {
  const { path, journal } = fixture();
  const body = JSON.stringify({
    action: "create",
    type: "Comment",
    organizationId: "org",
    webhookTimestamp: NOW.getTime(),
    createdAt: NOW.toISOString(),
    url: URL,
    data: { id: "c1" },
    actor: { id: "owner", type: "user", name: "Owner", email: "owner@example.test" },
  });
  const signature = createHmac("sha256", "secret").update(body).digest("hex");
  const input = {
    rawBody: Buffer.from(body),
    headers: { signature, delivery: "d1", event: "Comment" },
    secret: "secret",
    now: NOW,
    recordActivity: (event: LinearActivityEvent) => journal.record(event, NOW),
  };
  expect(classifyLinearDelivery({ ...input, secret: "wrong" }).kind).toBe("rejected");
  expect(journal.attribute(notification, "org")).toBeUndefined();
  expect(classifyLinearDelivery(input).kind).toBe("activity");
  expect(
    new LinearAttributionJournal(path).attribute(
      { ...notification, url: URL.replace("/title", "/renamed") },
      "org",
    ),
  ).toEqual({ id: "owner", type: "user", name: "Owner", email: "owner@example.test" });
});
it("requires the same workspace, resource, comment and nearby action timestamp", () => {
  const { journal } = fixture();
  journal.record(activity(), NOW);
  expect(journal.attribute(notification, "other")).toBeUndefined();
  for (const url of [
    URL.replace("ABC-1", "ABC-2"),
    URL.replace("c1", "c2"),
    "https://evil.test/issue/ABC-1",
    undefined,
  ])
    expect(journal.attribute({ ...notification, url }, "org")).toBeUndefined();
  expect(
    journal.attribute({ ...notification, createdAt: "2026-10-03T01:01:00.000Z" }, "org"),
  ).toBeUndefined();
  expect(journal.attribute({ ...notification, type: "issueStatusChanged" }, "org")).toBeUndefined();
});
it("does not guess among different or missing actors and keeps worker provenance", () => {
  const { journal } = fixture();
  journal.record(activity(), NOW);
  journal.record(activity({ eventId: "e2", actorId: "bot", actorType: "app" }), NOW);
  expect(journal.attribute(notification, "org")).toBeUndefined();
  const f = fixture();
  const worker = { grantId: "grant", principalId: "worker", workId: "work" };
  f.journal.record(activity({ worker, actorId: "bot", actorType: "user" }), NOW);
  expect(f.journal.attribute(notification, "org")).toMatchObject({ id: "bot", worker });
  f.journal.record(activity({ eventId: "unknown", actorId: undefined }), NOW);
  expect(f.journal.attribute(notification, "org")).toBeUndefined();
});
it("matches state revisions, rejects unrelated comments, and does not use notification updatedAt", () => {
  const { journal } = fixture();
  journal.record(
    activity({
      type: "Issue",
      data: { id: "i1" },
      url: URL.split("#")[0],
      action: "update",
      updatedFrom: { stateId: "old" },
    }),
    NOW,
  );
  expect(
    journal.attribute({ ...notification, url: URL.split("#")[0], type: "issueStatusChanged" }, "org"),
  ).toMatchObject({ id: "owner" });
  expect(journal.attribute(notification, "org")).toBeUndefined();
});

it("resolves signed canonical issue identity across title slugs, comment anchors and restart, without actor timing guesses", () => {
  const { path, journal } = fixture();
  const body = JSON.stringify({
    action: "update",
    type: "Issue",
    organizationId: "org",
    webhookTimestamp: NOW.getTime(),
    createdAt: NOW.toISOString(),
    url: URL.split("#")[0],
    data: { id: ISSUE },
    actor: { id: "owner", type: "user" },
  });
  const input = {
    rawBody: Buffer.from(body),
    headers: {
      signature: createHmac("sha256", "secret").update(body).digest("hex"),
      delivery: "signed-issue",
      event: "Issue",
    },
    secret: "secret",
    now: NOW,
    recordActivity: (event: LinearActivityEvent) => journal.record(event, NOW),
  };
  expect(classifyLinearDelivery({ ...input, secret: "wrong" }).kind).toBe("rejected");
  expect(journal.issue(notification, "org")).toBeUndefined();
  expect(classifyLinearDelivery(input)).toMatchObject({ kind: "activity", activity: { issueId: ISSUE } });
  const restarted = new LinearAttributionJournal(path);
  expect(
    restarted.issue({ url: URL.replace("/title", "/renamed").replace("c1", "new-comment") }, "org"),
  ).toBe(ISSUE);
  // Issue mapping uses retained signed resource identity, not the short actor correlation window.
  expect(
    restarted.attribute({ ...notification, createdAt: "2026-10-03T02:00:00.000Z" }, "org"),
  ).toBeUndefined();
  expect(restarted.issue({ url: URL }, "other-org")).toBeUndefined();
});

it("uses a signed comment's parent UUID and never a display identifier or caller-selected activity issueId", () => {
  const { journal } = fixture();
  journal.record(activity({ data: { id: "c1", issueId: ISSUE.toUpperCase(), issue: { id: ISSUE } } }), NOW);
  expect(journal.issue(notification, "org")).toBe(ISSUE);
  const nested = fixture();
  nested.journal.record(activity({ data: { id: "c1", issue: { id: ISSUE } } }), NOW);
  expect(nested.journal.issue(notification, "org")).toBe(ISSUE);
  const unknown = fixture();
  unknown.journal.record(
    activity({ issueId: ISSUE, data: { id: "c1", issueId: "ABC-1", issue: { id: "ABC-1" } } }),
    NOW,
  );
  expect(unknown.journal.issue(notification, "org")).toBeUndefined();
  unknown.journal.record(
    activity({ eventId: "notification", notification: true, data: { id: "c1", issueId: ISSUE } }),
    NOW,
  );
  expect(unknown.journal.issue(notification, "org")).toBeUndefined();
  for (const url of [undefined, "https://evil.test/workspace/issue/ABC-1", URL.replace("ABC-1", "ABC-2")])
    expect(journal.issue({ url }, "org")).toBeUndefined();
});

it("refuses conflicting signed UUID mappings within a workspace or one comment, and drops expired evidence on retention", () => {
  const { path, journal } = fixture();
  journal.record(activity({ data: { id: "c1", issueId: ISSUE } }), NOW);
  journal.record(
    activity({
      eventId: "other-workspace",
      organizationId: "other-org",
      data: { id: "c2", issueId: OTHER_ISSUE },
    }),
    NOW,
  );
  expect(journal.issue(notification, "org")).toBe(ISSUE);
  expect(journal.issue(notification, "other-org")).toBe(OTHER_ISSUE);
  journal.record(activity({ eventId: "conflict", data: { id: "c3", issueId: OTHER_ISSUE } }), NOW);
  expect(journal.issue(notification, "org")).toBeUndefined();
  expect(new LinearAttributionJournal(path).issue(notification, "org")).toBeUndefined();
  const contradictory = fixture();
  contradictory.journal.record(
    activity({ data: { id: "c1", issueId: ISSUE, issue: { id: OTHER_ISSUE } } }),
    NOW,
  );
  expect(contradictory.journal.issue(notification, "org")).toBeUndefined();
  const later = new Date(NOW.getTime() + 8 * 24 * 60 * 60 * 1000);
  journal.record(
    activity({
      eventId: "fresh",
      createdAt: later.toISOString(),
      url: URL.replace("ABC-1", "ABC-2"),
      data: { id: "c4", issueId: ISSUE },
    }),
    later,
  );
  expect(journal.issue(notification, "other-org")).toBeUndefined();
});

const UPDATE = "d9b90f52-0b0e-463d-a1e9-9457d250592c";
const COMMENT = "0707b479-8a50-4496-b6ba-bec2efbd0a1f";
const STATUS_URL =
  "https://linear.app/work/project/kh2-abc123/activity#project-update-d9b90f52&comment-0707b479";
const NATIVE: LinearRecipient = {
  kind: "native",
  paneId: "pc/w3:pK",
  seatId: "kh2-claude",
  occupantId: "claude:kh2-session",
  binding: "a".repeat(64),
};
const STATUS_ACCOUNT: ProviderAccount = {
  provider: "linear",
  connectionId: "native-linear",
  userId: "clankie",
  workspaceId: "org",
  name: "Clankie",
  email: "bot@example.test",
  workspaceName: "Personal",
  verifiedAt: NOW.toISOString(),
};
function statusWrites(recipient: LinearRecipient | undefined = NATIVE, path?: string) {
  const writes = new LinearWriteReceipts(path);
  writes.record(
    {
      server: "linear",
      tool: "save_status_update",
      arguments: { type: "project" },
      content: JSON.stringify({
        id: UPDATE,
        updatedAt: NOW.toISOString(),
        body: "Status",
        project: { id: ISSUE },
      }),
      isError: false,
      account: STATUS_ACCOUNT,
      recipient,
    },
    NOW,
  );
  return writes;
}
function signedStatusReply(
  journal: LinearAttributionJournal,
  writes: LinearWriteReceipts,
  overrides: Record<string, unknown> = {},
  data: Record<string, unknown> = {},
) {
  const body = JSON.stringify({
    action: "create",
    type: "Comment",
    organizationId: "org",
    webhookTimestamp: NOW.getTime(),
    createdAt: NOW.toISOString(),
    actor: { id: "owner", type: "user" },
    url: STATUS_URL,
    data: {
      id: COMMENT,
      body: "I APPROVE all!!",
      projectUpdateId: UPDATE,
      projectUpdate: { id: UPDATE },
      ...data,
    },
    ...overrides,
  });
  return classifyLinearDelivery({
    rawBody: Buffer.from(body),
    headers: {
      signature: createHmac("sha256", "secret").update(body).digest("hex"),
      delivery: "project-reply",
      event: "Comment",
    },
    secret: "secret",
    now: NOW,
    writes,
    recordActivity: (event) => journal.record(event, NOW),
  });
}
const statusNotification = { type: "projectUpdateNewComment", createdAt: NOW.toISOString(), url: STATUS_URL };

it("correlates a remote native recipient through exact signed parent and comment aliases across restart", () => {
  const { path, journal } = fixture();
  const writesPath = path + ".writes";
  statusWrites(NATIVE, writesPath);
  expect(signedStatusReply(journal, new LinearWriteReceipts(writesPath)).kind).toBe("activity");
  const restarted = new LinearAttributionJournal(path);
  const expected = {
    parentType: "ProjectUpdate",
    parentId: UPDATE,
    recipient: NATIVE,
    recordedAt: NOW.getTime(),
  };
  expect(restarted.replyRecipient(statusNotification, "org")).toEqual(expected);
  expect(
    restarted.replyRecipient(
      { ...statusNotification, url: STATUS_URL.replace("/activity", "/updates") },
      "org",
    ),
  ).toEqual(expected);
  expect(restarted.attribute(statusNotification, "org")).toEqual({ id: "owner", type: "user" });
  const stored = readFileSync(path, "utf8");
  expect(stored).toContain(UPDATE);
  expect(stored).toContain(COMMENT);
  expect(stored).not.toContain("I APPROVE");
  for (const url of [
    undefined,
    STATUS_URL.replace("d9b90f52", "ffffffff"),
    STATUS_URL.replace("0707b479", "ffffffff"),
    STATUS_URL.replace("linear.app", "evil.test"),
    STATUS_URL.replace("d9b90f52", "d9b90f5"),
  ])
    expect(restarted.replyRecipient({ ...statusNotification, url }, "org")).toBeUndefined();
  expect(restarted.replyRecipient(statusNotification, "other-org")).toBeUndefined();
  expect(
    restarted.replyRecipient({ ...statusNotification, createdAt: "2026-10-03T02:00:00.000Z" }, "org"),
  ).toBeUndefined();
});

it("keeps missing or conflicting reply ownership separate from actor eligibility", () => {
  const missing = fixture();
  signedStatusReply(missing.journal, new LinearWriteReceipts());
  expect(missing.journal.attribute(statusNotification, "org")).toEqual({ id: "owner", type: "user" });
  expect(missing.journal.replyRecipient(statusNotification, "org")).toBeUndefined();
  const { journal } = fixture();
  signedStatusReply(journal, statusWrites());
  signedStatusReply(journal, new LinearWriteReceipts(), { unknownRevision: true });
  expect(journal.attribute(statusNotification, "org")).toEqual({ id: "owner", type: "user" });
  expect(journal.replyRecipient(statusNotification, "org")).toBeUndefined();
  const conflict = fixture();
  const writes = statusWrites();
  writes.record(
    {
      server: "linear",
      tool: "save_status_update",
      arguments: { type: "project" },
      content: JSON.stringify({ id: UPDATE, updatedAt: NOW.toISOString(), body: "Status" }),
      isError: false,
      account: STATUS_ACCOUNT,
      recipient: { ...NATIVE, paneId: "pc/w4:p1" },
    },
    NOW,
  );
  signedStatusReply(conflict.journal, writes);
  expect(conflict.journal.attribute(statusNotification, "org")).toEqual({ id: "owner", type: "user" });
  expect(conflict.journal.replyRecipient(statusNotification, "org")).toBeUndefined();
});

it("refuses ambiguous UUID aliases even when the same native recipient authored both updates", () => {
  const { journal } = fixture();
  signedStatusReply(journal, statusWrites());
  const otherUpdate = "d9b90f52-1111-4111-8111-111111111111";
  const otherComment = "0707b479-2222-4222-8222-222222222222";
  const writes = new LinearWriteReceipts();
  writes.record(
    {
      server: "linear",
      tool: "save_status_update",
      arguments: { type: "project" },
      content: JSON.stringify({ id: otherUpdate, updatedAt: NOW.toISOString(), body: "Other" }),
      isError: false,
      account: STATUS_ACCOUNT,
      recipient: NATIVE,
    },
    NOW,
  );
  signedStatusReply(
    journal,
    writes,
    {},
    { id: otherComment, projectUpdateId: otherUpdate, projectUpdate: { id: otherUpdate } },
  );
  expect(journal.replyRecipient(statusNotification, "org")).toBeUndefined();
  expect(journal.attribute(statusNotification, "org")).toEqual({ id: "owner", type: "user" });
});

it("retries signed recipient journal storage without losing proof or duplicating entries", () => {
  const { path, journal } = fixture();
  const writes = statusWrites();
  mkdirSync(path + ".tmp");
  expect(() => signedStatusReply(journal, writes)).toThrow();
  expect(journal.replyRecipient(statusNotification, "org")).toBeUndefined();
  rmSync(path + ".tmp", { recursive: true });
  signedStatusReply(journal, writes);
  signedStatusReply(journal, writes);
  expect(new LinearAttributionJournal(path).replyRecipient(statusNotification, "org")).toMatchObject({
    parentId: UPDATE,
    recipient: NATIVE,
  });
  expect(JSON.parse(readFileSync(path, "utf8"))).toHaveLength(1);
});

it("correlates initiative replies by their signed initiative parent instead of a project URL guess", () => {
  const { journal } = fixture();
  const writes = new LinearWriteReceipts();
  writes.record(
    {
      server: "linear",
      tool: "save_status_update",
      arguments: { type: "initiative" },
      content: JSON.stringify({ id: UPDATE, updatedAt: NOW.toISOString(), body: "Initiative" }),
      isError: false,
      account: STATUS_ACCOUNT,
      recipient: NATIVE,
    },
    NOW,
  );
  const url = STATUS_URL.replace("/project/", "/initiative/").replace(
    "project-update-",
    "initiative-update-",
  );
  signedStatusReply(
    journal,
    writes,
    { url },
    {
      projectUpdateId: undefined,
      projectUpdate: undefined,
      initiativeUpdateId: UPDATE,
      initiativeUpdate: { id: UPDATE },
    },
  );
  expect(
    journal.replyRecipient({ ...statusNotification, type: "initiativeUpdateNewComment", url }, "org"),
  ).toMatchObject({ parentType: "InitiativeUpdate", parentId: UPDATE, recipient: NATIVE });
  expect(journal.replyRecipient(statusNotification, "org")).toBeUndefined();
});

it("preserves original update actor correlation while nonreply notifications never borrow reply recipients", () => {
  const { journal } = fixture();
  const url = STATUS_URL.replace("&comment-0707b479", "");
  journal.record(
    activity({ type: "ProjectUpdate", data: { id: UPDATE }, url, actorId: "owner", actorType: "user" }),
    NOW,
  );
  expect(
    journal.attribute({ type: "projectUpdateCreated", createdAt: NOW.toISOString(), url }, "org"),
  ).toMatchObject({ id: "owner", type: "user" });
  signedStatusReply(journal, statusWrites());
  expect(
    journal.replyRecipient({ ...statusNotification, type: "projectUpdateCreated" }, "org"),
  ).toBeUndefined();
});
