import { expect, it } from "vitest";
import type { GuidedReviewMutationReceipt } from "@clankie/work-items";
import { compactLinearWrite } from "../src/linear-write-receipt.ts";

it("answers a Linear write with a receipt, not the record the writer just sent", () => {
  const description = "x".repeat(5_000);
  const saved = JSON.stringify({
    id: "VUH-1",
    uuid: "u",
    title: "T",
    url: "https://linear.app/x/issue/VUH-1",
    status: "Done",
    description,
    stateHistory: [{ state: "Backlog" }],
    attachments: [{ id: "a1", title: "shot", url: "https://uploads.linear.app/signed?signature=secret" }],
  });
  const receipt = JSON.parse(compactLinearWrite("save_issue", saved)) as Record<string, unknown>;
  expect(receipt).toMatchObject({
    id: "VUH-1",
    title: "T",
    status: "Done",
    attachments: [{ id: "a1", title: "shot" }],
  });
  expect(receipt.description).toContain("(5000 chars saved)");
  expect(JSON.stringify(receipt)).not.toContain("signature");
  expect(receipt.stateHistory).toBeUndefined();
  expect(
    compactLinearWrite(
      "save_comment",
      JSON.stringify({ id: "c", body: "short", author: { name: "Clankie" } }),
    ),
  ).toBe(JSON.stringify({ id: "c", body: "short", author: "Clankie" }));
});

it("leaves reads and non-JSON results alone", () => {
  const listed = JSON.stringify({ issues: [{ id: "VUH-1", description: "x".repeat(500) }] });
  expect(compactLinearWrite("list_issues", listed)).toBe(listed);
  expect(compactLinearWrite("get_issue", listed)).toBe(listed);
  expect(compactLinearWrite("save_issue", "not json")).toBe("not json");
});

const guidedReceipt: GuidedReviewMutationReceipt = {
  schemaVersion: 1,
  reviewId: "review-1",
  storeId: "store-1",
  issueId: "LOCAL-1",
  projectId: "project-1",
  identity: { kind: "patch", sha256: "a".repeat(64) },
  snapshotSha256: "b".repeat(64),
  operation: "save",
  eventId: null,
  updatedAt: "2026-10-26T12:00:00.000Z",
  actor: { type: "agent-worker", id: "worker-1", onBehalfOf: [] },
};

it("preserves exact shared guided mutation receipts only for their matching write tools", () => {
  for (const [tool, operation] of [
    ["save_guided_review", "save"],
    ["post_guided_finding", "reply"],
    ["post_guided_finding", "resolve"],
    ["post_retire_guided_review", "retire"],
  ] as const) {
    const receipt: GuidedReviewMutationReceipt = {
      ...guidedReceipt,
      operation,
      eventId: operation === "save" ? null : "event-1",
    };
    const content = JSON.stringify(receipt, null, 2);
    expect(compactLinearWrite(tool, content)).toBe(content);
  }
});

it("compacts malformed guided lookalikes and wrong tool operations through the existing generic path", () => {
  const body = "sensitive-body-".repeat(100);
  const inspection = { private: "untrusted-inspection-sentinel" };
  const malformed: unknown[] = [
    { schemaVersion: 1, reviewId: "review-1" },
    { ...guidedReceipt, schemaVersion: 2 },
    { ...guidedReceipt, actor: { type: "agent-worker", id: "worker-1" } },
    { ...guidedReceipt, actor: { ...guidedReceipt.actor, unexpected: true } },
    {
      ...guidedReceipt,
      actor: { ...guidedReceipt.actor, onBehalfOf: [{ type: "human", id: "owner", body }] },
    },
    { ...guidedReceipt, identity: { kind: "patch", sha256: "invalid" } },
    { ...guidedReceipt, identity: { ...guidedReceipt.identity, inspection } },
    { ...guidedReceipt, snapshotSha256: "invalid" },
    { ...guidedReceipt, projectId: 42 },
    { ...guidedReceipt, projectId: "" },
    { ...guidedReceipt, issueId: "" },
    { ...guidedReceipt, eventId: 42 },
    { ...guidedReceipt, updatedAt: "invalid" },
    { ...guidedReceipt, operation: "refused" },
    { ...guidedReceipt, unexpected: true },
    { ...guidedReceipt, outcome: "refused" },
    { ...guidedReceipt, error: "tracker_refused", reason: "source_mismatch" },
    { error: "tracker_refused", reason: "source_mismatch" },
    { ...guidedReceipt, body, inspection },
  ];
  for (const value of malformed) {
    const content = JSON.stringify(value);
    expect(compactLinearWrite("save_guided_review", content)).toBe(compactLinearWrite("save_issue", content));
    expect(compactLinearWrite("save_guided_review", content)).not.toContain("untrusted-inspection-sentinel");
    expect(compactLinearWrite("save_guided_review", content)).not.toContain(body);
  }
  for (const [tool, operation] of [
    ["save_guided_review", "reply"],
    ["save_guided_review", "retire"],
    ["post_guided_finding", "save"],
    ["post_guided_finding", "retire"],
    ["post_retire_guided_review", "save"],
    ["post_retire_guided_review", "resolve"],
    ["save_issue", "save"],
    ["post_unrelated_guided_review", "save"],
  ] as const) {
    const content = JSON.stringify({
      ...guidedReceipt,
      operation,
      eventId: operation === "save" ? null : "event-1",
    });
    expect(compactLinearWrite(tool, content)).toBe(compactLinearWrite("save_issue", content));
  }
  const fullRead = JSON.stringify({ ...guidedReceipt, inspection });
  expect(compactLinearWrite("get_guided_review", fullRead)).toBe(fullRead);
});
