import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { HireRecoveryEvidenceSchema, SpawnOperatorSeatSchema } from "@clankie/protocol";
import { DeliveryFence, deliveryFingerprint } from "../src/captain/delivery-fence.ts";
import type { ConversationOwner } from "../src/captain/conversation-owner.ts";
import { ProjectHires } from "../src/captain/project-hires.ts";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";

// Actual authenticated PC recovery, reduced only by the existing public evidence artifact.
const live = JSON.parse(
  await readFile(
    new URL(
      "../../../docs/testing/2026-10-06-remote-native-channels/live/72c1571a/original-failed-hire-abandoned.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const proof = HireRecoveryEvidenceSchema.parse(live.evidence);
if (!("paneId" in proof.allocation)) throw new Error("PC golden must retain its mapped original allocation");
const originalPane = proof.allocation.paneId;
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp("/tmp/fresh-hire-");
  roots.push(root);
  const path = join(root, "receipts.json");
  const fence = new DeliveryFence(path);
  fence.begin(proof.receiptKey, {
    messageId: proof.receiptId,
    fingerprint: proof.fingerprint,
    paneId: originalPane,
    remoteLaunchCommitted: true,
  });
  fence.settleRecovery(proof.receiptKey, proof.receiptId, proof);
  const input = SpawnOperatorSeatSchema.parse({
    schemaVersion: 1,
    fleet: "pc",
    harness: "codex",
    title: "Ada",
    workingDirectory: JSON.parse(proof.receiptKey)[2],
    role: "tester",
    freshIntent: { id: randomUUID(), afterReceiptId: proof.receiptId },
  });
  const owner = { conversationId: "fresh-owner" };
  const fingerprint = deliveryFingerprint("Explicit new PC acceptance brief");
  return { fence, path, input, owner, fingerprint };
}

it("binds an explicit fresh admission to a retained native settlement, rejecting aliases, missing proof and replay", async () => {
  const f = await fixture();
  const before = await readFile(f.path, "utf8");
  const accepted = f.fence.freshHireAdmission(proof.receiptKey, f.input, f.owner, f.fingerprint);
  expect(accepted.target).toEqual(proof.target);
  expect(accepted.key).not.toBe(proof.receiptKey);
  expect(accepted.metadata.owner).toEqual(f.owner);
  expect(() =>
    f.fence.freshHireAdmission(
      proof.receiptKey,
      { ...f.input, freshIntent: { ...f.input.freshIntent!, id: proof.receiptId } },
      f.owner,
      f.fingerprint,
    ),
  ).toThrow(/UUID/u);
  expect(() => f.fence.freshHireAdmission(proof.receiptKey, f.input, f.owner, proof.fingerprint)).toThrow(
    /replay/u,
  );
  expect(() =>
    f.fence.freshHireAdmission(
      proof.receiptKey,
      { ...f.input, freshIntent: { ...f.input.freshIntent!, afterReceiptId: randomUUID() } },
      f.owner,
      f.fingerprint,
    ),
  ).toThrow(/settled native/u);
  expect(() =>
    f.fence.freshHireAdmission(
      JSON.stringify(["pc", "codex", "elsewhere", "new"]),
      f.input,
      f.owner,
      f.fingerprint,
    ),
  ).toThrow(/location/u);
  expect(() =>
    f.fence.freshHireAdmission(proof.receiptKey, { ...f.input, resume: "pc:saved" }, f.owner, f.fingerprint),
  ).toThrow(/resume/u);
  for (const freshIntent of [
    { ...f.input.freshIntent, id: f.input.freshIntent!.id.toUpperCase() },
    { ...f.input.freshIntent, afterReceiptId: proof.receiptId.toUpperCase() },
    { ...f.input.freshIntent, owner: f.owner },
    { ...f.input.freshIntent, id: "not-an-id" },
  ])
    expect(SpawnOperatorSeatSchema.safeParse({ ...f.input, freshIntent }).success).toBe(false);
  expect(await readFile(f.path, "utf8")).toBe(before);
});

it("a restarted journal permits only exact same-ID inspection while any sibling remains uncertain", async () => {
  const f = await fixture();
  const a = f.fence.freshHireAdmission(proof.receiptKey, f.input, f.owner, f.fingerprint);
  const pending = f.fence.begin(a.key, { fingerprint: f.fingerprint, freshHire: a.metadata });
  const restarted = new DeliveryFence(f.path);
  const bytes = await readFile(f.path, "utf8");
  expect(restarted.freshHireAdmission(proof.receiptKey, f.input, f.owner, f.fingerprint).key).toBe(a.key);
  expect(
    restarted.freshHireAdmission(proof.receiptKey, { ...f.input, chrome: undefined }, f.owner, f.fingerprint)
      .key,
  ).toBe(a.key);
  for (const input of [
    { ...f.input, title: "Another name" },
    { ...f.input, model: "other-model" },
    { ...f.input, placement: "split" as const, pipeline: "different" },
    { ...f.input, projectId: "other" },
  ])
    expect(() => restarted.freshHireAdmission(proof.receiptKey, input, f.owner, f.fingerprint)).toThrow(
      /UUID/u,
    );
  expect(() =>
    restarted.freshHireAdmission(proof.receiptKey, f.input, { conversationId: "other" }, f.fingerprint),
  ).toThrow(/UUID/u);
  expect(() =>
    restarted.freshHireAdmission(proof.receiptKey, f.input, f.owner, deliveryFingerprint("changed")),
  ).toThrow(/UUID/u);
  expect(() =>
    restarted.freshHireAdmission(
      proof.receiptKey,
      { ...f.input, freshIntent: { ...f.input.freshIntent!, id: randomUUID() } },
      f.owner,
      deliveryFingerprint("second brief"),
    ),
  ).toThrow(/unresolved/u);
  expect(() => restarted.update(a.key, pending.messageId, { fingerprint: "replacement" })).toThrow();
  // Runtime callers can bypass TypeScript's exact optional property guard.
  expect(() =>
    Reflect.apply(restarted.update, restarted, [a.key, pending.messageId, { fingerprint: undefined }]),
  ).toThrow();
  expect(() => restarted.update(a.key, pending.messageId, { freshHire: undefined })).toThrow();
  expect(await readFile(f.path, "utf8")).toBe(bytes);
  expect(restarted.settlement(proof.receiptId)).toEqual(proof);
});

it("retains successful and proven failed fresh identities through reconciliation, restart and age pruning", async () => {
  const f = await fixture();
  const a = f.fence.freshHireAdmission(proof.receiptKey, f.input, f.owner, f.fingerprint);
  const receipt = f.fence.begin(a.key, { fingerprint: f.fingerprint, freshHire: a.metadata });
  expect(f.fence.reconcile(a.key, receipt.messageId)).toBe(true);
  const disk = JSON.parse(await readFile(f.path, "utf8"));
  disk[a.key].completed.at = 0;
  await writeFile(f.path, JSON.stringify(disk));
  const restarted = new DeliveryFence(f.path);
  restarted.begin("unrelated expired-record-pruning", { fingerprint: "unrelated" });
  expect(restarted.completed(a.key)?.messageId).toBe(receipt.messageId);
  expect(() => restarted.begin(a.key, { fingerprint: f.fingerprint })).toThrow();
  expect(() =>
    restarted.freshHireAdmission(
      proof.receiptKey,
      { ...f.input, freshIntent: { ...f.input.freshIntent!, id: randomUUID() } },
      f.owner,
      f.fingerprint,
    ),
  ).toThrow(/replay/u);
  const b = restarted.freshHireAdmission(
    proof.receiptKey,
    { ...f.input, title: "Bea", freshIntent: { ...f.input.freshIntent!, id: randomUUID() } },
    f.owner,
    deliveryFingerprint("Second independent acceptance"),
  );
  const failed = restarted.begin(b.key, {
    fingerprint: deliveryFingerprint("Second independent acceptance"),
    freshHire: b.metadata,
  });
  restarted.complete(b.key, failed.messageId, { deliveryStage: "unavailable" });
  expect(restarted.reconcile(b.key, failed.messageId)).toBe(true);
  const again = new DeliveryFence(f.path);
  expect(again.completed(b.key)?.completed?.deliveryStage).toBe("unavailable");
  expect(again.settlement(proof.receiptId)).toEqual(proof);
  expect(again.reconcile(proof.receiptKey, proof.receiptId)).toBe(false);
});

it("keeps Discord actor/route binding while allowing independently authorized later messages", async () => {
  const f = await fixture();
  const owner: ConversationOwner = {
    conversationId: "room",
    discord: {
      baseSessionKey: "room-base",
      targetId: "room",
      actorId: "owner",
      channelId: "channel",
      messageId: "first",
      deliveryId: "delivery-first",
      transportKind: "bot",
    },
  };
  const a = f.fence.freshHireAdmission(proof.receiptKey, f.input, owner, f.fingerprint);
  f.fence.begin(a.key, { fingerprint: f.fingerprint, freshHire: a.metadata });
  const later = {
    ...owner,
    discord: { ...owner.discord!, messageId: "later", deliveryId: "delivery-later" },
  };
  expect(f.fence.freshHireAdmission(proof.receiptKey, f.input, later, f.fingerprint).key).toBe(a.key);
  expect(() =>
    f.fence.freshHireAdmission(
      proof.receiptKey,
      f.input,
      { ...later, discord: { ...later.discord, actorId: "other" } },
      f.fingerprint,
    ),
  ).toThrow(/UUID/u);
  expect(() =>
    f.fence.freshHireAdmission(
      proof.receiptKey,
      f.input,
      { ...later, discord: { ...later.discord, transportKind: "user_session" } },
      f.fingerprint,
    ),
  ).toThrow(/UUID/u);
});

it("a corrupt native journal cannot admit a new UUID", async () => {
  const f = await fixture();
  await writeFile(f.path, "truncated original");
  expect(() =>
    new DeliveryFence(f.path).freshHireAdmission(proof.receiptKey, f.input, f.owner, f.fingerprint),
  ).toThrow(/unreadable/u);
});

it("project allocation recovery cannot substitute a fresh identity or changed effective launch", async () => {
  const f = await fixture();
  const settings = ProjectsSettingsSchema.parse({
    projects: [
      { id: "clankie", name: "Clankie", roles: [{ role: "tester", harness: "codex", model: "owner-model" }] },
    ],
  });
  const allocations = new ProjectHires(`${f.path}.projects`);
  const first = allocations.reserve(settings, "clankie", f.input);
  expect(allocations.reserve(settings, "clankie", { ...f.input, model: "owner-model" })).toMatchObject({
    id: first.id,
    reused: true,
  });
  for (const request of [
    { ...f.input, freshIntent: undefined },
    { ...f.input, freshIntent: { ...f.input.freshIntent!, id: randomUUID() } },
    { ...f.input, model: "changed-model" },
    { ...f.input, title: "Changed name" },
    { ...f.input, placement: "split" as const, pipeline: "changed" },
  ])
    expect(() => allocations.reserve(settings, "clankie", request)).toThrow(/different intent or launch/u);
  expect(allocations.reserve(settings, "clankie", f.input)).toMatchObject({ id: first.id, reused: true });
});
