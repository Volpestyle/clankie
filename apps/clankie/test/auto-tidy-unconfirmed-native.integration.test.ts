// Manual Mac-only proof (VUH-2802): a real idle Claude TUI in an isolated Herdr holds a local
// project hire whose start never confirmed. Auto-tidy adopts it only from the exact native session
// its original receipt observed, then closes it through the real guarded close. No model turn:
// Claude starts without a prompt, with the Clankie worker plugin disabled. Run with
// AUTO_TIDY_UNCONFIRMED_NATIVE_TEST=1 and CLAUDE_NATIVE_CONFIG_DIR for a non-default profile.
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createAutoTidy, type AutoTidyHeld } from "../src/captain/auto-tidy.ts";
import { DeliveryFence, ReceiptSchema } from "../src/captain/delivery-fence.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import { createHerdrWatchRunner, HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import { HireOwners } from "../src/captain/hire-owners.ts";
import { nativeSessionId } from "../src/captain/native-session-resume.ts";
import { autoTidyHeldReview } from "../src/captain/fleet-review.ts";
import { PaneTidy } from "../src/captain/pane-tidy.ts";
import { ProjectHires } from "../src/captain/project-hires.ts";
import { workerWorktreeHold } from "../src/captain/worktree-decisions.ts";
import { createProjectProcessObserver } from "../src/project-process-proof.ts";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";

