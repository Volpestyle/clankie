import {
  checkoutGit,
  fetchCheckoutMain,
  ownerCheckout,
  syncOwnerCheckout,
  type CheckoutSyncResult,
} from "@clankie/settings";
import type { createLogger } from "@clankie/observability";
import { statSync } from "node:fs";
import { join } from "node:path";

/**
 * The service's report of each sync (VUH-2586). A blocked or unavailable sync is
 * operator plumbing: it goes to the structured log, and `clankie doctor` names a
 * checkout left behind with its recovery step. It never reaches the owner's chat;
 * nothing here needs him, since every hire verifies fresh main before it launches.
 */
export function ownerCheckoutSyncReport(logger: Pick<ReturnType<typeof createLogger>, "info" | "warn">) {
  return (result: CheckoutSyncResult): void => {
    if (result.outcome === "updated")
      logger.info({ event: "checkouts.auto_sync", ...result }, "Owner checkout advanced after main changed");
    else
      logger.warn({ event: "checkouts.auto_sync_blocked", ...result }, "Owner checkout sync needs attention");
  };
}

/**
 * What can move `origin/main` in an owner checkout: its loose ref and `packed-refs`, by
 * identity and timestamps. Undefined when its git directory isn't a plain `.git`
 * directory; then every tick asks git, as before (#360). Sync stats with
 * `throwIfNoEntry: false`, so a packed (missing) loose ref never throws.
 */
function mainRefSignature(owner: string): string | undefined {
  const git = join(owner, ".git");
  if (!statSync(git, { throwIfNoEntry: false })?.isDirectory()) return undefined;
  const parts = [join(git, "refs", "remotes", "origin", "main"), join(git, "packed-refs")].map((path) => {
    const info = statSync(path, { bigint: true, throwIfNoEntry: false });
    return info ? `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` : "-";
  });
  return parts.join("|");
}

/** Git updates the shared remote-tracking ref only after a successful push.
 * Observe that ref across linked worktrees; periodically fetch for other clones.
 * No hooks, shell interception, or agent turn is needed.
 *
 * A quiet tick spawns no git (#360): each path's owner checkout is remembered until the
 * next fetch, and `origin/main` is re-read only when its ref files changed.
 */
export function startOwnerCheckoutSync(options: {
  repositories(): Promise<string[]>;
  report(result: CheckoutSyncResult): void;
  intervalMs?: number;
  fetchIntervalMs?: number;
}) {
  const observed = new Map<string, string>();
  /** The ref signature `observed` was read at; a match means main hasn't moved. */
  const observedRef = new Map<string, string>();
  /** Each path's owner checkout, kept until that owner's next fetch or an error. */
  const owners = new Map<string, string>();
  const fetched = new Map<string, number>();
  const warnings = new Map<string, string>();
  let closed = false;
  let running: Promise<void> | undefined;
  const check = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      const seen = new Set<string>();
      const fetchDue = (owner: string) =>
        Date.now() - (fetched.get(owner) ?? 0) >= (options.fetchIntervalMs ?? 60_000);
      const repositories = await options.repositories();
      for (const repository of owners.keys())
        if (!repositories.includes(repository)) owners.delete(repository);
      for (const repository of repositories) {
        if (closed) break;
        try {
          let owner = owners.get(repository);
          if (owner === undefined || fetchDue(owner)) {
            owner = await ownerCheckout(repository);
            owners.set(repository, owner);
          }
          if (seen.has(owner)) continue;
          seen.add(owner);
          if (fetchDue(owner)) {
            await fetchCheckoutMain(owner);
            fetched.set(owner, Date.now());
          }
          const signature = mainRefSignature(owner);
          if (signature !== undefined && observed.has(owner) && observedRef.get(owner) === signature)
            continue;
          const main = (await checkoutGit(owner, ["rev-parse", "--verify", "origin/main^{commit}"])).trim();
          if (closed) continue;
          if (observed.get(owner) === main) {
            if (signature !== undefined) observedRef.set(owner, signature);
            continue;
          }
          const result = await syncOwnerCheckout(owner);
          // Refusal retries on each new landing; transient observation failures retry next tick.
          if (result.outcome !== "unavailable") {
            observed.set(owner, result.after ?? main);
            if (signature !== undefined) observedRef.set(owner, signature);
          }
          if (result.outcome === "blocked" || result.outcome === "unavailable") {
            const fingerprint = JSON.stringify([
              main,
              result.reason,
              result.blockers.map((file) => file.path),
            ]);
            if (warnings.get(owner) !== fingerprint) options.report(result);
            warnings.set(owner, fingerprint);
          } else {
            warnings.delete(owner);
            if (result.outcome === "updated") options.report(result);
          }
        } catch (error) {
          owners.delete(repository);
          const reason = error instanceof Error ? error.message : String(error);
          if (warnings.get(repository) !== reason)
            options.report({ path: repository, outcome: "unavailable", reason, blockers: [] });
          warnings.set(repository, reason);
        }
      }
      for (const owner of observed.keys())
        if (!seen.has(owner)) {
          observed.delete(owner);
          observedRef.delete(owner);
          fetched.delete(owner);
          warnings.delete(owner);
        }
    })().finally(() => {
      running = undefined;
    });
    return running;
  };
  const tick = () => void check().catch(() => {});
  const timer = setInterval(tick, options.intervalMs ?? 5_000);
  timer.unref();
  tick();
  return {
    check,
    async close() {
      closed = true;
      clearInterval(timer);
      await running?.catch(() => {});
    },
  };
}
