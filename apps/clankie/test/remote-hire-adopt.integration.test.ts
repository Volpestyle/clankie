/**
 * #326: a hire on another fleet machine that never confirmed can be adopted by the
 * operator once its agent runs in its own pane. Two cases seen on the PC:
 *
 * - A Claude hire into a new folder stopped at the folder-trust prompt. After trust
 *   was accepted the agent came up idle, but its receipt had no session or occupant.
 * - An older allocation whose original receipt can't be matched (others sit at the
 *   same place), so neither settle nor release applied.
 *
 * Real seam, no PC: an isolated real Herdr server is the PC's, a stand-in Claude
 * reports itself to it from its own pane, the real host receipt program runs
 * through /bin/sh against that Herdr, and the real store adopts. Only the remote
 * process proof that confirms a project allocation is modelled.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { SpawnOperatorSeatSchema } from "@clankie/protocol";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { DeliveryFence, deliveryFingerprint } from "../src/captain/delivery-fence.ts";
import { createHerdrWatchRunner, HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import { createRemoteHerdrRunner, routeHerdrFleets } from "../src/captain/herdr-fleet-runner.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import { HireOwners } from "../src/captain/hire-owners.ts";
import { ProjectHires } from "../src/captain/project-hires.ts";
import type { HerdrFleet } from "../src/herdr-fleet.ts";
import { createRemoteHireReceipts, type RemoteHireClaim } from "../src/remote-hire-receipts.ts";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";

const exec = promisify(execFile);
const nativeIt = it.skipIf(process.platform !== "darwin" || process.env.HIRE_RECEIPT_NATIVE_TEST !== "1");
const pc: HerdrFleet = { id: "pc", session: "default", ssh: { host: "configured-host", shell: "posix" } };
const lead = { conversationId: "conv-lead" };

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const home = await realpath(await mkdtemp("/tmp/hire-adopt-"));
  roots.push(home);
  const herdr = await isolatedHerdr(join(home, "logs"));
  // Explicit --session ignores HERDR_SOCKET_PATH; bind this fixture's default namespace.
  await mkdir(join(herdr.root, "config/herdr"), { recursive: true });
  await symlink(herdr.socketPath, join(herdr.root, "config/herdr/herdr.sock"));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HERDR_"))),
    HOME: home,
    HERDR_SOCKET_PATH: herdr.socketPath,
    HERDR_CONFIG_PATH: join(herdr.root, "config/config.toml"),
    XDG_CONFIG_HOME: join(herdr.root, "config"),
    XDG_STATE_HOME: join(herdr.root, "state"),
    XDG_DATA_HOME: join(herdr.root, "data"),
    XDG_CACHE_HOME: join(herdr.root, "cache"),
    XDG_RUNTIME_DIR: join(herdr.root, "runtime"),
    SHELL: "/bin/sh",
  };
  const herdrCli = async (args: readonly string[]) =>
    (await exec("herdr", ["--session", "default", ...args], { env, timeout: 15_000 })).stdout;
  // A stand-in Claude: Herdr names a pane's agent from its foreground process and its reports.
  await mkdir(join(home, "bin"), { recursive: true });
  await writeFile(
    join(home, "bin/claude"),
    `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
process.title = "claude";
require("node:fs").appendFileSync(${JSON.stringify(join(home, "pids"))}, process.pid + "\\n");
execFileSync("herdr", ["pane", "report-agent", process.env.HERDR_PANE_ID, "--source", "herdr:claude",
  "--agent", "claude", "--state", "idle"]);
execFileSync("herdr", ["pane", "report-agent-session", process.env.HERDR_PANE_ID, "--source", "herdr:claude",
  "--agent", "claude", "--agent-session-id", randomUUID()]);
process.stdout.write("Claude is idle after folder trust\\n");
// A harness that changes directory mid-session (the census-change probe).
process.on("SIGUSR2", () => process.chdir(${JSON.stringify(join(home, "moved"))}));
setInterval(() => {}, 1 << 30);
`,
  );
  await chmod(join(home, "bin/claude"), 0o755);
  const local = createHerdrWatchRunner(() => true, herdrCli, undefined, { localCodexRecovery: false });
  const runner = routeHerdrFleets(
    local,
    new Map([["pc", createRemoteHerdrRunner(pc, async (args) => herdrCli(args), { pollMs: 0 })]]),
  );
  /** A pane on the "PC" in this directory; with the stand-in Claude unless `shellOnly`. */
  const pane = async (directory: string, shellOnly = false, agentDirectory?: string) => {
    await mkdir(directory, { recursive: true });
    const id = await runner.createTab!({ cwd: directory, label: "PC worker" });
    if (!shellOnly) {
      if (agentDirectory !== undefined) await mkdir(agentDirectory, { recursive: true });
      await runner.runInPane!(
        id,
        agentDirectory === undefined
          ? [join(home, "bin/claude")]
          : ["sh", "-c", `cd '${agentDirectory}' && exec '${join(home, "bin/claude")}'`],
      );
      await expect
        .poll(
          async () => {
            const agent = await runner.get(`pc/${id}`);
            return agent.agent === "claude" && agent.session !== undefined;
          },
          { timeout: 15_000 },
        )
        .toBe(true);
    }
    return `pc/${id}`;
  };
  const native = createRemoteHireReceipts({
    fleet: async () => pc,
    shell: () => async (command) => (await exec("/bin/sh", ["-c", command], { env, timeout: 30_000 })).stdout,
  });
  const watches = join(home, "watches.json");
  const receipts = `${watches}.hire-receipts.json`;
  /** The receipt a PC hire leaves when its pane opened but its start never confirmed. */
  const uncertainHire = async (directory: string, paneId: string | undefined, harness = "claude") => {
    const claim: RemoteHireClaim = {
      receiptId: randomUUID(),
      receiptKey: JSON.stringify(["pc", harness, directory, "new"]),
      fingerprint: deliveryFingerprint("Fix the build."),
      nonce: randomUUID().replaceAll("-", "").repeat(2),
      target: { fleet: "pc", host: "configured-host", session: "default", shell: "posix" },
    };
    await native.reserve(claim);
    await native.launch(claim);
    const fence = new DeliveryFence(receipts);
    fence.begin(claim.receiptKey, {
      messageId: claim.receiptId,
      fingerprint: claim.fingerprint,
      remoteAdmission: { target: claim.target, nonce: claim.nonce },
      remoteLaunchCommitted: true,
    });
    if (paneId !== undefined) fence.update(claim.receiptKey, claim.receiptId, { paneId });
    return claim;
  };
  const owners = new HireOwners(`${watches}.owners.json`);
  /** The pane's stand-in changes its own directory, as a harness can mid-session. */
  const moveAgent = async (paneId: string) => {
    await mkdir(join(home, "moved"), { recursive: true });
    for (const pid of (await readFile(join(home, "pids"), "utf8")).trim().split("\n"))
      process.kill(Number(pid), "SIGUSR2");
    await expect
      .poll(async () => (await runner.get(paneId)).foregroundWorkingDirectory, { timeout: 15_000 })
      .toBe(join(home, "moved"));
  };
  return { home, herdr, runner, native, watches, receipts, pane, uncertainHire, owners, moveAgent };
}

