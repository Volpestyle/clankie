/**
 * #326: a hire on another fleet machine whose workspace create times out holds
 * its place until it is settled. The create carries no harness command, so when
 * the host's authenticated census shows no pane in the hire's directory, the
 * original can be settled as not launched, though its launch was committed.
 *
 * Real seam, no PC: the real host receipt program runs through /bin/sh against
 * an isolated real Herdr server (the program a joined PC runs over SSH), the
 * real hire layout issues the create, and the real store keeps and settles the
 * receipt. Only the PC's latency is modelled: a create the "PC" takes longer to
 * answer than the call allows fails with the fleet runner's own timeout error,
 * without creating anything, as the PC was seen to do.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { HireNoLaunchEvidenceSchema } from "@clankie/protocol";
import { DeliveryFence } from "../src/captain/delivery-fence.ts";
import { createHireLayout, WORKSPACE_CREATE_TIMEOUT_MS } from "../src/captain/hire-layout.ts";
import { HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import { HerdrFleetError } from "../src/herdr-fleet.ts";
import { createRemoteHireReceipts } from "../src/remote-hire-receipts.ts";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";

const exec = promisify(execFile);
const nativeIt = it.skipIf(process.platform !== "darwin" || process.env.HIRE_RECEIPT_NATIVE_TEST !== "1");
/** The fleet runner's default for one remote Herdr call. */
const REMOTE_DEFAULT_MS = 20_000;
/** The joined PC answered its workspace create after more than the 20 s default (VUH-2180). */
const PC_CREATE_MS = 25_000;
/** A PC that never answers the create within any timeout, and creates nothing. */
const PC_SILENT = Number.POSITIVE_INFINITY;

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(pcCreateMs: number) {
  const home = await realpath(await mkdtemp("/tmp/hire-unsent-"));
  roots.push(home);
  const herdr = await isolatedHerdr(join(home, "logs"));
  // Explicit --session ignores HERDR_SOCKET_PATH; bind this fixture's default namespace.
  await mkdir(join(herdr.root, "config/herdr"), { recursive: true });
  await symlink(herdr.socketPath, join(herdr.root, "config/herdr/herdr.sock"));
  const env = {
    ...process.env,
    HOME: home,
    HERDR_SOCKET_PATH: herdr.socketPath,
    HERDR_CONFIG_PATH: join(herdr.root, "config/config.toml"),
    XDG_CONFIG_HOME: join(herdr.root, "config"),
    XDG_STATE_HOME: join(herdr.root, "state"),
    XDG_DATA_HOME: join(herdr.root, "data"),
    XDG_CACHE_HOME: join(herdr.root, "cache"),
    XDG_RUNTIME_DIR: join(herdr.root, "runtime"),
  };
  const herdrCli = async (args: readonly string[]) =>
    (await exec("herdr", ["--session", "default", ...args], { env, timeout: 10_000 })).stdout;
  const creates: (number | undefined)[] = [];
  /** A fleet runner over this host, with the PC's create latency modelled. */
  const run = async (args: readonly string[], _signal?: AbortSignal, timeoutMs?: number) => {
    if (args[0] === "workspace" && args[1] === "create") {
      creates.push(timeoutMs);
      const limit = timeoutMs ?? REMOTE_DEFAULT_MS;
      if (pcCreateMs > limit)
        throw new HerdrFleetError(
          "timeout",
          `fleet pc: herdr workspace create timed out after ${String(limit)} ms`,
        );
    }
    return await herdrCli(args);
  };
  const receipts = createRemoteHireReceipts({
    fleet: async () => ({ id: "pc", session: "default", ssh: { host: "configured-host", shell: "posix" } }),
    shell: () => async (command) => (await exec("/bin/sh", ["-c", command], { env, timeout: 30_000 })).stdout,
  });
  const watches = join(home, "watches.json");
  const effects: string[] = [];
  const denied = async (name: string): Promise<never> => {
    effects.push(name);
    throw new Error(`Unexpected ${name} after an unconfirmed workspace create`);
  };
  const layout = createHireLayout(run);
  const store = new HerdrWatchStore(watches, {
    remoteWorkspace: async () => true,
    remoteHireReceipts: receipts,
    nativeLaunchPolicy: { admit: async () => {} },
    // A briefed hire needs the PC's harness adapter. This PC never answers its workspace create,
    // so nothing past the create, the adapter included, may run.
    // A briefed work hire also reads the PC's plan usage first.
    workerAccountsReport: async () => ({
      machine: "pc",
      shell: "posix",
      observedAt: new Date().toISOString(),
      accounts: [
        {
          harness: "claude",
          label: "fixture",
          home,
          signedIn: true,
          usable: true,
          plan: "pro",
          headroom: 0.8,
          usage: {
            source: "claude-usage",
            observedAt: new Date().toISOString(),
            windows: [{ id: "week", label: "Week", usedPercent: 20 }],
          },
        },
      ],
    }),
    remoteSeatAdapters: () => [
      { harness: "claude", start: async () => denied("adapter start"), attach: async () => undefined },
    ],
    runner: {
      get: async () => denied("get"),
      resolveTerminal: async () => denied("resolveTerminal"),
      wait: async () => denied("wait"),
      createTab: (options) => layout(options),
      startAgent: async () => denied("startAgent"),
      runInPane: async () => denied("runInPane"),
    },
  });
  const authority = {
    owner: { conversationId: "global-default" },
    current: () => true,
    authorize: async () => true,
  };
  const hire = async (
    directory: string,
    freshIntent?: { readonly id: string; readonly afterReceiptId: string },
    brief?: string,
  ) => {
    await mkdir(directory, { recursive: true });
    return await store.spawnSeat(
      {
        schemaVersion: 1,
        title: "PC worker",
        harness: "claude",
        fleet: "pc",
        workingDirectory: directory,
        ...(freshIntent === undefined
          ? {}
          : {
              freshIntent,
              effort: "low" as const,
              effortReason: "A fixture hire only needs to reach the PC's workspace create.",
            }),
      },
      undefined,
      brief,
      undefined,
      authority,
    );
  };
  const receipt = () => new DeliveryFence(`${watches}.hire-receipts.json`).entries().at(-1)!;
  return { home, herdr, herdrCli, run, creates, store, hire, receipt, effects };
}

