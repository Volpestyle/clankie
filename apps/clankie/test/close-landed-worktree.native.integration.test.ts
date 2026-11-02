// Manual proof for #265. Two real idle Claude TUIs share an owned landed worktree.
// No model turn, no live service restart, no owner's panes or worktrees touched.
// CLOSE_LANDED_NATIVE_TEST=1; CLAUDE_NATIVE_CONFIG_DIR selects an onboarded profile.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createHerdrWatchRunner, HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import { HireOwners } from "../src/captain/hire-owners.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import { nativeSessionId } from "../src/captain/native-session-resume.ts";
import { paneInputLine } from "../src/captain/pane-draft.ts";
import {
  OperatorConversationServiceResultSchema,
  type OperatorConversationServiceResult,
} from "@clankie/protocol";
import { createHerdrSessionSource } from "../../../packages/agent-hosts/src/sessions/herdr.ts";
import { SettingsStore } from "@clankie/settings";
import { PersonaStore } from "../src/captain/personas.ts";
import {
  createOperatorService,
  type CreateOperatorServiceContext,
} from "../src/captain/captain-operator-service.ts";
import { PaneTidy } from "../src/captain/pane-tidy.ts";
import { pruneTidyWorktree, sweepEvidenceTrash } from "../src/captain/prune-worktree.ts";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";

const exec = promisify(execFile);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const nativeIt = it.skipIf(process.platform !== "darwin" || process.env.CLOSE_LANDED_NATIVE_TEST !== "1");
const git = async (cwd: string, ...args: string[]) =>
  (
    await exec("git", ["-C", cwd, ...args], {
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    })
  ).stdout.trim();

