import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DeliveryFence, deliveryFingerprint } from "../src/captain/delivery-fence.ts";
import { SeatOutbox } from "../src/captain/seat-outbox.ts";
import { HerdrWatchStore, createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import {
  createRemoteHireReceipts,
  remoteHireReceiptCommand,
  type RemoteHireClaim,
} from "../src/remote-hire-receipts.ts";
import { HireNoLaunchEvidenceSchema, OperatorConversationServiceRequestSchema } from "@clankie/protocol";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function root() {
  const value = await mkdtemp("/tmp/hire-receipts-");
  roots.push(value);
  return value;
}
function claim(): RemoteHireClaim {
  return {
    receiptId: randomUUID(),
    receiptKey: JSON.stringify(["pc", "codex", "C:\\test", "new"]),
    fingerprint: deliveryFingerprint("original brief"),
    nonce: "a".repeat(64),
    target: { fleet: "pc", host: "configured-host", session: "default", shell: "posix" },
  };
}
async function host(
  home: string,
  original: RemoteHireClaim,
  op: "reserve" | "launch" | "seal",
  env: NodeJS.ProcessEnv = {},
) {
  const { stdout } = await exec("/bin/sh", ["-c", remoteHireReceiptCommand(original, op)], {
    env: { ...process.env, ...env, HOME: home },
    timeout: 30_000,
  });
  return JSON.parse(stdout);
}

it("retains the host original, forbids repeat launch and refuses absent or replaced receipt identity", async () => {
  const home = await root();
  const original = claim();
  await expect(host(home, original, "seal")).rejects.toThrow();
  expect(await host(home, original, "reserve")).toEqual({ reserved: true });
  expect(await host(home, original, "launch")).toEqual({ launchCommitted: true });
  await expect(host(home, original, "launch")).rejects.toThrow(/cannot launch again/u);
  await expect(host(home, original, "seal")).rejects.toThrow(/launch boundary/u);
  await expect(host(home, { ...original, fingerprint: "b".repeat(64) }, "seal")).rejects.toThrow(/identity/u);
  const files = await readdir(join(home, ".clankie/hire-receipts"));
  expect(files.filter((name) => name.endsWith(".json"))).toHaveLength(1);
  expect(JSON.parse(await readFile(join(home, ".clankie/hire-receipts", files[0]!), "utf8"))).toMatchObject({
    claim: original,
    state: "launching",
  });
});

it("refuses legacy allocated originals and non-hire IDs without contacting a host or changing receipts", async () => {
  const directory = await root();
  const file = join(directory, "watches.json");
  const original = claim();
  const fence = new DeliveryFence(`${file}.hire-receipts.json`);
  fence.begin(original.receiptKey, {
    messageId: original.receiptId,
    fingerprint: original.fingerprint,
    paneId: "pc/wA:p2",
  });
  const before = await readFile(`${file}.hire-receipts.json`, "utf8");
  const store = new HerdrWatchStore(file);
  try {
    expect(await store.settleHireReceipt(original.receiptId)).toMatchObject({
      state: "refused",
      detail: expect.stringContaining("authority"),
    });
    const authorized = async () => {};
    expect(await store.settleHireReceipt(original.receiptId, authorized)).toMatchObject({
      state: "refused",
      detail: expect.stringContaining("complete no-launch window"),
    });
    expect(await store.settleHireReceipt(randomUUID(), authorized)).toMatchObject({ state: "refused" });
    expect(await readFile(`${file}.hire-receipts.json`, "utf8")).toBe(before);
  } finally {
    store.close();
  }
});

it("operator request accepts only the original UUID, never supplied evidence or a replacement launch", () => {
  const request = { op: "settle_hire_receipt", schemaVersion: 1, receiptId: randomUUID() };
  expect(OperatorConversationServiceRequestSchema.safeParse(request).success).toBe(true);
  expect(OperatorConversationServiceRequestSchema.safeParse({ ...request, evidence: {} }).success).toBe(
    false,
  );
  expect(
    OperatorConversationServiceRequestSchema.safeParse({
      ...request,
      receiptId: "seat-71022bcd-8afe-44cd-9d83-bd71d1ceab42",
    }).success,
  ).toBe(true);
});

it.skipIf(process.platform !== "darwin" || process.env.HIRE_RECEIPT_NATIVE_TEST !== "1")(
  "seals a real Herdr/process census, survives restart, blocks late launch and preserves original evidence",
  async () => {
    const home = await root();
    const original = claim();
    const herdr = await isolatedHerdr(join(home, "logs"));
    // Explicit --session ignores HERDR_SOCKET_PATH; bind this fixture's default namespace.
    await mkdir(join(herdr.root, "config/herdr"), { recursive: true });
    await symlink(herdr.socketPath, join(herdr.root, "config/herdr/herdr.sock"));
    const env = {
      HERDR_SOCKET_PATH: herdr.socketPath,
      HERDR_CONFIG_PATH: join(herdr.root, "config/config.toml"),
      XDG_CONFIG_HOME: join(herdr.root, "config"),
      XDG_STATE_HOME: join(herdr.root, "state"),
      XDG_DATA_HOME: join(herdr.root, "data"),
      XDG_CACHE_HOME: join(herdr.root, "cache"),
      XDG_RUNTIME_DIR: join(herdr.root, "runtime"),
    };
    try {
      await host(home, original, "reserve", env);
      const proof = HireNoLaunchEvidenceSchema.parse(await host(home, original, "seal", env));
      expect(proof.census.panes).toBeGreaterThanOrEqual(2);
      expect(proof.census.processes).toBeGreaterThan(1);
      expect(await host(home, original, "seal", env)).toEqual(proof);
      await expect(host(home, original, "launch", env)).rejects.toThrow(/cannot launch again/u);
      const file = join(home, "local-originals.json");
      const fence = new DeliveryFence(file);
      fence.begin(original.receiptKey, {
        messageId: original.receiptId,
        fingerprint: original.fingerprint,
        remoteAdmission: { target: original.target, nonce: original.nonce },
      });
      fence.settleNotLaunched(original.receiptKey, original.receiptId, proof);
      const restarted = new DeliveryFence(file);
      expect(restarted.settlement(original.receiptId)).toEqual(proof);
      expect(restarted.pending(original.receiptKey)).toBeUndefined();
      expect(restarted.reconcile(original.receiptKey, original.receiptId)).toBe(false);
      expect(() => restarted.begin(original.receiptKey, { fingerprint: "replacement" })).toThrow();
      expect(() => restarted.complete(original.receiptKey, original.receiptId, {})).toThrow();
      const bytes = await readFile(file, "utf8");
      expect(JSON.parse(bytes)[original.receiptKey]).toMatchObject({
        messageId: original.receiptId,
        settlement: proof,
      });
      const committedKey = `${original.receiptKey}-committed`;
      const committed = restarted.begin(committedKey, {
        fingerprint: original.fingerprint,
        remoteAdmission: { target: original.target, nonce: original.nonce },
        remoteLaunchCommitted: true,
      });
      expect(() =>
        restarted.update(committedKey, committed.messageId, { remoteLaunchCommitted: undefined }),
      ).toThrow();
      expect(new DeliveryFence(file).pending(committedKey)?.remoteLaunchCommitted).toBe(true);

      const watches = join(home, "watches.json");
      const receiptsFile = `${watches}.hire-receipts.json`;
      const serviceFence = new DeliveryFence(receiptsFile);
      serviceFence.begin(original.receiptKey, {
        messageId: original.receiptId,
        fingerprint: original.fingerprint,
        remoteAdmission: { target: original.target, nonce: original.nonce },
      });
      const native = createRemoteHireReceipts({
        fleet: async () => ({
          id: "pc",
          session: "default",
          ssh: { host: "configured-host", shell: "posix" },
        }),
        shell: () => async (command) =>
          (
            await exec("/bin/sh", ["-c", command], {
              env: { ...process.env, ...env, HOME: home },
              timeout: 30_000,
            })
          ).stdout,
      });
      const store = new HerdrWatchStore(watches, { remoteHireReceipts: native });
      try {
        const uncertainBytes = await readFile(receiptsFile, "utf8");
        let authorityChecks = 0;
        expect(
          await store.settleHireReceipt(original.receiptId, async () => {
            if (++authorityChecks === 3) throw new Error("operator grant revoked");
          }),
        ).toMatchObject({ state: "refused" });
        expect(authorityChecks).toBe(3);
        expect(await readFile(receiptsFile, "utf8")).toBe(uncertainBytes);
        expect(await store.settleHireReceipt(original.receiptId, async () => {})).toEqual({
          state: "settled-not-launched",
          receiptId: original.receiptId,
          evidence: proof,
        });
        expect(await store.settleHireReceipt(original.receiptId, async () => {})).toEqual({
          state: "settled-not-launched",
          receiptId: original.receiptId,
          evidence: proof,
        });
      } finally {
        store.close();
      }
      // A real host reservation plus a controller's denied preparation crosses the
      // irreversible barrier and must remain uncertain, even with no pane created.
      const deniedPath = join(home, "denied-watches.json");
      let preparationCalls = 0;
      const denied = new HerdrWatchStore(deniedPath, {
        remoteHireReceipts: native,
        remoteWorkspace: async (fleet, cwd) => fleet === "pc" && cwd === home,
        runner: createHerdrWatchRunner(
          undefined,
          async (args) =>
            (
              await exec("herdr", [...args], {
                env: { ...process.env, ...env },
                timeout: 5000,
              })
            ).stdout,
        ),
        nativeLaunchPolicy: {
          admit: async () => {},
          prepare: async () => {
            preparationCalls++;
            throw new Error("Fixture owner denies native preparation");
          },
        },
      });
      try {
        const request = {
          schemaVersion: 1 as const,
          title: "Guarded native fixture",
          harness: "codex" as const,
          fleet: "pc",
          workingDirectory: home,
        };
        expect(await denied.spawnSeat(request)).toMatchObject({
          outcome: "failed",
          reason: "start_unconfirmed",
        });
        const retained = new DeliveryFence(`${deniedPath}.hire-receipts.json`).entries();
        expect(retained).toHaveLength(1);
        expect(retained[0]![1]).toMatchObject({ remoteLaunchCommitted: true });
        expect(retained[0]![1].paneId).toBeUndefined();
        expect(await denied.settleHireReceipt(retained[0]![1].messageId, async () => {})).toMatchObject({
          state: "refused",
        });
        expect(await denied.spawnSeat(request)).toMatchObject({
          outcome: "failed",
          reason: "delivery_unconfirmed",
        });
        expect(preparationCalls).toBe(1);
      } finally {
        denied.close();
      }
      // Golden metadata/body shape is grounded in the real PC channel insertion
      // for seat-71022bcd (2026-10-05), with IDs and content reduced for this fixture.
      const legacy = claim();
      const eventId = `seat-${randomUUID()}`;
      const sessionId = randomUUID();
      const entryId = randomUUID();
      const seatId = "pc/term_original";
      const content = `<channel source="plugin:clankie-worker:clankie" kind="message" conversation="${seatId}" source="captain" event_id="${eventId}" created_at="2026-10-05T03:45:39.633Z">\noriginal brief\n</channel>`;
      const row = {
        type: "user",
        message: { role: "user", content },
        isSidechain: false,
        isMeta: true,
        promptSource: "system",
        origin: { kind: "channel", server: "plugin:clankie-worker:clankie" },
        cwd: home,
        sessionId,
        uuid: entryId,
        timestamp: "2026-10-05T03:45:39.657Z",
      };
      const project = join(home, ".claude/projects", home.replace(/[^a-zA-Z0-9]/gu, "-"));
      await mkdir(project, { recursive: true });
      const transcript = join(project, `${sessionId}.jsonl`);
      const recoveryPath = join(home, "recovery-watches.json");
      const legacyFence = new DeliveryFence(`${recoveryPath}.hire-receipts.json`);
      legacy.receiptKey = JSON.stringify(["pc", "claude", home, "new"]);
      legacyFence.begin(legacy.receiptKey, {
        messageId: legacy.receiptId,
        fingerprint: legacy.fingerprint,
        paneId: "pc/absent-original",
        beforeIds: [],
      });
      const mailboxPath = join(home, "original-mailbox.json");
      new DeliveryFence(`${mailboxPath}.delivered`).begin(eventId, {
        messageId: eventId,
        fingerprint: legacy.fingerprint,
      });
      const mailbox = new SeatOutbox({ uncertaintyPath: mailboxPath });
      const recoveryStore = new HerdrWatchStore(recoveryPath, {
        remoteHireReceipts: native,
        channelReceipt: async (id) => {
          const receipt = mailbox.recoveryReceipt(id);
          return receipt
            ? {
                seatId,
                receipt,
                acknowledged: mailbox.recoveryAcknowledged(id),
                settle: (evidence) => mailbox.settleRecoveredDelivery(id, evidence),
              }
            : undefined;
        },
      });
      try {
        const authorized = async () => {};
        await writeFile(transcript, JSON.stringify({ ...row, isMeta: false }) + "\n");
        expect(await recoveryStore.settleHireReceipt(eventId, authorized, "delivered")).toMatchObject({
          state: "refused",
          detail: expect.stringContaining("native channel origin"),
        });
        await writeFile(
          transcript,
          JSON.stringify(row) + "\n" + JSON.stringify({ ...row, uuid: randomUUID() }) + "\n",
        );
        expect(await recoveryStore.settleHireReceipt(eventId, authorized, "delivered")).toMatchObject({
          state: "refused",
          detail: expect.stringContaining("ambiguous"),
        });
        await writeFile(
          transcript,
          JSON.stringify({
            ...row,
            message: {
              role: "user",
              content: content.replace(
                `event_id="${eventId}"`,
                `event_id="${eventId}" event_id="${eventId}"`,
              ),
            },
          }) + "\n",
        );
        expect(await recoveryStore.settleHireReceipt(eventId, authorized, "delivered")).toMatchObject({
          state: "refused",
          detail: expect.stringContaining("Ambiguous channel attributes"),
        });
        await writeFile(transcript, JSON.stringify({ ...row, sessionId: randomUUID() }) + "\n");
        expect(await recoveryStore.settleHireReceipt(eventId, authorized, "delivered")).toMatchObject({
          state: "refused",
          detail: expect.stringContaining("identity or content"),
        });
        await writeFile(transcript, JSON.stringify({ ...row, isSidechain: true }) + "\n");
        expect(await recoveryStore.settleHireReceipt(eventId, authorized, "delivered")).toMatchObject({
          state: "refused",
          detail: expect.stringContaining("native channel origin"),
        });
        const outside = join(home, "outside.jsonl");
        await writeFile(outside, JSON.stringify(row) + "\n");
        await rm(transcript);
        await symlink(outside, transcript);
        expect(await recoveryStore.settleHireReceipt(eventId, authorized, "delivered")).toMatchObject({
          state: "refused",
          detail: expect.stringContaining("symlink"),
        });
        await rm(transcript);
        await writeFile(transcript, JSON.stringify(row));
        expect(await recoveryStore.settleHireReceipt(eventId, authorized, "delivered")).toMatchObject({
          state: "refused",
          detail: expect.stringContaining("incomplete"),
        });
        await writeFile(transcript, JSON.stringify(row) + "\n");
        const delivered = await recoveryStore.settleHireReceipt(eventId, authorized, "delivered");
        expect(delivered).toMatchObject({
          state: "settled-delivered",
          evidence: {
            disposition: "delivered",
            delivery: { receiptId: eventId, seatId, sessionId, entryId, binding: "historical-native-event" },
            allocation: { present: false },
          },
        });
        expect(await recoveryStore.settleHireReceipt(eventId, authorized, "delivered")).toEqual(delivered);
        expect(new SeatOutbox({ uncertaintyPath: mailboxPath }).recoveryReceipt(eventId)?.settlement).toEqual(
          "evidence" in delivered ? delivered.evidence : undefined,
        );
        expect(
          await recoveryStore.settleHireReceipt(legacy.receiptId, authorized, "abandoned"),
        ).toMatchObject({
          state: "abandoned",
          evidence: { disposition: "abandoned", allocation: { present: false } },
        });
        expect(() =>
          new DeliveryFence(`${recoveryPath}.hire-receipts.json`).update(
            legacy.receiptKey,
            legacy.receiptId,
            { recoveryRequested: undefined },
          ),
        ).toThrow();
        const retained = new DeliveryFence(`${recoveryPath}.hire-receipts.json`);
        expect(retained.settled(legacy.receiptKey)?.messageId).toBe(legacy.receiptId);
        expect(retained.reconcile(legacy.receiptKey, legacy.receiptId)).toBe(false);
        expect(() => retained.begin(legacy.receiptKey, { fingerprint: "replacement" })).toThrow();
        expect(() =>
          retained.update(legacy.receiptKey, legacy.receiptId, { settlement: undefined }),
        ).toThrow();
        const conflict = join(home, "conflicting-mailbox.json");
        new DeliveryFence(conflict).begin(eventId, { messageId: eventId, fingerprint: legacy.fingerprint });
        new DeliveryFence(`${conflict}.delivered`).begin(eventId, {
          messageId: eventId,
          fingerprint: "conflicting-original",
        });
        expect(() => new SeatOutbox({ uncertaintyPath: conflict }).recoveryReceipt(eventId)).toThrow(
          /conflicts/u,
        );
        await writeFile(conflict, "corrupt");
        expect(() => new SeatOutbox({ uncertaintyPath: conflict }).recoveryReceipt(eventId)).toThrow(
          /unreadable/u,
        );
      } finally {
        recoveryStore.close();
        mailbox.close();
      }

      // A corrupt restart never turns retained uncertainty into launch permission.
      await writeFile(file, "corrupt");
      expect(() =>
        new DeliveryFence(file).begin(original.receiptKey, { fingerprint: "replacement" }),
      ).toThrow();
    } finally {
      await herdr.close();
    }
  },
  60_000,
);
