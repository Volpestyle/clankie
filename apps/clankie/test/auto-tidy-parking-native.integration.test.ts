// Manual Mac-only proof (VUH-2802 part d): two real idle Claude TUIs in an isolated Herdr hold
// finished local hires whose worktrees carry clean, unlanded commits. Auto-tidy and the
// close_worker_pane path park those commits on a keep/ branch, record it in the close receipt and
// close the native pane. Dirty work and a taken park name still refuse. No model turn: Claude
// starts without a prompt, with the Clankie plugins disabled. Run with
// AUTO_TIDY_PARKING_NATIVE_TEST=1 and CLAUDE_NATIVE_CONFIG_DIR for a non-default profile.
import { execFile } from "node:child_process";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createAutoTidy, type AutoTidyHeld } from "../src/captain/auto-tidy.ts";
import type { ConversationAuthority } from "../src/captain/conversation-owner.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import {
  createHerdrWatchRunner,
  HerdrWatchStore,
  type HerdrAgentSnapshot,
} from "../src/captain/herdr-watch.ts";
import { HireOwners } from "../src/captain/hire-owners.ts";
import { nativeSessionId } from "../src/captain/native-session-resume.ts";
import { autoTidyHeldReview } from "../src/captain/fleet-review.ts";
import { PaneTidy, parkedRefs } from "../src/captain/pane-tidy.ts";
import { workerWorktreeHold } from "../src/captain/worktree-decisions.ts";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";

const exec = promisify(execFile);
const nativeIt = it.skipIf(
  process.platform !== "darwin" || process.env.AUTO_TIDY_PARKING_NATIVE_TEST !== "1",
);
const git = async (cwd: string, ...args: string[]) =>
  (
    await exec(
      "git",
      [
        "-C",
        cwd,
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      { env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))) },
    )
  ).stdout.trim();
const lead = { conversationId: "lead" };
const authority: ConversationAuthority = { owner: lead, current: () => true, authorize: async () => true };

