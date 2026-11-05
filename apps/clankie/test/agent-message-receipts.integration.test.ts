import { z } from "zod";
import { DurableReceiptStore } from "../src/durable-receipt-store.ts";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AgentMessageReceipts } from "../src/agent-message-receipts.ts";
import { lookupAgentMessageReceipt } from "../src/agent-message-receipt-service.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const binding = { machineId: "home", seatId: "herdr:t1", instanceId: "native-session-1" };
const input = {
  senderDeviceId: "app-a",
  senderSessionId: "original-session-a",
  requestKey: "original-request",
  agent: "herdr:t1",
  binding,
  message: "Please run the requested check.",
};
const at = "2026-11-04T12:00:00.000Z";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clankie-agent-receipts-"));
  roots.push(root);
  const path = join(root, "receipts.json");
  const receipts = new AgentMessageReceipts(path);
  const begun = receipts.begin(input);
  if (begun.outcome !== "new") throw new Error("Fixture must reserve its original input");
  return { path, receipts, receiptId: begun.receiptId };
}
const authorized = async () => ({
  deviceId: "app-a",
  sessionId: "original-session-a",
  authorizationRevision: "registration-1",
});

it("persists admission before handoff and recovers the original key after restart without replay", async () => {
  const { path, receiptId } = await fixture();
  expect(JSON.parse(await readFile(path, "utf8")).format).toBe("clankie-receipts-v2");
  const restarted = new AgentMessageReceipts(path);
  expect(restarted.begin(input)).toEqual({ outcome: "existing", receiptId });
  expect(restarted.begin({ ...input, message: "Different input" })).toEqual({ outcome: "conflict" });
  expect(restarted.begin({ ...input, binding: { ...binding, instanceId: "replacement" } })).toEqual({
    outcome: "conflict",
  });
  expect(await lookupAgentMessageReceipt(restarted, { receiptId }, authorized)).toMatchObject({
    outcome: "found",
    receipt: { receiptId, delivery: "pending", progress: [] },
  });
  const otherApp = restarted.begin({ ...input, senderDeviceId: "app-b" });
  expect(otherApp.outcome).toBe("new");
  expect(otherApp).not.toHaveProperty("receiptId", receiptId);
});

it("fingerprints attachment content and order rather than staged file paths", async () => {
  const { path } = await fixture();
  const receipts = new AgentMessageReceipts(path);
  const a = { filename: "a.png", mediaType: "image/png", sha256: "a".repeat(64) };
  const b = { filename: "b.png", mediaType: "image/png", sha256: "b".repeat(64) };
  const attached = { ...input, requestKey: "images", attachments: [a, b] };
  expect(receipts.begin(attached).outcome).toBe("new");
  expect(receipts.begin(attached).outcome).toBe("existing");
  expect(receipts.begin({ ...attached, attachments: [b, a] }).outcome).toBe("conflict");
  expect(receipts.begin({ ...attached, attachments: [{ ...a, sha256: "c".repeat(64) }, b] }).outcome).toBe(
    "conflict",
  );
});

it("separates native handoff, exact input pickup and correlated answer across restart", async () => {
  const { path, receipts, receiptId } = await fixture();
  expect(receipts.delivery(receiptId, binding, "queued")).toBe(true);
  expect(receipts.bindNativeMessage(receiptId, binding, "input-1")).toBe(true);
  expect(receipts.delivery(receiptId, binding, "delivered")).toBe(true);
  expect(receipts.observe(receiptId, binding, { type: "turn_started", at, messageId: "input-1" })).toBe(true);
  const restarted = new AgentMessageReceipts(path);
  expect(
    restarted.observe(receiptId, binding, {
      type: "turn_completed",
      at,
      messageId: "input-1",
      nativeTurnId: "native-turn-1",
      ok: true,
      text: "The check passed.",
    }),
  ).toBe(true);
  const result = await lookupAgentMessageReceipt(new AgentMessageReceipts(path), { receiptId }, authorized);
  expect(result.outcome).toBe("found");
  if (result.outcome !== "found") throw new Error("Missing original receipt");
  expect(result.receipt.progress.map((entry) => entry.stage)).toEqual([
    "queued",
    "delivered",
    "read",
    "acted_on",
    "answered",
  ]);
  expect(result.receipt.progress.every((entry) => Number.isFinite(entry.observedAt))).toBe(true);
  expect(result.receipt.progress.find((entry) => entry.stage === "read")).toMatchObject({
    occurredAt: at,
    evidence: "native_turn_started",
  });
  expect(JSON.stringify(result)).not.toContain("The check passed.");
  expect(restarted.begin(input)).toEqual({ outcome: "existing", receiptId });
});

