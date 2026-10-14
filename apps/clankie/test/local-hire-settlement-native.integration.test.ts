// Manual Mac-only proof (VUH-2243): real isolated Herdr panes, shells and foreground
// processes settle a restored live local hire receipt. No harness, model or owner pane.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { DeliveryFence, deliveryFingerprint, ReceiptSchema } from "../src/captain/delivery-fence.ts";
import { createHerdrWatchRunner, HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";

const exec = promisify(execFile);
const nativeIt = it.skipIf(
  process.platform !== "darwin" || process.env.LOCAL_HIRE_SETTLE_NATIVE_TEST !== "1",
);

nativeIt(
  "settles a never-launched local hire from host inventory and frees its directory",
  async () => {
    const logs = join(import.meta.dirname, "../../../docs/testing/2026-10-14-local-hire-settlement/abandon");
    const herdr = await isolatedHerdr(logs);
    const evidence: unknown[] = [];
    let store: HerdrWatchStore | undefined;
    try {
      const root = await realpath(herdr.root);
      const cwd = join(root, "work"),
        other = join(root, "other");
      await mkdir(cwd);
      await mkdir(other);
      const run = async (args: readonly string[]) =>
        (
          await exec("herdr", [...args], {
            env: { ...process.env, HERDR_SOCKET_PATH: herdr.socketPath },
            timeout: 10_000,
          })
        ).stdout;
      const runner = createHerdrWatchRunner(undefined, run, undefined, { localCodexRecovery: false });
      const path = join(root, "watches.json");
      // Restore the live pet3d-spike receipt, translating only its directory and pane.
      const golden = JSON.parse(
        await readFile(
          new URL("./fixtures/hire-receipts/local-uncertain-hire.json", import.meta.url),
          "utf8",
        ),
      );
      const id = golden.receipt.messageId as string;
      const key = JSON.stringify(["local", "claude", cwd, "new"]);
      const fence = new DeliveryFence(`${path}.hire-receipts.json`);
      fence.begin(key, ReceiptSchema.parse({ ...golden.receipt, paneId: herdr.pane }));
      const absentKey = JSON.stringify(["local", "claude", other, "new"]);
      const absent = fence.begin(absentKey, {
        fingerprint: deliveryFingerprint("A second brief that never started"),
        paneId: herdr.foreignPane,
        agentName: "proof",
        beforeIds: [],
      });
      const options = { runner };
      store = new HerdrWatchStore(path, options);
      const authority = {
        owner: { conversationId: "global-default" },
        current: () => true,
        authorize: async () => true,
      };
      const request = {
        schemaVersion: 1 as const,
        harness: "claude" as const,
        title: "Settlement proof",
        workingDirectory: cwd,
      };
      const brief = "A new brief after settlement";
      const settle = (receiptId: string, disposition: "not-launched" | "abandoned") =>
        store!.settleHireReceipt(receiptId, async () => {}, disposition);
      const shell = () => runner.paneShell!(herdr.pane);

      // The live failure: every later hire into the directory is held.
      const held = await store.spawnSeat(request, undefined, brief, undefined, authority);
      evidence.push({ phase: "held-before-settlement", result: held });
      expect(held).toMatchObject({ outcome: "failed", reason: "delivery_unconfirmed" });
      expect(await settle(id, "not-launched")).toMatchObject({
        state: "refused",
        detail: expect.stringContaining("Settle it as abandoned"),
      });

      // Any foreground process other than the pane's own shell refuses.
      await herdr.cli("pane", "run", herdr.pane, "sleep 600");
      await expect
        .poll(async () => (await shell()).foreground.some((process) => process.name === "sleep"), {
          timeout: 10_000,
        })
        .toBe(true);
      const busy = await settle(id, "abandoned");
      evidence.push({ phase: "foreground-process", shell: await shell(), result: busy });
      expect(busy).toMatchObject({
        state: "refused",
        detail: expect.stringContaining("foreground process other than its shell (sleep)"),
      });
      await herdr.cli("pane", "send-keys", herdr.pane, "C-c");
      await expect
        .poll(async () => (await shell()).foreground.every((process) => process.pid === herdr.shellPid), {
          timeout: 10_000,
        })
        .toBe(true);

      const settled = await settle(id, "abandoned");
      evidence.push({ phase: "shell-only-settled", result: settled });
      expect(settled).toMatchObject({
        state: "abandoned",
        evidence: {
          receiptId: id,
          receiptKey: key,
          fingerprint: golden.receipt.fingerprint,
          disposition: "abandoned",
          journal: "local-host-inventory",
          pane: { paneId: herdr.pane, present: true, shellPid: herdr.shellPid },
        },
      });
      expect(await settle(id, "abandoned")).toEqual(settled);

      // A reported harness session refuses even when only the shell is in the foreground.
      await herdr.cli(
        "pane",
        "report-agent",
        herdr.foreignPane,
        "--source",
        "herdr:claude",
        "--agent",
        "claude",
        "--state",
        "idle",
        "--agent-session-id",
        randomUUID(),
      );
      const reported = await settle(absent.messageId, "abandoned");
      evidence.push({ phase: "reported-harness", result: reported });
      expect(reported).toMatchObject({
        state: "refused",
        detail: expect.stringMatching(/reports a (claude|herdr:claude session) occupant/u),
      });
      await herdr.cli("pane", "close", herdr.foreignPane);
      const gone = await settle(absent.messageId, "abandoned");
      evidence.push({ phase: "absent-pane-settled", result: gone });
      expect(gone).toMatchObject({
        state: "abandoned",
        evidence: { pane: { paneId: herdr.foreignPane, present: false } },
      });

      // Restart: the originals stay retained under their archive keys and are never
      // replayed. A new hire into the same directory passes the fence; this fixture
      // has no harness adapter, so it stops definitely before any native effect.
      store.close();
      store = new HerdrWatchStore(path, options);
      const retained = new DeliveryFence(`${path}.hire-receipts.json`).all();
      expect(retained.some(([entry]) => entry === key || entry === absentKey)).toBe(false);
      expect(retained.find(([entry]) => entry === `local-settled:${id}`)?.[1]).toMatchObject({
        messageId: id,
        fingerprint: golden.receipt.fingerprint,
        paneId: herdr.pane,
        hireBaseKey: key,
        settlement: settled.state === "abandoned" ? settled.evidence : undefined,
      });
      const admitted = await store.spawnSeat(request, undefined, brief, undefined, authority);
      evidence.push({ phase: "new-hire-after-settlement", result: admitted });
      expect(admitted).toMatchObject({
        outcome: "failed",
        reason: "harness_unavailable",
        detail: expect.stringContaining("no seat was started"),
      });
      expect(new DeliveryFence(`${path}.hire-receipts.json`).pending(key)).toBeUndefined();
    } finally {
      store?.close();
      await writeFile(join(logs, "results.json"), JSON.stringify(evidence, null, 2));
      await herdr.close();
    }
  },
  90_000,
);
