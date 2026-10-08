import {
  checkoutGit,
  fetchCheckoutMain,
  ownerCheckout,
  syncOwnerCheckout,
  type CheckoutSyncResult,
} from "@clankie/settings";

/** Git updates the shared remote-tracking ref only after a successful push.
 * Observe that ref across linked worktrees; periodically fetch for other clones.
 * No hooks, shell interception, or agent turn is needed.
 */
export function startOwnerCheckoutSync(options: {
  repositories(): Promise<string[]>;
  report(result: CheckoutSyncResult): void;
  intervalMs?: number;
  fetchIntervalMs?: number;
}) {
  const observed = new Map<string, string>();
  const fetched = new Map<string, number>();
  const warnings = new Map<string, string>();
  let closed = false;
  let running: Promise<void> | undefined;
  const check = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      const owners = new Set<string>();
      for (const repository of await options.repositories()) {
        if (closed) break;
        try {
          const owner = await ownerCheckout(repository);
          if (owners.has(owner)) continue;
          owners.add(owner);
          if (Date.now() - (fetched.get(owner) ?? 0) >= (options.fetchIntervalMs ?? 60_000)) {
            await fetchCheckoutMain(owner);
            fetched.set(owner, Date.now());
          }
          const main = (await checkoutGit(owner, ["rev-parse", "--verify", "origin/main^{commit}"])).trim();
          if (closed || observed.get(owner) === main) continue;
          const result = await syncOwnerCheckout(owner);
          // Refusal retries on each new landing; transient observation failures retry next tick.
          if (result.outcome !== "unavailable") observed.set(owner, result.after ?? main);
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
          const reason = error instanceof Error ? error.message : String(error);
          if (warnings.get(repository) !== reason)
            options.report({ path: repository, outcome: "unavailable", reason, blockers: [] });
          warnings.set(repository, reason);
        }
      }
      for (const owner of observed.keys())
        if (!owners.has(owner)) {
          observed.delete(owner);
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
