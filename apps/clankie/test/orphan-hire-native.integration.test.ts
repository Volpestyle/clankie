// Manual Mac-only proof: real isolated Herdr, native Codex TUI/app-server and kernel process births.
// No model turns, credentials, owner panes, PCs or mocked native transports.
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { CodexAppServerClient, openCodexSocket } from "../src/captain/codex-app-server.ts";
import { createHerdrWatchRunner, HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import { routeHerdrFleets } from "../src/captain/herdr-fleet-runner.ts";
import { ProjectHires } from "../src/captain/project-hires.ts";
import { HireOwners } from "../src/captain/hire-owners.ts";
import { DeliveryFence, deliveryFingerprint } from "../src/captain/delivery-fence.ts";
import { PaneTidy } from "../src/captain/pane-tidy.ts";
import { paneInputLine } from "../src/captain/pane-draft.ts";
import { createProjectProcessObserver } from "../src/project-process-proof.ts";
import { retirementWorkProgram } from "../src/captain/remote-retirement-work.ts";
import { createRemoteHireReceipts } from "../src/remote-hire-receipts.ts";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";

const exec = promisify(execFile);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const nativeIt = it.skipIf(process.platform !== "darwin" || process.env.ORPHAN_HIRE_NATIVE_TEST !== "1");
nativeIt.each([
  { qualified: false, restored: false },
  { qualified: true, restored: false },
  { qualified: true, restored: true },
])(
  "guards original hire retirement with native process, lifecycle and retained-work evidence (%j)",
  async ({ qualified, restored }) => {
    const logs = join(
      import.meta.dirname,
      restored ? "../../../docs/testing/2026-10-18-vuh-2477" : "../../../docs/testing/2026-10-12-orphan-hire",
      restored ? "native" : qualified ? "qualified" : "local",
    );
    const herdr = await isolatedHerdr(logs);
    const evidence: unknown[] = [];
    let watch: HerdrWatchStore | undefined;
    let client: CodexAppServerClient | undefined;
    let backend: ReturnType<typeof spawn> | undefined;
    try {
      const root = await realpath(herdr.root);
      const cwd = join(root, "work"),
        home = join(root, "codex-home"),
        rpc = join(root, "codex.sock");
      await mkdir(cwd);
      await mkdir(home);
      await writeFile(
        join(home, "config.toml"),
        `model_provider="proof"\n[model_providers.proof]\nname="No model requests"\nbase_url="http://127.0.0.1:1"\nwire_api="responses"\nrequires_openai_auth=false\n[projects.${JSON.stringify(cwd)}]\ntrust_level="trusted"\n`,
      );
      const git = (...args: string[]) => exec("git", ["-C", cwd, ...args]);
      await git("init", "-b", "main");
      await git(
        "-c",
        "user.name=Native proof",
        "-c",
        "user.email=proof@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "Proof base",
      );
      await git("update-ref", "refs/remotes/origin/main", "HEAD");
      backend = spawn("codex", ["app-server", "--listen", `unix://${rpc}`], {
        cwd,
        env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: home },
        stdio: "ignore",
      });
      await expect
        .poll(
          async () => {
            const socket = await openCodexSocket(`ws+unix://${rpc}:/`);
            if (!socket) return false;
            client = new CodexAppServerClient(socket, () => {}, 15_000);
            return true;
          },
          { timeout: 15_000 },
        )
        .toBe(true);
      await client!.initialize(true);
      const created = await herdr.cli("workspace", "create", "--cwd", cwd, "--no-focus");
      const pane = created.result.root_pane.pane_id as string;
      await herdr.cli(
        "pane",
        "run",
        pane,
        [
          "env",
          `CODEX_HOME=${home}`,
          "codex",
          "--remote",
          `unix://${rpc}`,
          "--cd",
          cwd,
          "--no-alt-screen",
          "-c",
          "check_for_update_on_startup=false",
        ]
          .map(quote)
          .join(" "),
      );
      let thread = "";
      await expect
        .poll(
          async () => {
            const loaded = (await client!.request("thread/loaded/list", {})) as { data: string[] };
            thread = loaded.data.length === 1 ? loaded.data[0]! : "";
            return thread;
          },
          { timeout: 15_000 },
        )
        .not.toBe("");
      await herdr.cli(
        "pane",
        "report-agent",
        pane,
        "--source",
        "herdr:codex",
        "--agent",
        "codex",
        "--state",
        "idle",
        "--agent-session-id",
        thread,
      );
      const binding = { runtime: "external" as const, socketPath: herdr.socketPath, session: "default" };
      const run = async (args: readonly string[]) =>
        (
          await exec("herdr", [...args], {
            env: { ...process.env, HERDR_SOCKET_PATH: herdr.socketPath },
            timeout: 10_000,
          })
        ).stdout;
      const local = createHerdrWatchRunner(undefined, run, undefined, {
        localCodexRecovery: false,
        localReadBinding: async () => binding,
      });
      const runner = qualified ? routeHerdrFleets(local, new Map([["mac-proof", local]])) : local;
      const fleet = qualified ? "mac-proof" : "default";
      const address = qualified ? `mac-proof/${pane}` : pane;
      const nativeObserver = createProjectProcessObserver({
        binding: async () => binding,
        herdrBinary: "herdr",
        run: async (file, args, env) => (await exec(file, [...args], { env, timeout: 10_000 })).stdout,
        refusal: (reason) => evidence.push({ observerRefusal: reason }),
      });
      const observe = async () => {
        const proof = await nativeObserver("default", pane);
        return proof && { ...proof, fleet, pane: address };
      };
      await expect.poll(observe, { timeout: 15_000 }).toBeDefined();
      const originalProof = (await observe())!;
      const agent = await runner.get(address);
      const authority = {
        owner: { conversationId: "owned-native-proof" },
        current: () => true,
        authorize: async () => true,
      };
      const settings = ProjectsSettingsSchema.parse({ projects: [{ id: "proof", name: "Proof" }] });
      const watchPath = join(root, "watch.json");
      const allocations = new ProjectHires(`${watchPath}.project-hires.json`);
      const request = {
        schemaVersion: 1 as const,
        harness: "codex" as const,
        title: "Disposable orphan",
        workingDirectory: cwd,
        ...(qualified ? { fleet } : {}),
        freshIntent: { id: randomUUID(), afterReceiptId: randomUUID() },
      };
      const claim = allocations.reserve(settings, "proof", request);
      allocations.pane(claim.id, address);
      allocations.observe(claim.id, agent.terminalId, originalProof.nativeOccupantId, originalProof);
      const originalSeat = restored ? `${fleet}/term_before_restore` : agent.terminalId;
      new HireOwners(`${watchPath}.owners.json`).bind(
        address,
        authority.owner,
        originalSeat,
        undefined,
        originalProof.nativeOccupantId,
        JSON.stringify([qualified ? fleet : "local", "codex", thread]),
      );
      if (qualified && !restored) {
        // Older ownership journals lack hired:true; the exact retained launch still proves provenance.
        const ownershipPath = `${watchPath}.owners.json`;
        const ownership = JSON.parse(await readFile(ownershipPath, "utf8"));
        delete ownership.hires[0].hired;
        await writeFile(ownershipPath, JSON.stringify(ownership));
      }
      const fence = new DeliveryFence(`${watchPath}.hire-receipts.json`);
      const baseKey = JSON.stringify([qualified ? fleet : "local", "codex", cwd, "new"]);
      const key = JSON.stringify([qualified ? fleet : "local", "codex", cwd, "new", request.freshIntent.id]);
      const fingerprint = deliveryFingerprint("Never sent orphan proof brief");
      const receipt = fence.begin(key, {
        fingerprint,
        freshHire: {
          ...request.freshIntent,
          baseKey: restored ? baseKey : key,
          owner: authority.owner,
          launch: {
            schemaVersion: 1,
            harness: "codex",
            title: request.title,
            workingDirectory: cwd,
            ...(qualified ? { fleet } : {}),
          },
        },
        paneId: address,
        occupantId: originalProof.nativeOccupantId,
        sessionId: thread,
        briefNotSent: true,
        ...(restored
          ? {
              remoteAdmission: {
                target: { fleet, host: "this-mac-only", session: "default", shell: "posix" as const },
                nonce: "a".repeat(64),
              },
              remoteLaunchCommitted: true as const,
            }
          : {}),
      });
      const census = await runner.list!(qualified ? fleet : undefined);
      if (restored) {
        // Restore the production failure shape into our disposable native host:
        // a completed session whose allocation still names its pre-reboot seat/process.
        fence.reconcile(key, receipt.messageId, true);
        allocations.confirmed(claim.id);
        const state = JSON.parse(await readFile(`${watchPath}.project-hires.json`, "utf8"));
        state.allocations[0].seat = originalSeat;
        state.allocations[0].proof.processes = [{ pid: 1, startTime: "before-restore" }];
        state.allocations[0].proof.shell = { pid: 2, startTime: "before-restore" };
        await writeFile(`${watchPath}.project-hires.json`, JSON.stringify(state));
      } else
        fence.settleRecovery(key, receipt.messageId, {
          receiptId: receipt.messageId,
          receiptKey: key,
          fingerprint,
          disposition: "abandoned",
          journal: "authenticated-recovery",
          target: { fleet, host: "this-mac-only", session: "default", shell: "posix" },
          hostIdentity: root,
          census: {
            observedAt: Date.now(),
            panes: census.length,
            processes: originalProof.processes.length,
            sessions: 1,
            sha256: createHash("sha256").update(JSON.stringify(census)).digest("hex"),
          },
          allocation: {
            paneId: address,
            present: true,
            terminalId: agent.terminalId,
            sessionId: thread,
            status: agent.status,
          },
        });
      if (!restored) {
        allocations.failed(claim.id);
        expect(allocations.recoveryCandidate(claim.id)?.gone).toBe(false);
      }
      const next = { ...request, freshIntent: { id: randomUUID(), afterReceiptId: receipt.messageId } };
      watch = new HerdrWatchStore(watchPath, {
        runner,
        ...(restored
          ? {
              remoteHireReceipts: createRemoteHireReceipts({
                fleet: async () => ({
                  id: fleet,
                  session: "default",
                  ssh: { host: "this-mac-only", shell: "posix" },
                }),
                shell: () => async (command) =>
                  (
                    await exec("/bin/sh", ["-c", command], {
                      env: { ...process.env, HOME: root },
                      timeout: 15000,
                    })
                  ).stdout,
              }),
            }
          : {}),
        remoteWorkspace: async (selected, directory) => selected === fleet && directory === cwd,
        projectHirePolicy: { settings: async () => settings, project: async () => "proof", proof: observe },
      });
      const refused = await watch.spawnSeat(
        next,
        undefined,
        "New distinct proof brief",
        undefined,
        authority,
      );
      evidence.push({
        phase: "allocation-blocker",
        allocation: claim.id,
        receipt: receipt.messageId,
        refused,
        originalProof,
      });
      expect(refused).toMatchObject({ outcome: "failed", reason: "not_ready" });
      if (restored) expect("detail" in refused && refused.detail).toContain("pane-absent inventory");
      else {
        expect("detail" in refused && refused.detail).toContain(claim.id);
        expect("detail" in refused && refused.detail).toContain(address);
        expect("detail" in refused && refused.detail).toContain(receipt.messageId);
        expect("detail" in refused && refused.detail).toContain("close_worker_pane");
      }
      // No model turn is running; retain the live native backend until guarded retirement.
      // A disconnected view with an unreadable composer must still refuse.
      evidence.push({ phase: "native-screen", ansi: await runner.readPane!(address, "visible", "ansi") });
      await expect
        .poll(async () => paneInputLine("codex", await runner.readPane!(address, "visible", "ansi")).state, {
          timeout: 15_000,
        })
        .toBe("empty");
      expect(await observe()).toBeDefined();
      await herdr.cli(
        "pane",
        "report-agent",
        pane,
        "--source",
        "herdr:codex",
        "--agent",
        "codex",
        "--state",
        "idle",
        "--agent-session-id",
        thread,
      );
      evidence.push({
        phase: "native-idle",
        snapshot: await runner.get(address),
        raw: await herdr.cli("agent", "get", pane),
        native: await client!.request("thread/read", { threadId: thread, includeTurns: false }),
      });
      const reportPath = join(root, "report.md");
      await writeFile(
        reportPath,
        "Orphan proof: no model turn or brief dispatched; abandoned native hire retained.\n",
      );
      const tidy = new PaneTidy(join(root, "tidy.json"), {
        runner,
        provenance: (value) => watch!.tidyProvenance(value),
        retirementGuard: (value) => watch!.retirementGuard(value),
        ownerValid: async () => true,
        close: (seat, guard) => watch!.closeSeat(seat, guard),
        untrack: () => {},
        hire: async () => {
          throw Error("No replay allowed");
        },
        changed: () => {},
        ...(qualified
          ? {
              worktreeHold: async (value) =>
                JSON.parse(
                  (await exec(process.execPath, ["-e", retirementWorkProgram([value.workingDirectory!])]))
                    .stdout,
                ),
            }
          : {}),
      });
      const close = () =>
        tidy.close(
          { pane: address, reason: "Abandoned original with report retained", reportPath },
          authority,
        );
      if (restored && (await runner.get(address)).status === "unknown") {
        // Current Herdr cannot observe lifecycle for this bare remote Codex TUI.
        // Record the real boundary refusal; never synthesize idle to make a close pass.
        const held = await close();
        evidence.push({ phase: "native-lifecycle-unknown-held", result: held, proof: await observe() });
        expect(held).toMatchObject({
          outcome: "failed",
          reason: "provenance_unknown",
          detail: "Restored hire is not idle",
        });
        expect((await runner.list!(fleet)).some((entry) => entry.paneId === address)).toBe(true);
        expect(allocations.retirementCandidate(fleet, address)).toBeDefined();
        expect(new DeliveryFence(`${watchPath}.hire-receipts.json`).all()).toEqual(fence.all());
        return;
      }
      const other = await tidy.close(
        { pane: address, reason: "Not my hire", reportPath },
        { ...authority, owner: { conversationId: "other" } },
      );
      evidence.push({ phase: "other-owner", result: other });
      expect(other).toMatchObject({ outcome: "refused", reason: "not_owner" });
      await writeFile(join(cwd, "unlanded.txt"), "Keep me");
      const dirty = await close();
      evidence.push({ phase: "dirty-work", result: dirty });
      expect(dirty).toMatchObject({ outcome: "refused", reason: "unlanded_work" });
      const { unlink } = await import("node:fs/promises");
      await unlink(join(cwd, "unlanded.txt"));
      await herdr.cli("pane", "send-text", pane, "Owned unsent draft");
      await expect
        .poll(async () => paneInputLine("codex", await runner.readPane!(address, "visible", "ansi")).state)
        .toBe("draft");
      const draft = await close();
      evidence.push({ phase: "unsent-draft", result: draft });
      expect(draft).toMatchObject({ outcome: "refused", reason: "unsent_draft" });
      await herdr.cli("pane", "send-keys", pane, "ctrl+u");
      await expect
        .poll(async () => paneInputLine("codex", await runner.readPane!(address, "visible", "ansi")).state)
        .toBe("empty");
      const saved = JSON.parse(await readFile(`${watchPath}.project-hires.json`, "utf8"));
      const changed = structuredClone(saved);
      if (restored) changed.allocations[0].proof.binding.socketPath += "-changed";
      else changed.allocations[0].proof.processes[0].startTime += "-changed";
      await writeFile(`${watchPath}.project-hires.json`, JSON.stringify(changed));
      const mismatch = await close();
      evidence.push({
        phase: restored ? "wrong-original-binding" : "wrong-original-birth",
        result: mismatch,
      });
      expect(mismatch).toMatchObject({ outcome: "failed", reason: "provenance_unknown" });
      await writeFile(`${watchPath}.project-hires.json`, JSON.stringify(saved));
      const closed = await close();
      evidence.push({ phase: "guarded-retirement", result: closed });
      expect(closed).toMatchObject({ outcome: "closed" });
      if (restored)
        expect(closed).toMatchObject({
          entry: { restoredHire: { originalSeatId: originalSeat, proof: { shell: originalProof.shell } } },
        });
      expect(
        (await runner.list!(qualified ? fleet : undefined)).some((value) => value.paneId === address),
      ).toBe(false);
      expect(allocations.retirementCandidate(fleet, address)).toBeUndefined();
      expect(allocations.reserve(settings, "proof", next).id).not.toBe(claim.id);
      if (restored)
        expect(new DeliveryFence(`${watchPath}.hire-receipts.json`).all()[0]![1]).toMatchObject({
          completed: expect.any(Object),
          retired: expect.any(Object),
        });
      else expect(new DeliveryFence(`${watchPath}.hire-receipts.json`).all()).toEqual(fence.all());
      evidence.push({
        phase: "released-no-replay",
        nativeReceiptUnchanged: true,
        freshAllocationAdmitted: true,
      });
    } finally {
      await writeFile(join(logs, "proof.json"), JSON.stringify(evidence, null, 2));
      watch?.close();
      await client?.close();
      if (backend && backend.exitCode === null && backend.signalCode === null) backend.kill("SIGTERM");
      await herdr.close();
    }
  },
  90_000,
);