nativeIt(
  "closing the last real hire removes its landed tree and preserves evidence",
  async () => {
    const checkout = await realpath(join(import.meta.dirname, "../../.."));
    const logs = join(checkout, ".local", "issue-265-native");
    const herdr = await isolatedHerdr(logs);
    const evidence: unknown[] = [];
    let store: HerdrWatchStore | undefined;
    const parent = await realpath(await mkdtemp(join(tmpdir(), "proof-close-265-")));
    const tree = join(parent, "worker");
    let created = false;
    try {
      // A linked tree of the already-trusted project, at the fetched landed ref.
      await git(checkout, "worktree", "add", "--detach", tree, "origin/main");
      created = true;
      await mkdir(join(tree, ".local", "node_modules"), { recursive: true });
      await writeFile(join(tree, ".local", "REPORT.md"), "Owned native hire: work is landed.\n");
      await writeFile(join(tree, ".local", "node_modules", "cache"), "x".repeat(1024 * 1024));
      const env = { ...process.env, HERDR_SOCKET_PATH: herdr.socketPath };
      const run = async (args: readonly string[]) =>
        (await exec("herdr", [...args], { env, timeout: 10_000 })).stdout;
      const runner = createHerdrWatchRunner(undefined, run, undefined, { localCodexRecovery: false });
      const home = userInfo().homedir;
      const launcher = join(home, ".local/bin/claude");
      const config = process.env.CLAUDE_NATIVE_CONFIG_DIR ?? join(home, ".claude");
      const profile = `env -u NO_COLOR -u NODE_DISABLE_COLORS -u XDG_CONFIG_HOME -u XDG_STATE_HOME -u XDG_DATA_HOME -u XDG_CACHE_HOME -u XDG_RUNTIME_DIR FORCE_COLOR=1 TERM=xterm-256color COLORTERM=truecolor DISABLE_AUTOUPDATER=1 HOME=${quote(home)} ${config ? `CLAUDE_CONFIG_DIR=${quote(config)} ` : ""}`;
      const isolation = JSON.stringify({
        enabledPlugins: { "clankie-worker@clankie": false, "clankie@clankie": false },
      });
      for (const pane of [herdr.pane, herdr.foreignPane]) {
        await herdr.cli(
          "pane",
          "run",
          pane,
          `cd ${quote(tree)} && ${profile}${quote(launcher)} --strict-mcp-config --settings ${quote(isolation)}`,
        );
        try {
          await expect
            .poll(
              async () => {
                const agent = await runner.get(pane).catch(() => undefined);
                return (
                  agent?.agent === "claude" && agent.status === "idle" && nativeSessionId(agent) !== undefined
                );
              },
              { timeout: 60_000, interval: 500 },
            )
            .toBe(true);
        } catch (error) {
          evidence.push({
            phase: "startup-refused",
            pane,
            screen: await run(["pane", "read", pane, "--source", "visible"]).catch(String),
          });
          throw error;
        }
      }
      const path = join(herdr.root, "watches.json");
      const owners = new HireOwners(`${path}.owners.json`);
      const owner = { conversationId: "issue-265-proof" };
      for (const pane of [herdr.pane, herdr.foreignPane]) {
        const agent = await runner.get(pane);
        evidence.push({ phase: "native-hire", agent });
        expect(agent.workingDirectory).toBe(tree);
        owners.bind(
          pane,
          owner,
          agent.terminalId,
          undefined,
          occupantIdForHerdrSession(agent.session!),
          JSON.stringify(["local", "claude", nativeSessionId(agent)]),
        );
      }
      store = new HerdrWatchStore(path, { runner });
      const archive = join(logs, "worktree-evidence");
      const tidy = new PaneTidy(join(herdr.root, "pane-tidy.json"), {
        runner,
        runtimeRoot: checkout,
        provenance: (agent) => store!.tidyProvenance(agent),
        retirementGuard: (agent) => store!.retirementGuard(agent),
        ownerValid: async () => true,
        close: (seat, guard, nativeOnly) => store!.closeSeat(seat, guard, nativeOnly),
        untrack: (seat) => store!.untrackSeat(seat),
        prune: (repository, path, guard) =>
          pruneTidyWorktree(repository, path, archive, runner, guard, { runtimeRoot: checkout }),
        hire: async () => {
          throw Error("No additional hire during close");
        },
        changed: () => {},
      });
      const authority = { owner, current: () => true, authorize: async () => true };
      for (const pane of [herdr.pane, herdr.foreignPane])
        tidy.keepReport(await runner.get(pane), "Owned native hire finished; work landed on origin/main.");
      for (const pane of [herdr.pane, herdr.foreignPane]) {
        try {
          await expect
            .poll(
              async () => paneInputLine("claude", await runner.readPane!(pane, "visible", "ansi")).state,
              { timeout: 30_000, interval: 500 },
            )
            .toBe("empty");
        } catch (error) {
          evidence.push({
            phase: "composer-not-ready",
            pane,
            screen: await runner.readPane!(pane, "visible", "ansi"),
          });
          throw error;
        }
      }
      const first = await tidy.close({ pane: herdr.pane, reason: "first shared hire finished" }, authority);
      evidence.push({ phase: "first-close", result: first });
      expect(first).toMatchObject({
        outcome: "closed",
        entry: { worktree: { outcome: "kept", reason: "live_pane" } },
      });
      expect((await stat(tree)).isDirectory()).toBe(true);
      // The second real pane crosses the connector's session adapter, operator dispatch,
      // strict protocol and the same production Herdr close/prune boundaries.
      store.tidy = tidy;
      const settings = new SettingsStore(join(herdr.root, "settings.json"));
      const personas = new PersonaStore(herdr.root);
      const serve = createOperatorService({
        shutdown: new AbortController(),
        personas,
        settingsStore: settings,
        settings: () => settings.load(),
        deps: {},
        herdrWatches: store,
        herdrRunner: runner,
        liveSeats: [],
        seatByPersona: new Map(),
        fleetChanges: { touch: () => {} },
      } as unknown as CreateOperatorServiceContext);
      let response: OperatorConversationServiceResult | undefined;
      const source = createHerdrSessionSource(
        {
          dispatch: async (request) =>
            (response = OperatorConversationServiceResultSchema.parse(await serve(request))),
          terminalTail: async () => {
            throw Error("No terminal tail in this proof");
          },
          tailRefusal: async () => Error("No terminal tail in this proof"),
        },
        { surfaceClientId: "issue-265-proof" },
      );
      const second = await source.close!((await runner.get(herdr.foreignPane)).terminalId);
      evidence.push({ phase: "last-close", result: second, response });
      expect(second).toMatchObject({ status: "closed" });
      if (response?.op === "close_seat" && response.worktree?.reason === "live_process") {
        const dump = await exec("lsof", [
          "-nP",
          "-a",
          "-d",
          "cwd",
          "-Fpcn",
          "-u",
          String(process.getuid!()),
        ]).catch((error) => ({ stdout: String(error.stdout ?? error) }));
        evidence.push({
          phase: "cwd-holders",
          records: dump.stdout
            .split(/(?=^p[0-9])/mu)
            .filter((record) =>
              record
                .split("\n")
                .some(
                  (line) =>
                    line.startsWith("n/") &&
                    (tree.startsWith(line.slice(1) + "/") || line.slice(1).startsWith(tree)),
                ),
            ),
        });
      }
      expect(second.detail).toContain("bytes freed");
      expect(response).toMatchObject({ op: "close_seat", closed: true, worktree: { outcome: "removed" } });
      if (response?.op !== "close_seat") return;
      expect(response.worktree!.freedBytes).toBeGreaterThan(1024 * 1024);
      expect(await stat(tree).catch(() => undefined)).toBeUndefined();
      expect(await readFile(join(response.worktree!.evidencePath!, "REPORT.md"), "utf8")).toContain(
        "work is landed",
      );
      await personas.close();
      expect(await git(checkout, "worktree", "list", "--porcelain")).not.toContain(tree);
      await sweepEvidenceTrash(archive);
      evidence.push({
        phase: "verified",
        treeRemoved: true,
        registrationRemoved: true,
        evidenceRetained: true,
        onlyOwnedPanesClosed: true,
      });
    } finally {
      store?.close();
      await mkdir(logs, { recursive: true });
      await writeFile(join(logs, "results.json"), JSON.stringify(evidence, null, 2));
      await herdr.close();
      // Only our recorded tree: no force, never prune somebody else's checkout.
      if (created && (await stat(tree).catch(() => undefined)))
        await git(checkout, "worktree", "remove", tree);
      await rm(parent, { recursive: true });
    }
  },
  180_000,
);