it("never infers progress from an unbound run, a different message, matching text or an uncorrelated stop", async () => {
  const { receipts, receiptId } = await fixture();
  const completion = {
    type: "turn_completed" as const,
    at,
    messageId: "service-run-1",
    ok: true,
    text: input.message,
  };
  expect(receipts.observe(receiptId, binding, completion)).toBe(false);
  receipts.bindNativeMessage(receiptId, binding, "input-1");
  expect(receipts.observe(receiptId, binding, completion)).toBe(false);
  expect(receipts.observe(receiptId, binding, { type: "turn_started", at })).toBe(false);
  expect(
    receipts.observe(receiptId, binding, {
      type: "settlement_unconfirmed",
      at,
      reason: "message_correlation_unavailable",
      observedStop: { at, ok: true, text: input.message },
    }),
  ).toBe(false);
  expect(receipts.lookup(receiptId, "app-a", "original-session-a")).toMatchObject({
    outcome: "found",
    receipt: { delivery: "pending", progress: [] },
  });
});

it("refuses replacement occupants and re-binding even when a pane and message ID match", async () => {
  const { receipts, receiptId } = await fixture();
  const replacement = { ...binding, instanceId: "native-session-2" };
  expect(receipts.bindNativeMessage(receiptId, replacement, "input-1")).toBe(false);
  expect(receipts.bindNativeMessage(receiptId, binding, "input-1")).toBe(true);
  expect(receipts.bindNativeMessage(receiptId, binding, "input-2")).toBe(false);
  expect(receipts.delivery(receiptId, replacement, "delivered")).toBe(false);
  expect(
    receipts.observe(receiptId, replacement, {
      type: "turn_completed",
      messageId: "input-1",
      at,
      ok: true,
      text: "answer",
    }),
  ).toBe(false);
  expect(receipts.lookup(receiptId, "app-a", "original-session-a")).toMatchObject({
    receipt: { progress: [] },
  });
});

it("does not invent a read timestamp or an answer from a successful completion with no text", async () => {
  const { receipts, receiptId } = await fixture();
  receipts.bindNativeMessage(receiptId, binding, "input-1");
  expect(
    receipts.observe(receiptId, binding, { type: "turn_completed", messageId: "input-1", at, ok: true }),
  ).toBe(true);
  expect(receipts.lookup(receiptId, "app-a", "original-session-a")).toMatchObject({
    receipt: { progress: [{ stage: "acted_on", occurredAt: at }] },
  });
  expect(receipts.delivery(receiptId, binding, "uncertain")).toBe(false);
});

it("hides receipt existence from other apps and rejects request-supplied sender or inspection scope", async () => {
  const { receipts, receiptId } = await fixture();
  expect(
    await lookupAgentMessageReceipt(receipts, { receiptId }, async () => ({
      deviceId: "app-b",
      authorizationRevision: "1",
    })),
  ).toEqual({ outcome: "unknown" });
  expect(await lookupAgentMessageReceipt(receipts, { receiptId }, async () => undefined)).toEqual({
    outcome: "unknown",
  });
  await expect(
    lookupAgentMessageReceipt(receipts, { receiptId, senderDeviceId: "app-a" }, authorized),
  ).rejects.toThrow();
  await expect(lookupAgentMessageReceipt(receipts, { receiptId, owner: true }, authorized)).rejects.toThrow();
});