const exec = promisify(execFile);
const nativeIt = it.skipIf(
  process.platform !== "darwin" || process.env.AUTO_TIDY_UNCONFIRMED_NATIVE_TEST !== "1",
);
const git = (cwd: string, ...args: string[]) =>
  exec("git", ["-C", cwd, "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  });

nativeIt(
  "auto-tidy adopts an unconfirmed local Claude hire from its observed session, then closes it",
  async () => {
    const logs = join(import.meta.dirname, "../../../docs/testing/2026-10-25-vuh-2802/auto-tidy");
    const herdr = await isolatedHerdr(logs);
    const evidence: unknown[] = [];
    let store: HerdrWatchStore | undefined;
    try {
      const root = await realpath(herdr.root);
      // Folder trust is the owner's decision, so the TUI runs in this already-trusted checkout.
      // Its own edits are not the subject: the landed-work proof reads a separate landed repository.
      const cwd = await realpath(join(import.meta.dirname, "../../.."));
      const repo = join(root, "repo");
      const landed = join(root, "landed");
      await mkdir(repo);
      await git(repo, "init", "--quiet", "--initial-branch", "main");
      await git(
        repo,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "landed",
      );
      await git(repo, "clone", "--bare", "--quiet", repo, join(root, "origin.git"));
      await git(repo, "remote", "add", "origin", join(root, "origin.git"));
      await git(repo, "fetch", "--quiet", "origin");
      await git(repo, "worktree", "add", "--quiet", "-b", "juniper/vuh-2802", landed, "origin/main");
      const env = { ...process.env, HERDR_SOCKET_PATH: herdr.socketPath };
      const run = async (args: readonly string[]) =>
        (await exec("herdr", [...args], { env, timeout: 10_000 })).stdout;
      const runner = createHerdrWatchRunner(undefined, run, undefined, { localCodexRecovery: false });
      // The owner's onboarded native install and profile (the suite isolates HOME), never a pane
      // shim that chooses its own. Claude records this directory's trust and session there.
      const home = userInfo().homedir;
      // Herdr detects the harness by its launched name; process proof checks the resolved release.
      const launcher = join(home, ".local/bin/claude");
      const claude = await realpath(launcher);
      const installed = async () => realpath(launcher);
      const config = process.env.CLAUDE_NATIVE_CONFIG_DIR;
      // The isolated Herdr's XDG directories must not reach Claude: its installer would repoint the
      // owner's launcher into them. Real directories, and no update during the proof.
      const profile = `env -u XDG_CONFIG_HOME -u XDG_STATE_HOME -u XDG_DATA_HOME -u XDG_CACHE_HOME -u XDG_RUNTIME_DIR DISABLE_AUTOUPDATER=1 HOME='${home}' ${config ? `CLAUDE_CONFIG_DIR='${config}' ` : ""}`;
      const isolation = JSON.stringify({
        enabledPlugins: { "clankie-worker@clankie": false, "clankie@clankie": false },
      });
      await herdr.cli(
        "pane",
        "run",
        herdr.pane,
        `cd '${cwd}' && ${profile}'${launcher}' --strict-mcp-config --settings '${isolation}'`,
      );
      let started: unknown;
      let ready = false;
      try {
        await expect
          .poll(
            async () => {
              const agent = await runner.get(herdr.pane).catch(() => undefined);
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
        // The screen only explains a failed start; a ready one keeps no local terminal text.
        evidence.push({
          phase: "claude-start",
          agent: started,
          ...(ready
            ? {}
            : { screen: await run(["pane", "read", herdr.pane, "--source", "visible"]).catch(String) }),
        });
      }
      const binding = { runtime: "external" as const, socketPath: herdr.socketPath, session: "default" };
      const proof = createProjectProcessObserver({
        binding: async () => binding,
        herdrBinary: "herdr",
        launcher: async (harness) => (harness === "claude" ? { executable: claude } : undefined),
        run: async (file, args, childEnv) =>
          (await exec(file, [...args], { env: childEnv ?? env, timeout: 10_000 })).stdout,
        refusal: (reason, pane) => evidence.push({ proofRefusal: reason, pane }),
      });
      await expect.poll(() => proof("default", herdr.pane), { timeout: 15_000 }).toBeDefined();
      const agent = await runner.get(herdr.pane);
      const occupantId = occupantIdForHerdrSession(agent.session!);
      const sessionId = nativeSessionId(agent)!;
      evidence.push({ phase: "native-claude", agent: { ...agent, workingDirectory: "(fixture)" } });

      // Restore the live start_unconfirmed journals, translating only directory, pane and occupant.
      const golden = JSON.parse(
        await readFile(
          new URL("./fixtures/hire-receipts/local-unconfirmed-claude-start.json", import.meta.url),
          "utf8",
        ),
      );
      const path = join(root, "watches.json");
      await writeFile(
        `${path}.project-hires.json`,
        JSON.stringify({
          version: 1,
          allocations: [
            {
              ...golden.allocation,
              key: JSON.stringify(["default", cwd]),
              pane: herdr.pane,
              seat: agent.terminalId,
              occupantId,
              proof: await proof("default", herdr.pane),
              request: { ...golden.allocation.request, workingDirectory: cwd },
            },
          ],
        }),
      );
      const owner = golden.owner.owner as { conversationId: string };
      new HireOwners(`${path}.owners.json`).bind(
        herdr.pane,
        owner,
        agent.terminalId,
        golden.owner.id,
        occupantId,
        JSON.stringify(["local", "claude", sessionId]),
        golden.owner.hireProjectId,
      );
      const key = JSON.stringify(["local", "claude", cwd, "new"]);
      const receiptId = golden.receipt.messageId as string;
      // First as a receipt that never recorded its session, as pre-VUH-2499 starts did.
      const { occupantId: _occupant, sessionId: _session, ...unobserved } = golden.receipt;
      new DeliveryFence(`${path}.hire-receipts.json`).begin(
        key,
        ReceiptSchema.parse({ ...unobserved, paneId: herdr.pane }),
      );
      const open = () =>
        new HerdrWatchStore(path, {
          runner,
          projectHirePolicy: {
            settings: async () => {
              throw new Error("Auto-tidy reads no project settings");
            },
            project: async () => undefined,
            proof,
          },
        });
      store = open();
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
        nativeExitAvailable: (seat) => store!.nativeExitAvailable(seat),
        worktreeHold: (seat, options) =>
          workerWorktreeHold(
            { ...seat, workingDirectory: landed, foregroundWorkingDirectory: landed },
            options,
          ),
        changed: () => {},
      });
      tidy.keepReport(agent, "VUH-2802 fixture report: work landed on main.");
      let clock = Date.now();
      let unread = 1;
      const closed: { owner: unknown; entries: unknown[]; adopted: readonly string[] }[] = [];
      const auto = createAutoTidy({
        setting: async () => "1h",
        runner,
        tidy,
        provenance: (seat) => store!.tidyProvenance(seat),
        unreadReports: () => unread,
        ownerValid: async () => true,
        adoptUnconfirmed: (seat, lead, guard) => store!.adoptUnconfirmedForTidy(seat, lead, guard),
        closed: async (lead, entries, adopted) => {
          closed.push({ owner: lead, entries: [...entries], adopted });
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
        const held: AutoTidyHeld[] = auto.held(owner.conversationId);
        evidence.push({ phase: `tick+${minutes}m`, closed: result.length, held });
        return { result, held };
      };
      const pending = () => new DeliveryFence(`${path}.hire-receipts.json`).pending(key);

      expect(await tick(0)).toEqual({ result: [], held: [] });
      // Past the window, an unread report still holds it, and nothing is adopted for it.
      const unreadHeld = await tick(61);
      expect(unreadHeld).toMatchObject({
        result: [],
        held: [{ blocker: "reports_unread", unreadReports: 1 }],
      });
      // The lead's round names the seat and what it can do about it.
      const review = autoTidyHeldReview(unreadHeld.held);
      evidence.push({ phase: "lead-round", text: review.text });
      expect(review.text).toContain(herdr.pane);
      expect(review.text).toContain("acknowledge_worker_reports");
      expect(pending()?.messageId).toBe(receiptId);
      // Read: a receipt that never observed this session is not adopted, so the close refuses.
      unread = 0;
      expect(await tick(61)).toMatchObject({ result: [], held: [{ blocker: "provenance_unknown" }] });
      expect(pending()?.messageId).toBe(receiptId);
      expect(
        new ProjectHires(`${path}.project-hires.json`).retirementCandidate("default", herdr.pane),
      ).toMatchObject({ confirmed: false });

      // The original hire recorded its observed session (the live receipt): adopt, then close.
      store.close();
      const fence = new DeliveryFence(`${path}.hire-receipts.json`);
      fence.update(key, receiptId, { occupantId, sessionId });
      store = open();
      const { result } = await tick(61);
      evidence.push({
        phase: "closed",
        result: result.map(({ lastOutput: _output, ...entry }) => entry),
        adopted: closed.map((group) => group.adopted),
      });
      expect(result).toHaveLength(1);
      expect(closed).toMatchObject([{ owner, adopted: [receiptId] }]);
      expect(auto.held(owner.conversationId)).toEqual([]);
      expect(pending()).toBeUndefined();
      expect(new DeliveryFence(`${path}.hire-receipts.json`).settlement(receiptId)).toMatchObject({
        disposition: "adopted",
        pane: { paneId: herdr.pane, occupantId, sessionId, owner },
      });
      expect(new ProjectHires(`${path}.project-hires.json`).allocation(golden.allocation.id)).toMatchObject({
        confirmed: true,
      });
      await expect
        .poll(async () => (await runner.list!()).some((pane) => pane.paneId === herdr.pane), {
          timeout: 15_000,
        })
        .toBe(false);
      expect(tidy.history()[0]).toMatchObject({ state: "closed", paneId: herdr.pane });
      expect(await installed()).toBe(claude);
    } finally {
      store?.close();
      await mkdir(logs, { recursive: true });
      await writeFile(join(logs, "results.json"), JSON.stringify(evidence, null, 2));
      await herdr.close();
    }
  },
  180_000,
);
