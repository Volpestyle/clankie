import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DeliveryFence, deliveryFingerprint } from "../src/captain/delivery-fence.ts";
import { SeatOutbox } from "../src/captain/seat-outbox.ts";
import { createRemoteCodexSeatAdapter } from "../src/captain/remote-codex-app-server.ts";
import { HerdrWatchStore, createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import {
  createRemoteHireReceipts,
  remoteHireReceiptCommand,
  type RemoteHireClaim,
} from "../src/remote-hire-receipts.ts";
import {
  HireNoLaunchEvidenceSchema,
  OperatorConversationServiceRequestSchema,
  OperatorConversationServiceResultSchema,
} from "@clankie/protocol";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { runHireReceiptCommand } from "../../tui/src/command/hire-receipt.ts";

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

for (const revoked of ["authority", "target", "profile"] as const)
  it.each([
    { phase: "reserve", effect: "controller" },
    { phase: "launch", effect: "controller" },
    { phase: "launch", effect: "adapter" },
    { phase: "launch", effect: "pane" },
  ] as const)(
    `refuses $effect after $phase loses ${revoked}, retaining the original without retry`,
    async ({ phase, effect }) => {
      const directory = await root();
      const file = join(directory, "watches.json");
      const target = claim().target;
      let allowed = true;
      let currentTarget = target;
      let profileChanged = false;
      let original: RemoteHireClaim | undefined;
      const hostOperations: string[] = [];
      const effects: string[] = [];
      const revoke = () => {
        if (revoked === "authority") allowed = false;
        else if (revoked === "target") currentTarget = { ...target, host: "replacement-host" };
        else profileChanged = true;
      };
      const deniedEffect = async (name: string): Promise<never> => {
        effects.push(name);
        throw new Error("Unrequested external effect in hire authority fixture");
      };
      const store = new HerdrWatchStore(file, {
        hireDefaults: async () => ({ effort: profileChanged ? "medium" : "high" }),
        remoteWorkspace: async () => true,
        remoteHireReceipts: {
          claim: async (_fleet, receipt) => ({
            ...receipt,
            target: currentTarget,
            nonce: "a".repeat(64),
          }),
          reserve: async (receipt) => {
            original = structuredClone(receipt);
            hostOperations.push("reserve");
            if (phase === "reserve") revoke();
          },
          launch: async () => {
            hostOperations.push("launch");
            if (phase === "launch") revoke();
          },
          seal: async () => deniedEffect("seal"),
          recover: async () => deniedEffect("recover"),
        },
        nativeLaunchPolicy: {
          admit: async () => {},
          ...(effect === "controller" ? { prepare: async () => deniedEffect("controller") } : {}),
        },
        ...(effect === "adapter"
          ? {
              remoteSeatAdapters: () => [
                {
                  harness: "codex" as const,
                  prepare: async () => deniedEffect("adapter"),
                  attach: async () => deniedEffect("attach"),
                  start: async () => deniedEffect("start"),
                },
              ],
            }
          : {}),
        runner: {
          get: async () => deniedEffect("get"),
          resolveTerminal: async () => deniedEffect("resolveTerminal"),
          wait: async () => deniedEffect("wait"),
          createTab: async () => deniedEffect("pane"),
          startAgent: async () => deniedEffect("startAgent"),
        },
      });
      const request = {
        schemaVersion: 1 as const,
        title: "Original guarded hire",
        harness: "codex" as const,
        fleet: "pc",
        workingDirectory: directory,
      };
      const authority = {
        owner: { conversationId: "global-default" },
        current: () => allowed,
        authorize: async () => allowed,
      };
      try {
        expect(await store.spawnSeat(request, undefined, undefined, undefined, authority)).toMatchObject({
          outcome: "failed",
          reason: "start_unconfirmed",
          deliveryStage: "uncertain",
        });
        expect(effects).toEqual([]);
        expect(hostOperations).toEqual(phase === "reserve" ? ["reserve"] : ["reserve", "launch"]);
        const retained = new DeliveryFence(`${file}.hire-receipts.json`).entries();
        expect(retained).toHaveLength(1);
        expect(retained[0]![0]).toBe(original!.receiptKey);
        expect(retained[0]![1]).toMatchObject({
          messageId: original!.receiptId,
          fingerprint: original!.fingerprint,
          remoteAdmission: { target, nonce: original!.nonce },
        });
        expect(retained[0]![1].remoteLaunchCommitted).toBe(phase === "launch" ? true : undefined);
        expect(retained[0]![1].paneId).toBeUndefined();
        const bytes = await readFile(`${file}.hire-receipts.json`, "utf8");
        // Restoring current grants cannot replay the fenced original or replace its identity.
        allowed = true;
        currentTarget = target;
        profileChanged = false;
        expect(await store.spawnSeat(request, undefined, undefined, undefined, authority)).toMatchObject({
          outcome: "failed",
          reason: "delivery_unconfirmed",
          deliveryStage: "uncertain",
        });
        expect(effects).toEqual([]);
        expect(hostOperations).toEqual(phase === "reserve" ? ["reserve"] : ["reserve", "launch"]);
        expect(await readFile(`${file}.hire-receipts.json`, "utf8")).toBe(bytes);
      } finally {
        store.close();
      }
    },
  );

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
      let fixtureHost = "configured-host";
      const native = createRemoteHireReceipts({
        fleet: async () => ({
          id: "pc",
          session: "default",
          ssh: { host: fixtureHost, shell: "posix" },
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
      // Fresh work uses a separate durable identity and the real host journal,
      // never releasing/replaying its settled predecessor. The controller's
      // policy denial leaves a genuinely uncertain fresh admission behind.
      const freshOriginal = { ...claim(), receiptKey: JSON.stringify(["pc", "codex", home, "new"]) };
      await host(home, freshOriginal, "reserve", env);
      const freshProof = HireNoLaunchEvidenceSchema.parse(await host(home, freshOriginal, "seal", env));
      const freshPath = join(home, "fresh-watches.json");
      const freshFence = new DeliveryFence(`${freshPath}.hire-receipts.json`);
      freshFence.begin(freshOriginal.receiptKey, {
        messageId: freshOriginal.receiptId,
        fingerprint: freshOriginal.fingerprint,
        remoteAdmission: { target: freshOriginal.target, nonce: freshOriginal.nonce },
      });
      freshFence.settleNotLaunched(freshOriginal.receiptKey, freshOriginal.receiptId, freshProof);
      let freshPreparations = 0;
      const freshOptions = {
        remoteHireReceipts: native,
        runner: createHerdrWatchRunner(
          undefined,
          async (args) =>
            (await exec("herdr", [...args], { env: { ...process.env, ...env }, timeout: 5000 })).stdout,
        ),
        remoteSeatAdapters: () => [
          createRemoteCodexSeatAdapter(
            { id: "pc", session: "default", ssh: { host: "configured-host", shell: "posix" } },
            async (command) =>
              (
                await exec("/bin/sh", ["-c", command], {
                  env: { ...process.env, ...env, HOME: home },
                  timeout: 30_000,
                })
              ).stdout,
            async (args) =>
              (await exec("herdr", [...args], { env: { ...process.env, ...env }, timeout: 5000 })).stdout,
          ),
        ],
        remoteWorkspace: async (fleet: string, cwd: string) => fleet === "pc" && cwd === home,
        nativeLaunchPolicy: {
          admit: async () => {},
          prepare: async (): Promise<never> => {
            freshPreparations++;
            throw new Error("Owner denies native preparation in isolated proof");
          },
        },
      };
      const freshRequest = {
        schemaVersion: 1 as const,
        title: "Ada",
        harness: "codex" as const,
        fleet: "pc",
        workingDirectory: home,
        freshIntent: { id: randomUUID(), afterReceiptId: freshOriginal.receiptId },
      };
      const freshAuthority = {
        owner: { conversationId: "fresh-proof-owner" },
        current: () => true,
        authorize: async () => true,
      };
      const freshStore = new HerdrWatchStore(freshPath, freshOptions);
      try {
        expect(await freshStore.spawnSeat(freshRequest, undefined, "new proof brief")).toMatchObject({
          outcome: "failed",
          reason: "not_ready",
        });
        fixtureHost = "replacement-host";
        expect(
          await freshStore.spawnSeat(freshRequest, undefined, "new proof brief", undefined, freshAuthority),
        ).toMatchObject({
          outcome: "failed",
          reason: "not_ready",
          detail: expect.stringContaining("host target changed"),
        });
        fixtureHost = "configured-host";
        const concurrent = await Promise.all(
          [
            freshRequest,
            { ...freshRequest, title: "Bea", freshIntent: { ...freshRequest.freshIntent, id: randomUUID() } },
          ].map((request) =>
            freshStore.spawnSeat(request, undefined, "new proof brief", undefined, freshAuthority),
          ),
        );
        expect(
          concurrent.map((result) => (result.outcome === "failed" ? result.reason : result.outcome)).sort(),
        ).toEqual(["not_ready", "start_unconfirmed"]);
        expect(freshPreparations).toBe(1);
        expect(
          new DeliveryFence(`${freshPath}.hire-receipts.json`).settlement(freshOriginal.receiptId),
        ).toEqual(freshProof);
      } finally {
        freshStore.close();
      }
      const freshRestart = new HerdrWatchStore(freshPath, freshOptions);
      try {
        expect(
          await freshRestart.spawnSeat(freshRequest, undefined, "new proof brief", undefined, freshAuthority),
        ).toMatchObject({ outcome: "failed", reason: "delivery_unconfirmed" });
        expect(
          await freshRestart.spawnSeat(
            { ...freshRequest, freshIntent: undefined },
            undefined,
            "another brief",
            undefined,
            freshAuthority,
          ),
        ).toMatchObject({ outcome: "failed", detail: expect.stringContaining("is settled") });
        expect(freshPreparations).toBe(1);
        const retained = new DeliveryFence(`${freshPath}.hire-receipts.json`).all();
        expect(retained).toHaveLength(2);
        const pending = retained.find(([, record]) => record.freshHire)!;
        expect(pending[1]).toMatchObject({
          freshHire: { id: freshRequest.freshIntent.id },
          remoteLaunchCommitted: true,
        });
        const hostRows = await Promise.all(
          (await readdir(join(home, ".clankie/hire-receipts")))
            .filter((name) => name.endsWith(".json"))
            .map(async (name) =>
              JSON.parse(await readFile(join(home, ".clankie/hire-receipts", name), "utf8")),
            ),
        );
        expect(hostRows.find((row) => row.claim.receiptId === pending[1].messageId)).toMatchObject({
          state: "launching",
        });
        expect(hostRows.find((row) => row.claim.receiptId === freshOriginal.receiptId)).toMatchObject({
          state: "sealed",
        });
        // Real CLI -> authenticated HTTP route -> shared request schema -> hire
        // mechanism and journal. Unrelated captain surfaces stay inert.
        const { app } = await createClankieApp({
          captain: {
            ...createStubCaptain(),
            serveOperatorConversation: async (request) => {
              if (request.op === "spawn_seat")
                return OperatorConversationServiceResultSchema.parse({
                  op: request.op,
                  schemaVersion: 1,
                  result: await freshRestart.spawnSeat(
                    request.seat,
                    undefined,
                    request.brief,
                    undefined,
                    freshAuthority,
                  ),
                });
              if (request.op === "settle_hire_receipt")
                return {
                  op: request.op,
                  schemaVersion: 1,
                  result: await freshRestart.settleHireReceipt(
                    request.receiptId,
                    async () => {},
                    request.disposition,
                  ),
                };
              throw new Error("Unrequested fixture operation");
            },
          },
          authenticateCaptain: async (request) =>
            request.headers.get("authorization") === "Bearer fresh-fixture"
              ? { captainId: "fresh-fixture", steerSourceLane: "api" }
              : undefined,
        });
        const server = createServer(async (request, response) => {
          const result = await app.request(request.url!, {
            method: request.method ?? "POST",
            headers: request.headers as Record<string, string>,
            body: await text(request),
          });
          response.writeHead(result.status, { "content-type": "application/json" });
          response.end(await result.text());
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        try {
          const address = server.address();
          if (!address || typeof address === "string") throw new Error("Fixture HTTP address absent");
          const commandOptions = {
            host: `http://127.0.0.1:${address.port}`,
            env: { CLANKIE_CAPTAIN_TOKEN: "fresh-fixture" },
          };
          let output = "";
          expect(
            await runHireReceiptCommand(["fresh", "--json-stdin"], {
              ...commandOptions,
              stdin: Readable.from([
                JSON.stringify({
                  conversationId: freshAuthority.owner.conversationId,
                  seat: freshRequest,
                  brief: "new proof brief",
                }),
              ]),
              stdout: {
                write: (chunk: string) => {
                  output += chunk;
                },
              },
            }),
          ).toBe(1);
          expect(JSON.parse(output)).toMatchObject({ outcome: "failed", reason: "delivery_unconfirmed" });
          output = "";
          expect(
            await runHireReceiptCommand(["settle", freshOriginal.receiptId], {
              ...commandOptions,
              stdout: {
                write: (chunk: string) => {
                  output += chunk;
                },
              },
            }),
          ).toBe(0);
          expect(JSON.parse(output)).toMatchObject({
            state: "settled-not-launched",
            receiptId: freshOriginal.receiptId,
          });
          expect(freshPreparations).toBe(1);
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      } finally {
        freshRestart.close();
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