it("rechecks authorization after reading and refuses revoked, downgraded or replaced callers", async () => {
  const { receipts, receiptId } = await fixture();
  for (const changed of [
    undefined,
    { deviceId: "app-a", sessionId: "original-session-a", authorizationRevision: "downgraded" },
    { deviceId: "app-b", authorizationRevision: "registration-1" },
  ]) {
    let reads = 0;
    const result = await lookupAgentMessageReceipt(receipts, { receiptId }, async () =>
      ++reads === 1 ? authorized() : changed,
    );
    expect(reads).toBe(2);
    expect(result).toEqual({ outcome: "unknown" });
  }
});

it("lookup neither writes nor changes revisions and journal damage fails closed", async () => {
  const { receipts, path, receiptId } = await fixture();
  const manifest = await readFile(path, "utf8");
  const first = await lookupAgentMessageReceipt(receipts, { receiptId }, authorized);
  expect(await lookupAgentMessageReceipt(receipts, { receiptId }, authorized)).toEqual(first);
  expect(await readFile(path, "utf8")).toBe(manifest);
  await writeFile(path, "broken journal");
  expect(await lookupAgentMessageReceipt(receipts, { receiptId }, authorized)).toEqual({
    outcome: "unavailable",
  });
  expect(() => receipts.begin(input)).toThrow(/unreadable/u);
});

it("captures the original authorization even when the registry updates its object in place", async () => {
  const { receipts, receiptId } = await fixture();
  const registration = {
    deviceId: "app-a",
    sessionId: "original-session-a",
    authorizationRevision: "registration-1",
  };
  let reads = 0;
  expect(
    await lookupAgentMessageReceipt(receipts, { receiptId }, async () => {
      if (++reads === 2) registration.authorizationRevision = "downgraded";
      return registration;
    }),
  ).toEqual({ outcome: "unknown" });
});

it("scrubs legacy raw replay generations without assigning their receipts to a new session", async () => {
  const { path, receiptId } = await fixture();
  const old = new DurableReceiptStore({
    path,
    sharded: true,
    unreadableMessage: "Fixture ledger unreadable",
    schema: z
      .object({
        id: z.string(),
        createdAt: z.number(),
        state: z.enum(["uncertain", "settled"]),
        result: z.unknown().optional(),
      })
      .passthrough(),
  });
  const record = old.load().get(receiptId)!;
  delete record.storageVersion;
  delete record.senderSessionId;
  const canary = "PRIVATE_NATIVE_DETAIL_CANARY sk-proj-" + "x".repeat(100);
  record.sendResult = {
    schemaVersion: 1,
    status: "accepted",
    conversationId: "conversation-fixture",
    runId: "run-fixture",
    revision: 1,
    safeCursor: "0000000000000000",
    seatDelivery: { state: "queued", detail: canary },
  };
  old.save();
  const orphan = "ab-" + "c".repeat(64) + ".json";
  await writeFile(join(path + ".d", orphan), canary);
  const restarted = new AgentMessageReceipts(path);
  expect(restarted.lookup(receiptId, "app-a", "original-session-a")).toEqual({ outcome: "unknown" });
  expect(restarted.begin(input)).toEqual({ outcome: "conflict" });
  expect(restarted.inspectAsOwner(receiptId).outcome).toBe("found");
  const files = [path, ...(await readdir(path + ".d")).map((name) => join(path + ".d", name))];
  expect((await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n")).not.toContain(
    "PRIVATE_NATIVE_DETAIL_CANARY",
  );
  expect(new AgentMessageReceipts(path).begin(input)).toEqual({ outcome: "conflict" });
});
