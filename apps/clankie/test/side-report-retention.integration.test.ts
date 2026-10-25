import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationStore } from "../src/captain/conversations.ts";
import { deliveryFingerprint } from "../src/captain/delivery-fence.ts";

// VUH-2831: startup retires side forks with nothing unread. Storage it cannot
// read must never count as that proof.
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function open(directory: string, sharded = true) {
  const args: ConstructorParameters<typeof ConversationStore> = [directory, async () => {}];
  args[13] = () => sharded;
  return new ConversationStore(...args);
}

/** A real admission's committed files, renamed into a side fork of a fresh default. */
async function sideFork(options: { sharded?: boolean; read?: boolean; side?: boolean } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "side-report-retention-")));
  roots.push(root);
  const directory = join(root, "conversations");
  const producer = open(directory, options.sharded ?? true);
  const deliveryId = randomUUID();
  producer.submitInbound("side report", {
    deliveryId,
    binding: "a".repeat(64),
    paneId: "fixture-pane",
    text: "side report",
    fingerprint: deliveryFingerprint("side report"),
    recipient: { kind: "conversation", owner: { conversationId: "global-default" } },
  });
  if (options.read) {
    producer.readInboundReports("global-default", { limit: 1 });
    expect(producer.acknowledgeInboundReports("global-default", [deliveryId])).toBe(true);
  }
  await producer.close();
  if (options.side === false) {
    const side = join(directory, "global-default");
    const path = join(side, "meta.json");
    return { directory, side, path, deliveryId, meta: () => JSON.parse(fs.readFileSync(path, "utf8")) };
  }
  const side = join(directory, "side-conversation");
  fs.renameSync(join(directory, "global-default"), side);
  const path = join(side, "meta.json");
  const meta = JSON.parse(fs.readFileSync(path, "utf8"));
  fs.writeFileSync(
    path,
    JSON.stringify({
      ...meta,
      conversationId: "side-conversation",
      parentConversationId: "global-default",
      isDefault: false,
    }),
  );
  return { directory, side, path, deliveryId, meta: () => JSON.parse(fs.readFileSync(path, "utf8")) };
}

function snapshot(directory: string): Record<string, string> {
  return Object.fromEntries(
    (fs.readdirSync(directory, { recursive: true, withFileTypes: true }) as fs.Dirent[])
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = join(entry.parentPath, entry.name);
        return [file.slice(directory.length), fs.readFileSync(file, "base64")];
      }),
  );
}

/** Startup and a reopen succeed, keep every byte of the side fork and say why. */
async function expectRetained(fork: Awaited<ReturnType<typeof sideFork>>, reason: string | RegExp) {
  const before = snapshot(fork.side);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  for (let boot = 0; boot < 2; boot += 1) {
    warn.mockClear();
    const store = open(fork.directory);
    try {
      expect(snapshot(fork.side)).toEqual(before);
      expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toMatch(reason);
      expect(store.inboundReports("side-conversation")).toEqual([]);
    } finally {
      await store.close();
    }
    expect(snapshot(fork.side)).toEqual(before);
  }
}

/**
 * Stands in for a later reader's ledger beside recognized receipts: another
 * real unread admission's shards, referenced from a field or a file this
 * reader does not know.
 */
async function futureLedger(fork: Awaited<ReturnType<typeof sideFork>>, kind: "field" | "file") {
  const future = await sideFork();
  const manifest = future.meta().inboundReportStore;
  fs.mkdirSync(join(fork.side, "inbound-reports"), { recursive: true });
  const shards = (Object.values(manifest.shards) as string[]).map((file) => {
    const target = join(fork.side, "inbound-reports", file);
    fs.copyFileSync(join(future.side, "inbound-reports", file), target);
    return target;
  });
  if (kind === "field")
    fs.writeFileSync(fork.path, JSON.stringify({ ...fork.meta(), inboundReportLedger: manifest }));
  else fs.writeFileSync(join(fork.side, "inbound-reports", "manifest.json"), JSON.stringify(manifest));
  const bytes = () => shards.map((file) => fs.readFileSync(file, "base64"));
  return { manifest, bytes, before: bytes() };
}

it("keeps a side fork's unread sharded reports through startup", async () => {
  const fork = await sideFork();
  expect(Object.keys(fork.meta().inboundReportStore.shards)).toHaveLength(1);
  const store = open(fork.directory);
  try {
    expect(fs.existsSync(fork.side)).toBe(true);
    expect(store.inboundReports("side-conversation")).toMatchObject([
      { deliveryId: fork.deliveryId, text: "side report" },
    ]);
  } finally {
    await store.close();
  }
});

it("keeps a side fork whose report manifest is a future version", async () => {
  const fork = await sideFork();
  const meta = fork.meta();
  fs.writeFileSync(
    fork.path,
    JSON.stringify({ ...meta, inboundReportStore: { ...meta.inboundReportStore, version: 2 } }),
  );
  await expectRetained(fork, /inbound reports are unreadable/u);
});