nativeIt(
  "adopts a PC Claude hire that came up idle after folder trust, from the fleet census and the host's attestation",
  async () => {
    const f = await fixture();
    try {
      const directory = join(f.home, "new-folder");
      const paneId = await f.pane(directory);
      const original = await f.uncertainHire(directory, paneId);
      f.owners.bind(paneId, lead);
      const store = new HerdrWatchStore(f.watches, { remoteHireReceipts: f.native, runner: f.runner });
      try {
        // Another conversation can't adopt; the operator can.
        expect(
          await store.settleHireReceipt(original.receiptId, async () => {}, "adopt", {
            conversationId: "someone-else",
          }),
        ).toMatchObject({ state: "refused", detail: expect.stringContaining("Only the operator") });
        const agent = await f.runner.get(paneId);
        const adopted = await store.settleHireReceipt(original.receiptId, async () => {}, "adopt");
        expect(adopted).toMatchObject({
          state: "adopted",
          receiptId: original.receiptId,
          seat: { paneId, seatId: agent.terminalId, occupantId: occupantIdForHerdrSession(agent.session!) },
          owner: lead,
          evidence: {
            journal: "authenticated-recovery",
            disposition: "adopted",
            allocation: {
              paneId,
              present: true,
              terminalId: agent.terminalId,
              sessionId: agent.session!.value,
            },
          },
        });
        expect(adopted).not.toHaveProperty("evidence.delivery");
        if (adopted.state !== "adopted") throw new Error(JSON.stringify(adopted));
        // The receipt settles with the host's evidence; the host journal records the adoption.
        expect(new DeliveryFence(f.receipts).settlement(original.receiptId)).toEqual(adopted.evidence);
        const journals = join(f.home, ".clankie/hire-receipts");
        const journal = (await readdir(journals)).filter((name) => name.endsWith(".json"));
        expect(journal).toHaveLength(1);
        expect(JSON.parse(await readFile(join(journals, journal[0]!), "utf8"))).toMatchObject({
          state: "recovered",
          recoveries: [{ request: { disposition: "adopted", paneId }, evidence: adopted.evidence }],
        });
        // A repeat reads the retained adoption without changing anything.
        const bytes = await readFile(f.receipts, "utf8");
        expect(await store.settleHireReceipt(original.receiptId, async () => {}, "adopt")).toEqual({
          ...adopted,
          detail: "Already adopted; the retained adoption is unchanged.",
        });
        expect(await readFile(f.receipts, "utf8")).toBe(bytes);
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
  "refuses adoption while the pane holds no agent session, leaving the receipt and host journal unchanged",
  async () => {
    const f = await fixture();
    try {
      const directory = join(f.home, "trust-prompt");
      const paneId = await f.pane(directory, true);
      const original = await f.uncertainHire(directory, paneId);
      f.owners.bind(paneId, lead);
      const store = new HerdrWatchStore(f.watches, { remoteHireReceipts: f.native, runner: f.runner });
      try {
        const bytes = await readFile(f.receipts, "utf8");
        expect(await store.settleHireReceipt(original.receiptId, async () => {}, "adopt")).toMatchObject({
          state: "refused",
          detail: expect.stringContaining("holds no observed claude session"),
        });
        expect(await readFile(f.receipts, "utf8")).toBe(bytes);
        // The host program refuses the same adoption on its own census.
        await expect(
          f.native.recover(
            { ...original },
            { disposition: "adopted", paneId, cwd: directory, harness: "claude" },
          ),
        ).rejects.toThrow(/running agent session/u);
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
  "adopts a legacy PC allocation whose original receipt can't be matched, from the census alone",
  async () => {
    const f = await fixture();
    try {
      const directory = join(f.home, "wt-legacy");
      const paneId = await f.pane(directory);
      // Older receipts at the same place name no pane, so none is the allocation's original.
      const older = await f.uncertainHire(directory, undefined);
      const settings = ProjectsSettingsSchema.parse({ projects: [{ id: "game", name: "Game" }] });
      const ledger = new ProjectHires(`${f.watches}.project-hires.json`);
      const allocation = ledger.reserve(
        settings,
        "game",
        SpawnOperatorSeatSchema.parse({
          schemaVersion: 1,
          fleet: "pc",
          harness: "claude",
          title: "Ada",
          workingDirectory: directory,
        }),
      );
      ledger.launch(allocation.id, settings);
      ledger.pane(allocation.id, paneId);
      f.owners.bind(paneId, lead);
      const agent = await f.runner.get(paneId);
      const occupantId = occupantIdForHerdrSession(agent.session!);
      const proofs: string[] = [];
      const store = new HerdrWatchStore(f.watches, {
        remoteHireReceipts: f.native,
        runner: f.runner,
        projectHirePolicy: {
          settings: async () => settings,
          project: async () => "game",
          // Modelled: the remote process proof for this exact occupant.
          proof: async (fleet, pane) => {
            proofs.push(`${fleet} ${pane}`);
            return {
              nativeOccupantId: occupantId,
              fleet,
              pane,
              binding: { socketPath: "pc-herdr.sock", session: "default" },
              shell: { pid: 4242, startTime: "2026-11-02T00:00:00.000Z" },
              processes: [{ pid: 4243, startTime: "2026-11-02T00:00:01.000Z" }],
            };
          },
        },
      });
      try {
        const olderBytes = JSON.stringify(new DeliveryFence(f.receipts).pending(older.receiptKey));
        const adopted = await store.settleHireReceipt(allocation.id, async () => {}, "adopt");
        expect(adopted).toMatchObject({
          state: "adopted",
          receiptId: allocation.id,
          allocationId: allocation.id,
          seat: { paneId, seatId: agent.terminalId, occupantId },
          owner: lead,
          detail: expect.stringContaining("census alone"),
        });
        expect(adopted).not.toHaveProperty("evidence");
        expect(proofs).toEqual([`pc ${paneId}`]);
        expect(new ProjectHires(`${f.watches}.project-hires.json`).allocation(allocation.id)).toMatchObject({
          confirmed: true,
          occupantId,
          seat: agent.terminalId,
        });
        // The unrelated older receipt is untouched.
        expect(JSON.stringify(new DeliveryFence(f.receipts).pending(older.receiptKey))).toBe(olderBytes);
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
  "refuses a pane running another harness, or a session outside the hire's directory, with nothing changed",
  async () => {
    const f = await fixture();
    try {
      // The receipt names Codex; the pane runs Claude.
      const codexPlace = join(f.home, "codex-place");
      const claudePane = await f.pane(codexPlace);
      const codexHire = await f.uncertainHire(codexPlace, claudePane, "codex");
      f.owners.bind(claudePane, lead);
      // The receipt names this directory; its pane's agent runs in another one.
      const hirePlace = join(f.home, "hire-place");
      await mkdir(hirePlace, { recursive: true });
      const elsewhere = await f.pane(join(f.home, "elsewhere"));
      const movedHire = await f.uncertainHire(hirePlace, elsewhere);
      f.owners.bind(elsewhere, lead);
      const store = new HerdrWatchStore(f.watches, { remoteHireReceipts: f.native, runner: f.runner });
      try {
        const bytes = await readFile(f.receipts, "utf8");
        expect(await store.settleHireReceipt(codexHire.receiptId, async () => {}, "adopt")).toMatchObject({
          state: "refused",
          detail: expect.stringContaining("holds no observed codex session"),
        });
        expect(await store.settleHireReceipt(movedHire.receiptId, async () => {}, "adopt")).toMatchObject({
          state: "refused",
          detail: expect.stringContaining("outside the hire's directory"),
        });
        expect(await readFile(f.receipts, "utf8")).toBe(bytes);
        // Neither reached the host: no adoption was journaled there.
        for (const name of (await readdir(join(f.home, ".clankie/hire-receipts"))).filter((entry) =>
          entry.endsWith(".json"),
        ))
          expect(JSON.parse(await readFile(join(f.home, ".clankie/hire-receipts", name), "utf8")).state).toBe(
            "launching",
          );
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
  "refuses a pane opened in the hire's directory whose agent runs in a sibling directory",
  async () => {
    const f = await fixture();
    try {
      const directory = join(f.home, "A");
      const paneId = await f.pane(directory, false, join(f.home, "B"));
      expect(await f.runner.get(paneId)).toMatchObject({
        workingDirectory: directory,
        foregroundWorkingDirectory: join(f.home, "B"),
      });
      const original = await f.uncertainHire(directory, paneId);
      f.owners.bind(paneId, lead);
      const store = new HerdrWatchStore(f.watches, { remoteHireReceipts: f.native, runner: f.runner });
      try {
        const bytes = await readFile(f.receipts, "utf8");
        expect(await store.settleHireReceipt(original.receiptId, async () => {}, "adopt")).toMatchObject({
          state: "refused",
          detail: expect.stringContaining("outside the hire's directory"),
        });
        expect(await readFile(f.receipts, "utf8")).toBe(bytes);
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
  "refuses a legacy allocation's pane that an unresolved receipt elsewhere names, even for another harness",
  async () => {
    const f = await fixture();
    try {
      const directory = join(f.home, "A");
      const paneId = await f.pane(directory);
      // A Codex hire at B recorded this very pane.
      await f.uncertainHire(join(f.home, "B"), paneId, "codex");
      const settings = ProjectsSettingsSchema.parse({ projects: [{ id: "game", name: "Game" }] });
      const ledger = new ProjectHires(`${f.watches}.project-hires.json`);
      const allocation = ledger.reserve(
        settings,
        "game",
        SpawnOperatorSeatSchema.parse({
          schemaVersion: 1,
          fleet: "pc",
          harness: "claude",
          title: "Ada",
          workingDirectory: directory,
        }),
      );
      ledger.launch(allocation.id, settings);
      ledger.pane(allocation.id, paneId);
      f.owners.bind(paneId, lead);
      const store = new HerdrWatchStore(f.watches, { remoteHireReceipts: f.native, runner: f.runner });
      try {
        expect(await store.settleHireReceipt(allocation.id, async () => {}, "adopt")).toMatchObject({
          state: "refused",
          detail: expect.stringContaining("An unresolved receipt names this pane"),
        });
        expect(new ProjectHires(`${f.watches}.project-hires.json`).allocation(allocation.id)).toMatchObject({
          confirmed: false,
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
  "refuses when the census changes between its two reads, settling nothing",
  async () => {
    const f = await fixture();
    try {
      const directory = join(f.home, "changing");
      const paneId = await f.pane(directory);
      const original = await f.uncertainHire(directory, paneId);
      f.owners.bind(paneId, lead);
      const store = new HerdrWatchStore(f.watches, { remoteHireReceipts: f.native, runner: f.runner });
      try {
        const bytes = await readFile(f.receipts, "utf8");
        let checks = 0;
        // The last authority check runs just before the final census read.
        const adopted = await store.settleHireReceipt(
          original.receiptId,
          async () => {
            if (++checks === 3) await f.moveAgent(paneId);
          },
          "adopt",
        );
        expect(checks).toBe(3);
        expect(adopted).toMatchObject({
          state: "refused",
          detail: expect.stringContaining("outside the hire's directory"),
        });
        expect(await readFile(f.receipts, "utf8")).toBe(bytes);
      } finally {
        store.close();
      }
    } finally {
      await f.herdr.close();
    }
  },
  120_000,
);
