// Real Herdr census/close boundary proof with a restored production completed-hire golden.
// This does not claim a new native Codex hire: the isolated 0.9.3 manifest gap is retained in evidence.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DeliveryFence, deliveryFingerprint, ReceiptSchema } from "../src/captain/delivery-fence.ts";
import { HerdrWatchStore, createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { routeHerdrFleets } from "../src/captain/herdr-fleet-runner.ts";
import { createRemoteCodexSeatAdapter } from "../src/captain/remote-codex-app-server.ts";
import { createRemoteHireReceipts } from "../src/remote-hire-receipts.ts";
import { captainTools } from "../src/captain/tools.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import type { LaneLog } from "../src/captain/lane-log.ts";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";

const exec = promisify(execFile);
it
  .skipIf(process.platform !== "darwin" || process.env.HIRE_RECEIPT_NATIVE_TEST !== "1")
  .each(["close", "harvest"])(
  "%s: operator recovery and completed hire retirement preserve uncertain dispatch fences",
  async (mode) => {
    const logs = join(import.meta.dirname, "../../../docs/testing/2026-10-12-hire-receipts", mode);
    const herdr = await isolatedHerdr(logs);
    const root = await realpath(herdr.root);
    const cwd = join(root, "work");
    const evidence: unknown[] = [];
    let store: HerdrWatchStore | undefined;
    try {
      await mkdir(cwd);
      await mkdir(join(root, "config/herdr"), { recursive: true });
      await symlink(herdr.socketPath, join(root, "config/herdr/herdr.sock"));
      const env = {
        ...process.env,
        HOME: root,
        HERDR_SOCKET_PATH: herdr.socketPath,
        HERDR_CONFIG_PATH: join(root, "config/config.toml"),
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_STATE_HOME: join(root, "state"),
        XDG_DATA_HOME: join(root, "data"),
        XDG_CACHE_HOME: join(root, "cache"),
        XDG_RUNTIME_DIR: join(root, "runtime"),
      };
      const run = async (args: readonly string[]) =>
        (await exec("herdr", [...args], { env, timeout: 15000 })).stdout;
      const shell = async (command: string) =>
        (await exec("/bin/sh", ["-c", command], { env, timeout: 30000 })).stdout;
      const local = createHerdrWatchRunner(undefined, run, undefined, { localCodexRecovery: false });
      const fleet = "mac-proof";
      const runner = routeHerdrFleets(local, new Map([[fleet, local]]));
      let fixtureHost = "isolated-this-mac";
      const config = () => ({
        id: fleet,
        session: "default",
        ssh: { host: fixtureHost, shell: "posix" as const },
      });
      const native = createRemoteHireReceipts({ fleet: async () => config(), shell: () => shell });
      const path = join(root, "watches.json");
      const fence = new DeliveryFence(`${path}.hire-receipts.json`);
      const baseKey = JSON.stringify([fleet, "codex", cwd, "new"]);
      const intent = randomUUID();
      const claim = (await native.claim(fleet, {
        receiptId: randomUUID(),
        receiptKey: baseKey,
        fingerprint: deliveryFingerprint("Unmapped original intent"),
      }))!;
      await native.reserve(claim);
      await native.launch(claim);
      fence.begin(baseKey, {
        messageId: claim.receiptId,
        fingerprint: claim.fingerprint,
        freshHire: {
          id: intent,
          afterReceiptId: randomUUID(),
          baseKey,
          owner: { conversationId: "other-owner" },
          launch: { schemaVersion: 1, harness: "codex", title: "Original", fleet, workingDirectory: cwd },
        },
        remoteAdmission: { target: claim.target, nonce: claim.nonce },
        remoteLaunchCommitted: true,
      });
      let preparations = 0;
      const options = {
        runner,
        remoteHireReceipts: native,
        remoteWorkspace: async (selected: string, directory: string) =>
          selected === fleet && directory === cwd,
        remoteSeatAdapters: () => [createRemoteCodexSeatAdapter(config(), shell, run)],
        nativeLaunchPolicy: {
          admit: async () => {},
          prepare: async (): Promise<never> => {
            preparations++;
            throw new Error("Owner denies native preparation in census boundary proof");
          },
        },
      };
      store = new HerdrWatchStore(path, options);
      let allowed = true;
      const authority = {
        owner: { conversationId: "global-default" },
        current: () => allowed,
        authorize: async () => allowed,
      };
      const tools = (operator: boolean) =>
        captainTools(
          { embodiment: {} } as CaptainDeps,
          { shell: true, hireReceiptOperator: operator, conversationAuthority: authority },
          {} as LaneLog,
          "operator",
          undefined,
          undefined,
          store,
        );
      const settle = async (operator: boolean) => {
        const tool = tools(operator).find((entry) => entry.name === "settle_hire_receipt")!;
        return (
          await tool.execute(
            "proof",
            { receiptId: intent, disposition: "abandoned-unknown" },
            undefined,
            undefined,
            {} as never,
          )
        ).details;
      };
      expect(await settle(false)).toMatchObject({
        state: "refused",
        detail: expect.stringContaining("owning conversation"),
      });
      allowed = false;
      expect(await settle(true)).toMatchObject({ state: "refused" });
      allowed = true;
      const settled = await settle(true);
      evidence.push({ phase: "operator-other-owner", result: settled });
      expect(settled).toMatchObject({
        state: "abandoned",
        evidence: { disposition: "abandoned-unknown", allocation: { outcome: "unknown" } },
      });
      await expect(native.launch(claim)).rejects.toThrow(/cannot launch again/u);

      store.close();
      // Restore a real successful journal record, translating only its location/target into our owned Herdr.
      const golden = JSON.parse(
        await readFile(new URL("./fixtures/hire-receipts/completed-hire.json", import.meta.url), "utf8"),
      );
      const paneId = `${fleet}/${herdr.pane}`;
      const completedKey = JSON.stringify([...JSON.parse(baseKey), "fresh", golden.freshHire.id]);
      const completed = ReceiptSchema.parse({
        ...golden,
        paneId,
        remoteAdmission: { target: claim.target, nonce: claim.nonce },
        freshHire: {
          ...golden.freshHire,
          baseKey,
          launch: { ...golden.freshHire.launch, fleet, workingDirectory: cwd, projectId: undefined },
        },
      });
      await writeFile(`${path}.hire-receipts.json`, JSON.stringify({ [completedKey]: completed }));
      store = new HerdrWatchStore(path, options);
      const request = {
        schemaVersion: 1 as const,
        harness: "codex" as const,
        title: "Boundary proof",
        fleet,
        workingDirectory: cwd,
        freshIntent: { id: randomUUID(), afterReceiptId: completed.messageId },
      };
      const brief = "A distinct new census boundary proof";
      expect(await store.spawnSeat(request, undefined, brief, undefined, authority)).toMatchObject({
        outcome: "failed",
        reason: "not_ready",
      });
      expect(preparations).toBe(0);
      expect(new DeliveryFence(`${path}.hire-receipts.json`).all()[0]![1].retired).toBeUndefined();
      const before = (await runner.list!(fleet)).find((pane) => pane.paneId === paneId)!;
      evidence.push({ phase: "live-census", before, completedGolden: completed.messageId });
      if (mode === "close") expect(await store.closeSeat(before.terminalId, async () => {})).toBe(true);
      else await local.closePane!(herdr.pane);
      expect((await runner.list!(fleet)).some((pane) => pane.paneId === paneId)).toBe(false);
      fixtureHost = "replacement-host";
      expect(await store.spawnSeat(request, undefined, brief, undefined, authority)).toMatchObject({
        outcome: "failed",
        reason: "not_ready",
        detail: expect.stringContaining("host target changed"),
      });
      expect(preparations).toBe(0);
      fixtureHost = "isolated-this-mac";
      const admitted = await store.spawnSeat(request, undefined, brief, undefined, authority);
      evidence.push({ phase: "new-intent-admitted-preparation-denied", result: admitted });
      expect(admitted).toMatchObject({ outcome: "failed", reason: "start_unconfirmed" });
      expect(preparations).toBe(1);
      const retained = new DeliveryFence(`${path}.hire-receipts.json`)
        .all()
        .find(([, record]) => record.messageId === completed.messageId)![1];
      expect(retained).toMatchObject({
        completed: completed.completed,
        remoteLaunchCommitted: true,
        retired: { censusSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      });
      store.close();
      store = new HerdrWatchStore(path, options);
      expect(await store.spawnSeat(request, undefined, brief, undefined, authority)).toMatchObject({
        outcome: "failed",
        reason: "delivery_unconfirmed",
      });
      expect(
        await store.spawnSeat(
          { ...request, freshIntent: { ...request.freshIntent, id: randomUUID() } },
          undefined,
          "Another distinct brief",
          undefined,
          authority,
        ),
      ).toMatchObject({
        outcome: "failed",
        reason: "not_ready",
        detail: expect.stringContaining("unresolved"),
      });
      expect(
        await store.spawnSeat(
          { ...request, freshIntent: undefined },
          undefined,
          "Ordinary request must not bypass uncertain fresh dispatch",
          undefined,
          authority,
        ),
      ).toMatchObject({
        outcome: "failed",
        reason: "not_ready",
        detail: expect.stringContaining("remains uncertain"),
      });
      expect(preparations).toBe(1);
      const settledFresh = await store.settleHireReceipt(
        request.freshIntent.id,
        async () => {},
        "abandoned-unknown",
      );
      expect(settledFresh).toMatchObject({ state: "abandoned" });
      expect(
        await store.spawnSeat(
          { ...request, freshIntent: undefined },
          undefined,
          "Ordinary request must retain explicit fresh history",
          undefined,
          authority,
        ),
      ).toMatchObject({
        outcome: "failed",
        reason: "not_ready",
        detail: expect.stringContaining("distinct freshIntent"),
      });
      expect(preparations).toBe(1);
      evidence.push({ phase: "restart-no-replay", preparations, retained, settledFresh });
    } finally {
      store?.close();
      await writeFile(join(logs, "boundary-results.json"), JSON.stringify(evidence, null, 2));
      await herdr.close();
    }
  },
  90000,
);
