import { join } from "node:path";
import { recordBulkOperation } from "@clankie/fleet-resources";
import {
  inspectCheckout,
  ownerCheckout,
  projectPathContains,
  syncOwnerCheckout,
  unreconciledLinkedWorktrees,
  type ClankieSettings,
} from "@clankie/settings";
import { WATCH_REFUSAL, type WatchGate } from "../watch.ts";
import type { CaptainOptions } from "./captain-types.ts";
import type { HerdrWatchRunner } from "./herdr-watch.ts";
import type { PaneTidy } from "./pane-tidy.ts";
import {
  hasNestedRegisteredWorktree,
  pruneTidyWorktree,
  pruneTidyWorktrees,
  type PruneWorktreeResult,
} from "./prune-worktree.ts";
import { reclaimWorktreeCaches } from "./reclaim-worktree-caches.ts";
import { managedWorktreePaths } from "./tidy-worktrees.ts";

/** The longest a prune or cache reclaim waits for its light permit (VUH-2933). */
const BULK_PERMIT_WAIT_MS = 5 * 60_000;

export interface CheckoutMaintenanceContext {
  readonly options: Pick<CaptainOptions, "repoRoot" | "stateDir" | "fleetResources">;
  readonly settings: () => Promise<ClankieSettings>;
  readonly herdrRunner: HerdrWatchRunner;
  readonly watch: WatchGate;
  /** Read at call time: the captain builds pane tidy after this module (ADR 0325). */
  readonly paneTidy: PaneTidy;
}

