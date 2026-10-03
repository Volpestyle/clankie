import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { LinearAttributionJournal } from "../src/linear-attribution.ts";
import { classifyLinearDelivery, type LinearActivityEvent } from "../src/linear-webhook.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const NOW = new Date("2026-10-03T01:00:00.000Z");
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
