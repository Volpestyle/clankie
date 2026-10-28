import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { createResourceGovernor, defaultResourcePolicy } from "@clankie/fleet-resources";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import {
  addProjectWorktreeRoot,
  observeLocalProjectWorktreeRoot,
  projectsRevision,
  SettingsStore,
} from "@clankie/settings";
import { expect, it } from "vitest";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { createFleetResourceRuntime } from "../src/fleet-resource-runtime.ts";

const git = (cwd: string, args: string[]) => promisify(execFile)("git", ["-C", cwd, ...args]);

// Cache reclaim and prune free disk, so the disk floor that holds every other
// light job must not hold them (VUH-2933). In the service its arbiter grants
// permits and waiters only wait; without one, each waiter admits itself.
it.each([
  ["the service arbiter grants", true],
  ["the waiter admits itself", false],
])(
  "the service's cache reclaim passes a worker's check the low-disk floor holds (%s)",
  async (_, arbiter) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "service-bulk-permit-")));
    const repo = join(root, "repo");
    const agents = join(root, "agents");
    await mkdir(repo);
    await mkdir(agents);
    await git(repo, ["init", "--initial-branch=main"]);
    await git(repo, ["config", "user.name", "Bulk permit fixture"]);
    await git(repo, ["config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(repo, "source.txt"), "retained\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "fixture baseline"]);
    let projects = ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "bulk-permit",
          name: "Bulk permit",
          workspaces: [{ id: "owner", machineId: "local", platform: "posix", path: repo }],
        },
      ],
    });
    const request = {
      projectId: "bulk-permit",
      machineId: "local",
      platform: "posix" as const,
      path: agents,
      repoPath: repo,
      expectedRevision: projectsRevision(projects),
    };
    projects = addProjectWorktreeRoot(projects, request, (await observeLocalProjectWorktreeRoot(request))!);
    await writeFile(join(root, "settings.json"), JSON.stringify({ schemaVersion: 1, projects }));

    const registry = join(root, "registry");
    // Real statfs; the floor sits above any real volume, so the sample reads `disk`.
    const governor = createResourceGovernor({
      directory: registry,
      probe: async () => ({ loadRatio: 0, cpuRatio: 0, availableMemoryMb: 65_536 }),
    });
    const policy = {
      ...defaultResourcePolicy(),
      minAvailableMemoryMb: 0,
      minFreeDiskGb: 1_048_576,
      warnFreeDiskGb: 1_048_576,
    };
    const refuse = async (): Promise<never> => {
      throw new Error("No simulators in this fixture");
    };
    const resources = await createFleetResourceRuntime({
      policy: async () => policy,
      governor,
      arbitrateMs: 50,
      simulator: {
        adapter: {
          inventory: async () => [],
          catalog: async () => ({ deviceTypes: [], runtimes: [] }),
          create: refuse,
          boot: refuse,
          shutdown: refuse,
          delete: refuse,
        },
      },
    });
    await resources.configure(policy);
    if (arbiter) resources.start();
    const captain = createCaptain(
      {
        herdrAvailable: () => false,
        presence: { listSessions: async () => [] },
        embodiment: { getLiveSession: async () => undefined },
      } as unknown as CaptainDeps,
      {
        repoRoot: root,
        stateDir: join(root, "state"),
        workingDirectory: root,
        settings: new SettingsStore(join(root, "settings.json")),
        fleetResources: resources,
      },
    );
    try {
      expect((await governor.snapshot()).pressure.reason).toBe("disk");
      while (arbiter && !governor.arbitration()) await delay(20);

      // A worker's focused check still waits on the disk floor, queued ahead of the reclaim.
      const stop = new AbortController();
      let waiting!: () => void;
      const queued = new Promise<void>((resolve) => (waiting = resolve));
      const focused = governor.runHeavy(process.execPath, ["-e", "0", "vitest", "run", "a.test.ts"], {
        signal: stop.signal,
        onWait: (snapshot) => {
          if (snapshot.lightQueue.length) waiting();
        },
      });
      await queued;

      // The reclaim passes it: that check would wait on the floor anyway.
      expect(await captain.reclaimWorktreeCaches!(repo)).toMatchObject({ reclaimed: [] });
      expect((await governor.snapshot()).lightQueue.map((entry) => entry.executable)).toEqual([
        basename(process.execPath),
      ]);
      stop.abort();
      expect(await focused).toBe(130);
      const leases = (await readFile(join(registry, "leases.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(leases).toEqual([
        expect.objectContaining({ event: "admitted", lane: "light", holderId: "service:reclaim_caches" }),
        expect.objectContaining({ event: "released", holderId: "service:reclaim_caches", exitCode: 0 }),
      ]);
      expect((await governor.snapshot()).capacity.lightUsed).toBe(0);
    } finally {
      await captain.close();
      await resources.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