nativeIt(
  "parks clean unlanded commits on a keep ref, records them in the close receipt and closes the real pane",
  async () => {
    const logs = join(import.meta.dirname, "../../../docs/testing/2026-10-25-vuh-2802/parking");
    const herdr = await isolatedHerdr(logs);
    const evidence: unknown[] = [];
    let store: HerdrWatchStore | undefined;
    try {
      const root = await realpath(herdr.root);
      // Folder trust is the owner's decision, so each TUI runs in this already-trusted checkout.
      // The work under test is in disposable worktrees of a separate repository.
      const cwd = await realpath(join(import.meta.dirname, "../../.."));
      const repo = join(root, "repo");
      await mkdir(repo);
      await git(repo, "init", "--quiet", "--initial-branch", "main");
      await git(repo, "commit", "--quiet", "--allow-empty", "-m", "landed");
      await git(repo, "clone", "--bare", "--quiet", repo, join(root, "origin.git"));
      await git(repo, "remote", "add", "origin", join(root, "origin.git"));
      await git(repo, "fetch", "--quiet", "origin");
      const autoTree = join(root, "auto");
      const manualTree = join(root, "manual");
      await git(repo, "worktree", "add", "--quiet", "-b", "rook/vuh-2802-spike", autoTree, "origin/main");
      await git(repo, "worktree", "add", "--quiet", "--detach", manualTree, "origin/main");

      const env = { ...process.env, HERDR_SOCKET_PATH: herdr.socketPath };
      const run = async (args: readonly string[]) =>
        (await exec("herdr", [...args], { env, timeout: 10_000 })).stdout;
      const runner = createHerdrWatchRunner(undefined, run, undefined, { localCodexRecovery: false });
      // The owner's onboarded native install and profile (the suite isolates HOME), never a pane
      // shim. The isolated Herdr's XDG directories must not reach Claude, whose installer would
      // repoint the owner's launcher into them: real directories, and no update during the proof.
      const home = userInfo().homedir;
      const launcher = join(home, ".local/bin/claude");
      const claude = await realpath(launcher);
      const config = process.env.CLAUDE_NATIVE_CONFIG_DIR;
      const profile = `env -u XDG_CONFIG_HOME -u XDG_STATE_HOME -u XDG_DATA_HOME -u XDG_CACHE_HOME -u XDG_RUNTIME_DIR DISABLE_AUTOUPDATER=1 HOME='${home}' ${config ? `CLAUDE_CONFIG_DIR='${config}' ` : ""}`;
      const isolation = JSON.stringify({
        enabledPlugins: { "clankie-worker@clankie": false, "clankie@clankie": false },
      });
      const panes = [herdr.pane, herdr.foreignPane];
      for (const pane of panes)
        await herdr.cli(
          "pane",
          "run",
          pane,
          `cd '${cwd}' && ${profile}'${launcher}' --strict-mcp-config --settings '${isolation}'`,
        );
      const agents = new Map<string, HerdrAgentSnapshot>();
      for (const pane of panes) {
        let started: unknown;
        let ready = false;
        try {
          await expect
            .poll(
              async () => {
                const agent = await runner.get(pane).catch(() => undefined);
                started = agent;
                return (
                  agent?.agent === "claude" && agent.status === "idle" && nativeSessionId(agent) !== undefined
                );
              },
              { timeout: 60_000, interval: 500 },
            )
            .toBe(true);
          ready = true;
        } finally {
          evidence.push({
            phase: "claude-start",
            pane,
            agent: started,
            ...(ready
              ? {}
              : { screen: await run(["pane", "read", pane, "--source", "visible"]).catch(String) }),
          });
        }
        agents.set(pane, await runner.get(pane));
      }

      const path = join(root, "watches.json");
      const owners = new HireOwners(`${path}.owners.json`);
      for (const agent of agents.values())
        owners.bind(
          agent.paneId,
          lead,
          agent.terminalId,
          undefined,
          occupantIdForHerdrSession(agent.session!),
          JSON.stringify(["local", "claude", nativeSessionId(agent)]),
        );
      store = new HerdrWatchStore(path, { runner });
      const trees = new Map([
        [herdr.pane, autoTree],
        [herdr.foreignPane, manualTree],
      ]);
      const tidy = new PaneTidy(join(root, "pane-tidy.json"), {
        runner,
        provenance: (seat) => store!.tidyProvenance(seat),
        retirementGuard: (seat) => store!.retirementGuard(seat),
        ownerValid: async () => true,
        close: (seatId, guard, nativeOnly) => store!.closeSeat(seatId, guard, nativeOnly),
        untrack: (seatId) => store!.untrackSeat(seatId),
        hire: async () => {
          throw new Error("No hire in a tidy proof");
        },
        // Each pane's work is its disposable worktree, read by the production Git reconciliation.
        worktreeHold: (seat, options) => {
          const tree = trees.get(seat.paneId)!;
          return workerWorktreeHold(
            { ...seat, workingDirectory: tree, foregroundWorkingDirectory: tree },
            options,
          );
        },
        changed: () => {},
      });
      for (const agent of agents.values()) tidy.keepReport(agent, "VUH-2802 fixture report: spike parked.");
      const keeps = async () =>
        git(repo, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/keep/");
      const present = async (pane: string) => (await runner.list!()).some((entry) => entry.paneId === pane);

      // close_worker_pane: dirty work refuses, with or without a reason, and parks nothing.
      await writeFile(join(manualTree, "notes.txt"), "uncommitted\n");
      for (const unlandedReason of [undefined, "Spike for the owner"]) {
        const refused = await tidy.close(
          { pane: herdr.foreignPane, reason: "Spike done", ...(unlandedReason ? { unlandedReason } : {}) },
          authority,
        );
        evidence.push({ phase: "manual-dirty", unlandedReason, result: refused });
        expect(refused).toMatchObject({
          outcome: "refused",
          reason: "unlanded_work",
          worktrees: [{ dirtyFiles: 1 }],
        });
      }
      expect(await keeps()).toBe("");
      expect(await present(herdr.foreignPane)).toBe(true);
      // Two clean detached commits no branch holds: parked, recorded and closed.
      await git(manualTree, "add", "notes.txt");
      await git(manualTree, "commit", "--quiet", "-m", "spike one");
      await writeFile(join(manualTree, "notes.txt"), "uncommitted\nsecond\n");
      await git(manualTree, "commit", "--quiet", "-am", "spike two");
      const manualHead = await git(manualTree, "rev-parse", "HEAD");
      const manualCommits = (await git(manualTree, "rev-list", "origin/main..HEAD")).split("\n");
      expect(await git(repo, "for-each-ref", "--contains", manualHead)).toBe("");
      const manual = await tidy.close({ pane: herdr.foreignPane, reason: "Spike done" }, authority);
      const manualRef = manual.outcome === "closed" ? manual.entry.handoffs?.[0]?.reference : undefined;
      // A detached HEAD names its park after the pane title.
      expect(manualRef).toMatch(new RegExp(`^refs/heads/keep/[a-z0-9._-]+-${manualHead.slice(0, 12)}$`, "u"));
      evidence.push({
        phase: "manual-closed",
        result: manual.outcome === "closed" ? { ...manual.entry, lastOutput: "(omitted)" } : manual,
        parked: manual.outcome === "closed" ? parkedRefs(manual.entry) : [],
        keeps: await keeps(),
      });
      expect(manual).toMatchObject({
        outcome: "closed",
        entry: {
          state: "closed",
          handoffs: [{ kind: "parked", reference: manualRef, head: manualHead, path: manualTree }],
        },
      });
      expect(manual.outcome === "closed" && [...manual.entry.handoffs![0]!.commits].sort()).toEqual(
        [...manualCommits].sort(),
      );
      expect(await git(repo, "rev-parse", manualRef!)).toBe(manualHead);
      await expect.poll(() => present(herdr.foreignPane), { timeout: 15_000 }).toBe(false);

      // Auto-tidy: dirty work holds, a park name someone else holds is never moved, then it parks.
      let clock = Date.now();
      const notices: { entries: unknown[]; parked: string[][] }[] = [];
      const auto = createAutoTidy({
        setting: async () => "1h",
        runner,
        tidy,
        provenance: (seat) => store!.tidyProvenance(seat),
        unreadReports: () => 0,
        ownerValid: async () => true,
        closed: async (_lead, entries) => {
          notices.push({ entries: [...entries], parked: entries.map((entry) => parkedRefs(entry)) });
        },
        checkouts: async () => [],
        prune: async () => {
          throw new Error("No prune in a pane proof");
        },
        stopped: () => false,
        now: () => clock,
      });
      const tick = async (minutes: number) => {
        clock += minutes * 60_000;
        const result = await auto.panes();
        const held: AutoTidyHeld[] = auto.held(lead.conversationId);
        evidence.push({
          phase: `auto-tick+${minutes}m`,
          closed: result.map(({ lastOutput: _output, ...entry }) => entry),
          held,
          keeps: await keeps(),
        });
        return { result, held };
      };
      await writeFile(join(autoTree, "spike.txt"), "prototype\n");
      expect(await tick(0)).toEqual({ result: [], held: [] });
      expect(await tick(61)).toMatchObject({ result: [], held: [{ blocker: "unlanded_work" }] });
      const review = autoTidyHeldReview(auto.held(lead.conversationId));
      evidence.push({ phase: "lead-round", text: review.text });
      expect(review.text).toContain("clean commits park on a keep/ branch");
      await git(autoTree, "add", "spike.txt");
      await git(autoTree, "commit", "--quiet", "-m", "prototype");
      const autoHead = await git(autoTree, "rev-parse", "HEAD");
      const autoRef = `refs/heads/keep/vuh-2802-spike-${autoHead.slice(0, 12)}`;
      const landed = await git(repo, "rev-parse", "main");
      await git(repo, "update-ref", autoRef, landed);
      expect(await tick(61)).toMatchObject({ result: [], held: [{ blocker: "unlanded_work" }] });
      expect(await git(repo, "rev-parse", autoRef)).toBe(landed);
      expect(await present(herdr.pane)).toBe(true);
      await git(repo, "update-ref", "-d", autoRef, landed);
      const { result } = await tick(61);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        paneId: herdr.pane,
        state: "closed",
        handoffs: [
          { kind: "parked", reference: autoRef, head: autoHead, commits: [autoHead], path: autoTree },
        ],
      });
      expect(notices).toMatchObject([
        { parked: [[`keep/vuh-2802-spike-${autoHead.slice(0, 12)} at ${autoHead.slice(0, 12)} (1 commit)`]] },
      ]);
      expect(auto.held(lead.conversationId)).toEqual([]);
      await expect.poll(() => present(herdr.pane), { timeout: 15_000 }).toBe(false);
      expect(tidy.decisions.latest(autoTree, autoHead)).toMatchObject({
        decision: "closed_unreconciled",
        reason: `Parked on ${autoRef}`,
      });

      // Recoverable after the worktrees, the worker branch and every reflog are gone.
      await git(repo, "worktree", "remove", autoTree);
      await git(repo, "worktree", "remove", manualTree);
      await git(repo, "branch", "-D", "rook/vuh-2802-spike");
      await git(
        repo,
        "-c",
        "gc.reflogExpire=now",
        "-c",
        "gc.reflogExpireUnreachable=now",
        "reflog",
        "expire",
        "--all",
      );
      await git(repo, "gc", "--quiet", "--prune=now");
      const recovered = {
        auto: await git(repo, "show", `${autoRef}:spike.txt`),
        manual: await git(repo, "log", "--format=%H %s", manualRef!),
        keeps: await keeps(),
      };
      evidence.push({ phase: "recovered-after-gc", ...recovered });
      expect(recovered.auto).toBe("prototype");
      expect(recovered.manual.split("\n").map((line) => line.split(" ")[0])).toEqual(
        expect.arrayContaining(manualCommits),
      );
      expect(tidy.leadHistory().map((entry) => entry.paneId)).toEqual([herdr.pane, herdr.foreignPane]);
      expect(await realpath(launcher)).toBe(claude);
    } finally {
      store?.close();
      await mkdir(logs, { recursive: true });
      await writeFile(join(logs, "results.json"), JSON.stringify(evidence, null, 2));
      await herdr.close();
      await rm(join(logs, "herdr.log"), { force: true });
    }
  },
  240_000,
);
