import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, expect, it } from "vitest";
import { OperatorConversationServiceResultSchema } from "@clankie/protocol";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import {
  addProjectWorktreeRoot,
  observeLocalProjectWorktreeRoot,
  projectsRevision,
  SettingsStore,
} from "@clankie/settings";
import { createCaptain } from "../src/captain/captain.ts";
import {
  createOperatorService,
  type CreateOperatorServiceContext,
} from "../src/captain/captain-operator-service.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { PaneTidy } from "../src/captain/pane-tidy.ts";

const exec = promisify(execFile);
// The prune reads the account process cwd census through the native helper (VUH-2926).
beforeAll(async () => {
  if (process.platform === "darwin")
    await exec(process.execPath, [join(import.meta.dirname, "../../../scripts/build-fleet-proof.mjs")]);
});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

/**
 * A hire that survived a service restart (#284): its tidy provenance is gone, so the pane
 * tidy no longer knows who made it, while the roster still records the hire. Real git, real
 * owner settings with a registered worktree root, and the captain's own guarded prune.
 */
async function fixture() {
  const git = (cwd: string, args: string[]) => exec("git", ["-C", cwd, ...args]);
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-close-seat-tree-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const agents = join(root, "agents");
  await mkdir(repo);
  await mkdir(agents);
  const runtime = join(root, "runtime");
  await mkdir(runtime);
  await git(repo, ["init", "--quiet", "--initial-branch=main"]);
  await git(repo, ["config", "user.name", "Close fixture"]);
  await git(repo, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(repo, "source.txt"), "landed\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "--quiet", "-m", "fixture baseline"]);
  await git(repo, ["clone", "--quiet", "--bare", repo, join(root, "origin.git")]);
  await git(repo, ["remote", "add", "origin", join(root, "origin.git")]);
  await git(repo, ["fetch", "--quiet", "origin"]);
  let projects = ProjectsSettingsSchema.parse({
    projects: [
      {
        id: "hires",
        name: "Hires",
        workspaces: [{ id: "owner", machineId: "local", platform: "posix", path: repo }],
      },
    ],
  });
  const request = {
    projectId: "hires",
    machineId: "local",
    platform: "posix" as const,
    path: agents,
    repoPath: repo,
    expectedRevision: projectsRevision(projects),
  };
  projects = addProjectWorktreeRoot(projects, request, (await observeLocalProjectWorktreeRoot(request))!);
  await writeFile(join(root, "settings.json"), JSON.stringify({ schemaVersion: 1, projects }));
  const settings = new SettingsStore(join(root, "settings.json"));
  const captain = createCaptain(
    {
      herdrAvailable: () => true,
      presence: { listSessions: async () => [] },
      embodiment: { getLiveSession: async () => undefined },
    } as unknown as CaptainDeps,
    {
      // Clankie's own runtime is a managed tree no close may prune; keep it apart.
      repoRoot: runtime,
      stateDir: join(runtime, "state"),
      workingDirectory: runtime,
      settings,
      // Herdr after the close: no pane is left working in any tree.
      nativeHerdrRunner: createHerdrWatchRunner(undefined, async () =>
        JSON.stringify({ result: { panes: [], agents: [] } }),
      ),
    },
  );
  cleanups.push(() => captain.close());

  const trees = new Map<string, string | undefined>();
  const hire = async (seatId: string) => {
    const tree = join(agents, `wt-${seatId}`);
    await git(repo, ["worktree", "add", "--quiet", "-b", `clankie/${seatId}`, tree, "main"]);
    trees.set(seatId, tree);
    return tree;
  };
  const agent = (seatId: string) => {
    const tree = trees.get(seatId);
    if (!trees.has(seatId)) throw new Error("no terminal");
    return {
      paneId: `w1:${seatId}`,
      terminalId: seatId,
      agent: "claude",
      status: "done",
      workingDirectory: tree,
    };
  };
  const runner = {
    resolveTerminal: async (seatId: string) => agent(seatId),
    list: async () => [],
  };
  const tidy = new PaneTidy(join(runtime, "state", "pane-tidy.json"), {
    runner,
    runtimeRoot: runtime,
    // What a restart leaves: no hire claim matches the pane's current session.
    provenance: () => "unknown",
    retirementGuard: () => undefined,
    ownerValid: async () => true,
    close: async () => true,
    untrack: () => {},
    // The close checks its own authority guard before this; the captain's public prune
    // applies its settings, registered-root and landed checks.
    prune: (repository: string, path: string) => captain.pruneWorktree!(repository, path),
    hire: async () => {
      throw Error("No hire during close");
    },
    changed: () => {},
  } as unknown as PaneTidy["ports"]);
  const hired = new Set<string>();
  const exits: string[] = [];
  const serve = createOperatorService({
    shutdown: new AbortController(),
    personas: { ready: async () => {} },
    settingsStore: settings,
    settings: () => settings.load(),
    deps: {},
    liveSeats: [],
    seatByPersona: new Map(),
    fleetChanges: { touch: () => {} },
    fleetSnapshot: async () => ({
      snapshot: {
        schemaVersion: 1,
        cursor: "c1",
        personas: [],
        channels: [],
        seats: [...trees.keys(), "gone"].map((seatId) => ({
          seatId,
          occupantId: `occ-${seatId}`,
          harness: "claude",
          status: "done",
          title: seatId,
          ...(hired.has(seatId) ? { owner: { hired: true } } : {}),
        })),
      },
    }),
    herdrRunner: runner,
    herdrWatches: {
      tidy,
      closeSeat: async (seatId: string, guard?: () => Promise<void>) => {
        await guard?.();
        exits.push(seatId);
        return true;
      },
    },
  } as unknown as CreateOperatorServiceContext);
  const close = async (seatId: string) =>
    OperatorConversationServiceResultSchema.parse(
      await serve({ op: "close_seat", schemaVersion: 1, seatId }),
    );
  const observeWithoutDirectory = (seatId: string) => trees.set(seatId, undefined);
  return { hire, hired, close, exits, observeWithoutDirectory };
}

it("closing a landed hire that outlived a restart removes its worktree", async () => {
  const f = await fixture();
  const tree = await f.hire("survivor");
  f.hired.add("survivor");
  const closed = await f.close("survivor");
  expect(closed, JSON.stringify(closed)).toMatchObject({
    op: "close_seat",
    closed: true,
    worktree: { outcome: "removed", path: tree },
  });
  expect(f.exits).toEqual(["survivor"]);
  await expect(stat(tree)).rejects.toThrow();
});

it("a close that prunes nothing still says why the tree stayed", async () => {
  const f = await fixture();
  // Unknown provenance and no hire record: the tree may be the owner's own.
  const tree = await f.hire("by-hand");
  const kept = await f.close("by-hand");
  expect(kept, JSON.stringify(kept)).toMatchObject({
    closed: true,
    worktree: { outcome: "unavailable", path: tree, reason: "provenance_unknown" },
  });
  expect((await stat(tree)).isDirectory()).toBe(true);
  // The native occupant is known, but it has no observed working directory.
  f.observeWithoutDirectory("no-directory");
  const unknownDirectory = await f.close("no-directory");
  expect(unknownDirectory, JSON.stringify(unknownDirectory)).toMatchObject({
    closed: true,
    worktree: { outcome: "unavailable", path: "", reason: "working_directory_unknown" },
  });
  expect(f.exits).toEqual(["by-hand", "no-directory"]);
});

it("an unresolved native occupant refuses before the close adapter or prune", async () => {
  const f = await fixture();
  const tree = await f.hire("by-hand");
  const gone = await f.close("gone");
  expect(gone).toEqual({
    op: "close_seat",
    schemaVersion: 1,
    seatId: "gone",
    closed: false,
    refusal: {
      reason: "main_unknown",
      failingJobs: [],
      detail: "Native close occupant could not be resolved",
    },
  });
  expect(f.exits).toEqual([]);
  expect((await stat(tree)).isDirectory()).toBe(true);
});