/** The owner's registered checkouts: their status, sync, cache reclaim and worktree prune. */
export function createCheckoutMaintenance(ctx: CheckoutMaintenanceContext) {
  const { options, settings, herdrRunner, watch } = ctx;
  const checkoutRepositories = async () => {
    const current = await settings();
    const paths = current.projects.projects.flatMap((project) => [
      ...project.workspaces
        .filter((workspace) => workspace.machineId === "local")
        .map((workspace) => workspace.path),
      ...project.worktreeRoots.filter((root) => root.machineId === "local").map((root) => root.repoPath),
    ]);
    const owners = await Promise.all(
      [...new Set(paths)].map((path) => ownerCheckout(path).catch(() => path)),
    );
    return [...new Set(owners)];
  };
  const checkoutReport = async () => {
    const managed = await managedWorktreePaths({ runtimeRoot: options.repoRoot });
    const platform = process.platform === "win32" ? "windows" : "posix";
    const isManaged = (path: string) =>
      managed.some(
        (root) => projectPathContains(root, path, platform) || projectPathContains(path, root, platform),
      );
    return {
      observedAt: new Date().toISOString(),
      refFreshness: "cached-origin/main" as const,
      checkouts: await Promise.all(
        (await checkoutRepositories()).map(async (repository) => {
          const status = await inspectCheckout(repository);
          if (status.outcome !== "observed") return status;
          // Managed runtime snapshots are not anyone's work; every other linked tree is.
          const unreconciled = await unreconciledLinkedWorktrees(repository, isManaged)
            .then((found) => ctx.paneTidy.describeUnreconciled(found))
            .catch(() => undefined);
          return unreconciled ? { ...status, unreconciled } : status;
        }),
      ),
    };
  };
  const syncCheckouts = async (repository?: string) => {
    const repositories = await checkoutRepositories();
    if (repository !== undefined && !repositories.includes(repository))
      throw Error("Select a registered owner checkout");
    return Promise.all((repository === undefined ? repositories : [repository]).map(syncOwnerCheckout));
  };
  // Beside the fleet resource journal. The batch holds a light permit, so it queues
  // behind memory pressure and shows in fleet status; low disk never holds it,
  // since this is the work that frees disk (VUH-2933).
  const bulkOperationDirectory = join(options.stateDir, "fleet-resources");
  const bulkOperation = async <T>(
    operation: "reclaim_caches" | "prune_worktree",
    work: () => Promise<T>,
    summary: (result: T) => object,
  ): Promise<T> => {
    const recorded = () => recordBulkOperation(bulkOperationDirectory, operation, work, summary);
    if (!options.fleetResources) return recorded();
    // An owner request or tidy round reports busy instead of waiting without end.
    const waited = AbortSignal.timeout(BULK_PERMIT_WAIT_MS);
    let admitted = false;
    try {
      return await options.fleetResources.governor.holdLight(
        { holderId: `service:${operation}`, operation, signal: waited },
        () => {
          admitted = true;
          return recorded();
        },
      );
    } catch (error) {
      if (admitted || !waited.aborted) throw error;
      throw Error(
        `Fleet resources are busy: ${operation} waited ${BULK_PERMIT_WAIT_MS / 60_000} minutes for a light permit; nothing was removed`,
      );
    }
  };
  const reclaimCaches = async (
    repository: string,
    path?: string,
    guard: () => Promise<void> = async () => {},
  ) => {
    const current = await settings();
    const roots = current.projects.projects
      .flatMap((project) => project.worktreeRoots)
      .filter((root) => root.machineId === "local" && root.repoPath === repository)
      .map((root) => root.path);
    if (!roots.length) throw Error("Select a registered local owner checkout");
    return bulkOperation(
      "reclaim_caches",
      () =>
        reclaimWorktreeCaches(repository, herdrRunner, {
          roots,
          ...(path === undefined ? {} : { path }),
          protection: { runtimeRoot: options.repoRoot },
          guard: async () => {
            await guard();
            if (JSON.stringify((await settings()).projects) !== JSON.stringify(current.projects))
              throw Error("Project enrollment changed");
          },
        }),
      (result) => ({ reclaimed: result.reclaimed.length, kept: result.kept.length }),
    );
  };
  const admitPrune = async (
    current: Awaited<ReturnType<typeof settings>>,
    repository: string,
    path: string,
  ): Promise<void> => {
    const platform = process.platform === "win32" ? "windows" : "posix";
    const roots = current.projects.projects
      .flatMap((project) => project.worktreeRoots)
      .filter((root) => root.machineId === "local");
    if (!roots.some((root) => root.repoPath === repository && projectPathContains(root.path, path, platform)))
      throw Error("Select a linked worktree in a registered root; managed runtime trees are protected");
    if (await hasNestedRegisteredWorktree(await checkoutRepositories(), path))
      throw Error("Nested registered worktree is still present; keep the parent");
  };
  const pruneProtection = {
    runtimeRoot: options.repoRoot,
    dropDecided: (path: string, head: string): boolean =>
      ctx.paneTidy.decisions.latest(path, head)?.decision === "safe_to_drop",
  };
  const pruneGuard =
    (current: Awaited<ReturnType<typeof settings>>, guard: () => Promise<void>) => async () => {
      // Watch removes no worktree (ADR 0308), asked again before every tree's removal.
      await watch.refuse(WATCH_REFUSAL);
      await guard();
      const latest = await settings();
      if (JSON.stringify(latest.projects) !== JSON.stringify(current.projects))
        throw Error("Project enrollment changed");
    };
  const pruneWorktree = async (
    repository: string,
    path: string,
    guard: () => Promise<void> = async () => {},
  ): Promise<PruneWorktreeResult> => {
    const current = await settings();
    await admitPrune(current, repository, path);
    return bulkOperation(
      "prune_worktree",
      () =>
        pruneTidyWorktree(
          repository,
          path,
          join(options.stateDir, "worktree-evidence"),
          herdrRunner,
          pruneGuard(current, guard),
          pruneProtection,
        ),
      (result) => ({ worktrees: 1, removed: result.outcome === "removed" ? 1 : 0 }),
    );
  };
  /** One fetch and one admission census for the batch; every tree still gets its fresh check (VUH-2932). */
  const pruneWorktrees = async (
    repository: string,
    paths: readonly string[],
    guard: () => Promise<void> = async () => {},
  ): Promise<{ results: PruneWorktreeResult[] }> => {
    const current = await settings();
    return {
      results: await bulkOperation(
        "prune_worktree",
        () =>
          pruneTidyWorktrees(
            repository,
            paths,
            join(options.stateDir, "worktree-evidence"),
            herdrRunner,
            pruneGuard(current, guard),
            pruneProtection,
            (path) => admitPrune(current, repository, path),
          ),
        (results) => ({
          worktrees: results.length,
          removed: results.filter((result) => result.outcome === "removed").length,
        }),
      ),
    };
  };
  return {
    checkoutRepositories,
    checkoutReport,
    syncCheckouts,
    reclaimCaches,
    pruneWorktree,
    pruneWorktrees,
  };
}
