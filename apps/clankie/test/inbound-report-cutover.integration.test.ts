import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createUpdateJournal } from "../../tui/bin/runtime-updater.ts";
import { writeRuntimeUpdate, type RuntimeUpdateResult } from "../../tui/bin/runtime-update.ts";
import { writePrivateJson } from "../../tui/bin/update-files.ts";
import type { InboundAcceptance } from "../src/captain/conversations/types.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { createInboundReportMigrationGate } from "../src/captain/conversations/inbound-report-migration.ts";
import { deliveryFingerprint } from "../src/captain/delivery-fence.ts";
import { readPersistedConversation } from "./support/persisted-conversation.ts";

vi.mock("node:fs", async (original) => ({ ...(await original<typeof import("node:fs")>()) }));
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "inbound-report-cutover-")));
  roots.push(root);
  const runtime = {
    root: join(root, "runtime"),
    commit: "b".repeat(40),
    instanceId: randomUUID(),
    pid: process.pid,
  };
  fs.mkdirSync(runtime.root);
  const journal = createUpdateJournal(root, runtime, () => ({ root: runtime.root, commit: runtime.commit }));
  journal.initialize();
  fs.mkdirSync(journal.lock, { mode: 0o700 });
  const id = randomUUID();
  writePrivateJson(join(journal.lock, "operation.json"), { id });
  fs.mkdirSync(join(journal.updates, id), { mode: 0o700 });
  writePrivateJson(join(journal.updates, "latest.json"), { id });
  const result: RuntimeUpdateResult = {
    id,
    ref: "main",
    oldCommit: "a".repeat(40),
    newCommit: runtime.commit,
    phase: "restarting",
    updatedAt: new Date().toISOString(),
  };
  const record = (fields: Partial<RuntimeUpdateResult>) =>
    writeRuntimeUpdate(join(journal.updates, id), { ...result, ...fields });
  record({});
  const healthy = {
    phase: "healthy" as const,
    healthy: true,
    serviceReceipts: [{ ok: true, services: [{ id: "clankie", ok: true }], runtime }],
    canary: { state: "pending" as const },
  };
  const gate = () =>
    createInboundReportMigrationGate({
      updater: { runtime, status: journal.status },
      updatesDirectory: journal.updates,
      operation: id,
    });
  const directory = join(root, "conversations");
  const store = (ready: () => boolean) => {
    const args: ConstructorParameters<typeof ConversationStore> = [directory, async () => {}];
    args[13] = ready;
    return new ConversationStore(...args);
  };
  return { root, runtime, journal, id, record, healthy, gate, directory, store };
}
async function legacyInbox(f: ReturnType<typeof fixture>) {
  const producer = f.store(() => false);
  const id = randomUUID();
  producer.submitInbound("retained report", {
    deliveryId: id,
    binding: "a".repeat(64),
    paneId: "fixture-pane",
    text: "retained report",
    fingerprint: deliveryFingerprint("retained report"),
    recipient: { kind: "conversation", owner: { conversationId: "global-default" } },
  });
  await producer.close();
  const path = join(f.directory, "global-default", "meta.json");
  const meta = readPersistedConversation(path);
  // A historical inbox produced from a real admission, not thousands of live fsyncs.
  const receipt = meta.inboundAcceptances[id];
  meta.inboundAcceptances = Object.fromEntries(
    Array.from({ length: 2753 }, () => {
      const deliveryId = randomUUID();
      return [
        deliveryId,
        {
          ...receipt,
          deliveryId,
          runId: randomUUID(),
          reportDelivery: { state: "uncertain", stage: "uncertain" },
        },
      ];
    }),
  );
  fs.writeFileSync(path, JSON.stringify(meta));
  return { path, entries: meta.inboundAcceptances as Record<string, InboundAcceptance> };
}

it("retains the entire legacy inbox and side directory through a failed initial cutover", async () => {
  const f = fixture();
  const { path, entries } = await legacyInbox(f);
  const child = join(f.directory, "side-conversation");
  fs.mkdirSync(child);
  const meta = JSON.parse(fs.readFileSync(path, "utf8"));
  const childId = randomUUID();
  fs.writeFileSync(
    join(child, "meta.json"),
    JSON.stringify({
      ...meta,
      conversationId: "side-conversation",
      parentConversationId: "global-default",
      isDefault: false,
      inboundAcceptances: {
        [childId]: { ...Object.values(entries)[0]!, deliveryId: childId, runId: randomUUID() },
      },
    }),
  );
  const store = f.store(f.gate());
  try {
    expect(store.inboundReports("global-default", { includeRead: true })).toHaveLength(2753);
    expect(JSON.parse(fs.readFileSync(path, "utf8")).inboundAcceptances).toEqual(entries);
    expect(JSON.parse(fs.readFileSync(path, "utf8")).inboundReportStore).toBeUndefined();
    f.record({ phase: "failed", healthy: false, reason: "cutover-failed" });
    store.readInboundReports("global-default", { limit: 1 });
    expect(Object.keys(JSON.parse(fs.readFileSync(path, "utf8")).inboundAcceptances)).toHaveLength(2753);
    expect(fs.existsSync(child)).toBe(true);
    expect(fs.existsSync(join(f.directory, "global-default", "inbound-reports"))).toBe(false);
  } finally {
    await store.close();
  }
  const restarted = f.store(f.gate());
  try {
    expect(restarted.inboundReports("global-default", { includeRead: true })).toHaveLength(2753);
    expect(restarted.inboundReports("side-conversation")).toHaveLength(1);
    expect(fs.existsSync(child)).toBe(true);
  } finally {
    await restarted.close();
  }
});

it("migrates only after matching healthy journal evidence is synced, preserving every receipt", async () => {
  const f = fixture();
  const { path } = await legacyInbox(f);
  const gate = f.gate();
  const store = f.store(gate);
  try {
    // Another boot's healthy receipt cannot authorize this boot's migration.
    f.record({
      ...f.healthy,
      serviceReceipts: [
        { ...f.healthy.serviceReceipts[0]!, runtime: { ...f.runtime, instanceId: randomUUID() } },
      ],
    });
    expect(gate()).toBe(false);
    f.record(f.healthy);
    const fault = vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
      throw new Error("healthy marker sync failed");
    });
    expect(gate()).toBe(false);
    fault.mockRestore();
    expect(JSON.parse(fs.readFileSync(path, "utf8")).inboundReportStore).toBeUndefined();
    store.readInboundReports("global-default", { limit: 1 });
    const migrated = JSON.parse(fs.readFileSync(path, "utf8"));
    expect(migrated.inboundAcceptances).toBeUndefined();
    expect(Object.keys(migrated.inboundReportStore.shards).length).toBeGreaterThan(0);
    expect(store.inboundReports("global-default", { includeRead: true })).toHaveLength(2753);
    expect(Object.keys(readPersistedConversation(path).inboundAcceptances)).toHaveLength(2753);
  } finally {
    await store.close();
  }
  const restarted = f.store(f.gate());
  try {
    expect(restarted.inboundReports("global-default", { includeRead: true })).toHaveLength(2753);
  } finally {
    await restarted.close();
  }
});