it("keeps a side fork whose report manifest or shard is corrupt", async () => {
  const manifest = await sideFork();
  fs.writeFileSync(
    manifest.path,
    JSON.stringify({ ...manifest.meta(), inboundReportStore: { version: 1, shards: "x" } }),
  );
  await expectRetained(manifest, /inbound reports are unreadable/u);

  const shard = await sideFork();
  const file = String(Object.values(shard.meta().inboundReportStore.shards)[0]);
  fs.writeFileSync(join(shard.side, "inbound-reports", file), "corrupt");
  await expectRetained(shard, /inbound reports are unreadable/u);

  const missing = await sideFork();
  fs.rmSync(
    join(missing.side, "inbound-reports", String(Object.values(missing.meta().inboundReportStore.shards)[0])),
  );
  await expectRetained(missing, /inbound reports are unreadable/u);
});

it("keeps a side fork whose reports live in storage this reader does not know", async () => {
  // The pre-C2 failure: the reader saw no inline map and removed the shards.
  const field = await sideFork();
  const { inboundReportStore, ...rest } = field.meta();
  fs.writeFileSync(field.path, JSON.stringify({ ...rest, inboundReportLedger: inboundReportStore }));
  await expectRetained(field, /unrecognized report field inboundReportLedger/u);

  const file = await sideFork();
  const { inboundReportStore: manifest, ...bare } = file.meta();
  fs.writeFileSync(file.path, JSON.stringify(bare));
  fs.writeFileSync(join(file.side, "inbound-reports", "manifest.json"), JSON.stringify(manifest));
  await expectRetained(file, /unrecognized report storage manifest\.json/u);
});

it("still retires a recognized side fork with nothing unread", async () => {
  const sharded = await sideFork({ read: true });
  expect(fs.readdirSync(join(sharded.side, "inbound-reports"))).toHaveLength(1);
  // An uncommitted prepared shard admits nothing and does not block cleanup.
  fs.writeFileSync(join(sharded.side, "inbound-reports", `ff-${"0".repeat(64)}.json`), "{}");
  const legacy = await sideFork({ sharded: false, read: true });
  expect(Object.values(legacy.meta().inboundAcceptances)).toMatchObject([
    { reportDelivery: { state: "read" } },
  ]);
  const empty = await sideFork({ read: true });
  const { inboundReportStore: _, ...bare } = empty.meta();
  fs.writeFileSync(empty.path, JSON.stringify(bare));
  fs.rmSync(join(empty.side, "inbound-reports"), { recursive: true });
  for (const fork of [sharded, legacy, empty]) {
    const store = open(fork.directory);
    try {
      expect(fs.existsSync(fork.side)).toBe(false);
    } finally {
      await store.close();
    }
  }
});

it.each([
  [false, "field"],
  [true, "field"],
  [false, "file"],
  [true, "file"],
] as const)(
  "keeps every byte of a side fork mixing recognized receipts (sharded %s) with an unknown %s ledger",
  async (sharded, kind) => {
    const fork = await sideFork({ sharded, read: true });
    await futureLedger(fork, kind);
    await expectRetained(fork, /unrecognized report (field|storage)/u);
  },
);

it.each([
  [false, "field"],
  [true, "field"],
  [false, "file"],
  [true, "file"],
] as const)(
  "never collects an unknown ledger's shards from a live inbox (sharded %s, unknown %s)",
  async (sharded, kind) => {
    const inbox = await sideFork({ sharded, read: true, side: false });
    const ledger = await futureLedger(inbox, kind);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let boot = 0; boot < 2; boot += 1) {
      const store = open(inbox.directory);
      try {
        expect(store.inboundReports("global-default", { includeRead: true })).toHaveLength(boot + 1);
        // A new admission commits a manifest, which would sweep unreferenced shards.
        const deliveryId = randomUUID();
        store.submitInbound("later report", {
          deliveryId,
          binding: "a".repeat(64),
          paneId: "fixture-pane",
          text: "later report",
          fingerprint: deliveryFingerprint("later report"),
          recipient: { kind: "conversation", owner: { conversationId: "global-default" } },
        });
      } finally {
        await store.close();
      }
      expect(ledger.bytes()).toEqual(ledger.before);
      if (kind === "field") expect(inbox.meta().inboundReportLedger).toEqual(ledger.manifest);
      else
        expect(
          JSON.parse(fs.readFileSync(join(inbox.side, "inbound-reports", "manifest.json"), "utf8")),
        ).toEqual(ledger.manifest);
    }
  },
);

it("still refuses to boot past an unreadable inbox that is not a side fork", async () => {
  const inbox = await sideFork({ side: false });
  const file = String(Object.values(inbox.meta().inboundReportStore.shards)[0]);
  fs.writeFileSync(join(inbox.side, "inbound-reports", file), "corrupt");
  expect(() => open(inbox.directory)).toThrow("Retained inbound reports are unreadable");
});