nativeIt(
  "a committed PC hire whose workspace create timed out settles as not launched when the PC shows nothing in its folder",
  async () => {
    const f = await fixture(PC_SILENT);
    try {
      const directory = join(f.home, "fresh-place");
      expect(await f.hire(directory)).toMatchObject({
        outcome: "failed",
        reason: "start_unconfirmed",
        detail: expect.stringContaining("workspace create timed out"),
      });
      expect(f.effects).toEqual([]);
      const [, original] = f.receipt();
      expect(original).toMatchObject({ remoteLaunchCommitted: true, remoteCommandUnsent: true });
      expect(original.paneId).toBeUndefined();

      const settled = await f.store.settleHireReceipt(original.messageId, async () => {});
      expect(settled).toMatchObject({
        state: "settled-not-launched",
        receiptId: original.messageId,
        evidence: { journal: "launch-committed-command-unsent" },
      });
      if (settled.state !== "settled-not-launched") throw new Error("not settled");
      HireNoLaunchEvidenceSchema.parse(settled.evidence);
      // Idempotent, and the place is free: the original is settled, not pending.
      expect(await f.store.settleHireReceipt(original.messageId, async () => {})).toEqual(settled);
      expect(
        new DeliveryFence(join(f.home, "watches.json.hire-receipts.json")).settlement(original.messageId),
      ).toEqual(settled.evidence);
    } finally {
      f.store.close();
      await f.herdr.close();
    }
  },
  120_000,
);

nativeIt(
  "hiring again at that place settles the original by itself and names the fresh intent new work takes",
  async () => {
    const f = await fixture(PC_SILENT);
    try {
      const directory = join(f.home, "rehire-place");
      expect(await f.hire(directory)).toMatchObject({ outcome: "failed", reason: "start_unconfirmed" });
      const [, original] = f.receipt();
      expect(original).toMatchObject({ remoteLaunchCommitted: true, remoteCommandUnsent: true });

      // No operator step: the next hire there reads the PC's census and settles the original.
      const again = await f.hire(directory);
      expect(again).toMatchObject({ outcome: "failed", reason: "not_ready" });
      const detail = again.outcome === "failed" ? (again.detail ?? "") : "";
      expect(detail).toContain(`Original hire ${original.messageId} is settled`);
      const next = /freshIntent (\{.*?\})/u.exec(detail)?.[1];
      const intent = JSON.parse(next!) as { id: string; afterReceiptId: string };
      expect(intent).toMatchObject({ afterReceiptId: original.messageId, id: expect.any(String) });
      expect(
        new DeliveryFence(join(f.home, "watches.json.hire-receipts.json")).settlement(original.messageId),
      ).toMatchObject({ journal: "launch-committed-command-unsent" });
      // Only the first hire's create ran; the settling hire launched nothing.
      expect(f.creates).toHaveLength(1);
      expect(f.effects).toEqual([]);

      // The place is free: a hire with the named fresh intent goes ahead there, on its own new
      // receipt, and reaches the PC's workspace create again (this PC still never answers it).
      const fresh = await f.hire(directory, intent, "Pick up the work at this place.");
      expect(fresh).toMatchObject({ outcome: "failed", reason: "start_unconfirmed" });
      expect(fresh.outcome === "failed" ? fresh.detail : "").toContain("workspace create timed out");
      const [, latest] = f.receipt();
      expect(latest.messageId).not.toBe(original.messageId);
      expect(fresh.outcome === "failed" ? fresh.receiptId : undefined).toBe(latest.messageId);
      expect(f.creates).toHaveLength(2);
      expect(f.effects).toEqual([]);
    } finally {
      f.store.close();
      await f.herdr.close();
    }
  },
  120_000,
);

nativeIt(
  "hiring again where the create landed late leaves the original fenced, unsettled",
  async () => {
    const f = await fixture(PC_SILENT);
    try {
      const directory = join(f.home, "late-rehire");
      expect(await f.hire(directory)).toMatchObject({ outcome: "failed", reason: "start_unconfirmed" });
      const [, original] = f.receipt();
      await f.herdrCli(["workspace", "create", "--cwd", directory, "--label", "late", "--no-focus"]);
      const again = await f.hire(directory);
      expect(again).toMatchObject({ outcome: "failed" });
      expect(again.outcome === "failed" ? again.reason : undefined).not.toBe("not_ready");
      expect(
        new DeliveryFence(join(f.home, "watches.json.hire-receipts.json")).settlement(original.messageId),
      ).toBeUndefined();
      expect(f.creates).toHaveLength(1);
    } finally {
      f.store.close();
      await f.herdr.close();
    }
  },
  120_000,
);

nativeIt(
  "a create that landed late leaves a pane in the folder, so the original stays fenced",
  async () => {
    const f = await fixture(PC_SILENT);
    try {
      const directory = join(f.home, "late-place");
      expect(await f.hire(directory)).toMatchObject({ outcome: "failed", reason: "start_unconfirmed" });
      const [, original] = f.receipt();
      expect(original.remoteCommandUnsent).toBe(true);
      // The PC finished the create after the service stopped waiting.
      await f.herdrCli(["workspace", "create", "--cwd", directory, "--label", "late", "--no-focus"]);
      expect(await f.store.settleHireReceipt(original.messageId, async () => {})).toMatchObject({
        state: "refused",
        detail: expect.stringMatching(/runs in the original hire's directory/u),
      });
      expect(
        new DeliveryFence(join(f.home, "watches.json.hire-receipts.json")).settlement(original.messageId),
      ).toBeUndefined();
    } finally {
      f.store.close();
      await f.herdr.close();
    }
  },
  120_000,
);

nativeIt(
  "a committed launch without the unsent marker is still refused by the PC's journal",
  async () => {
    const f = await fixture(PC_SILENT);
    try {
      const directory = join(f.home, "unmarked-place");
      await f.hire(directory);
      const file = join(f.home, "watches.json.hire-receipts.json");
      const [key, original] = f.receipt();
      // As a receipt from before #326, or one whose failure came after a command could leave.
      const bytes = JSON.parse(await readFile(file, "utf8"));
      delete bytes[key].remoteCommandUnsent;
      await writeFile(file, JSON.stringify(bytes));
      const store = new HerdrWatchStore(join(f.home, "watches.json"), {
        remoteHireReceipts: createRemoteHireReceipts({
          fleet: async () => ({
            id: "pc",
            session: "default",
            ssh: { host: "configured-host", shell: "posix" },
          }),
          shell: () => async () => {
            throw new Error("No host operation may run for an unmarked committed launch");
          },
        }),
      });
      f.store.close();
      try {
        expect(await store.settleHireReceipt(original.messageId, async () => {})).toMatchObject({
          state: "refused",
          detail: expect.stringMatching(/no-launch window/u),
        });
      } finally {
        store.close();
      }
    } finally {
      await f.herdr.close();
    }
  },
  120_000,
);

nativeIt(
  "the workspace create gets a timeout that fits a PC's create, and the real create succeeds within it",
  async () => {
    const f = await fixture(PC_CREATE_MS);
    try {
      expect(WORKSPACE_CREATE_TIMEOUT_MS).toBeGreaterThan(PC_CREATE_MS);
      const directory = join(f.home, "fits");
      await mkdir(directory);
      const pane = await createHireLayout(f.run)({ cwd: directory, label: "PC worker" });
      expect(f.creates).toEqual([WORKSPACE_CREATE_TIMEOUT_MS]);
      const panes = JSON.parse(await f.herdrCli(["pane", "list"])).result.panes as {
        pane_id: string;
        cwd?: string;
      }[];
      expect(panes.find((entry) => entry.pane_id === pane)?.cwd).toBe(directory);
    } finally {
      f.store.close();
      await f.herdr.close();
    }
  },
  120_000,
);
