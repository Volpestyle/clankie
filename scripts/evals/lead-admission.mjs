/** One shared account/window admission barrier. Construction never starts a runtime. */
import { NativeBudgetGuard } from "./lead-native-ledger.mjs";
import { NativeOwnerAttachment } from "./lead-native-attachment.mjs";
import { LeadContainer } from "./lead-containment.mjs";
import { assertLeadAccountObserver, consumeObserverSnapshot } from "./lead-account-observer.mjs";
const origins = new WeakMap();
export function assertLeadAdmission(value, expected) {
  const origin = origins.get(value);
  if (
    !origin ||
    (expected &&
      (origin.container !== expected.container ||
        (expected.ownerAttachment && origin.ownerAttachment !== expected.ownerAttachment)))
  )
    throw Error("Exact controller-created aggregate admission required");
  return value;
}
export function createLeadAdmission({ container, accountIds, ownerAttachment, now = Date.now }) {
  if (
    !(container instanceof LeadContainer) ||
    !(ownerAttachment instanceof NativeOwnerAttachment) ||
    ownerAttachment.container !== container
  )
    throw Error("Exact native containment and owner attachment required");
  const accounts = [...new Set(accountIds)];
  if (!accounts.length || accounts.some((id) => typeof id !== "string" || !id))
    throw Error("Selected native account IDs required");
  const seen = new Set(),
    snapshots = new Map(),
    baselines = new Map(),
    observers = new Map();
  let ready = false,
    stopped,
    timer,
    resolveBarrier,
    rejectBarrier,
    ownerProof,
    ownerAt,
    ownerPendingAt;
  const barrier = new Promise((resolve, reject) => {
    resolveBarrier = resolve;
    rejectBarrier = reject;
  });
  void barrier.catch(() => {});
  const revoked = new Promise((_, reject) =>
    container.signal.addEventListener("abort", () => reject(Error("Aggregate native run revoked")), {
      once: true,
    }),
  );
  void revoked.catch(() => {});
  const stop = (reason) => {
    clearInterval(timer);
    rejectBarrier(Error(reason));
    if (!stopped) stopped = container.stop(reason);
    return stopped;
  };
  const guard = new NativeBudgetGuard({ accounts, now, maxAgeMs: 5000, stop });
  const assertCurrent = () => {
    if (
      !ready ||
      stopped ||
      container.stopped ||
      container.signal.aborted ||
      ownerAt === undefined ||
      now() < ownerAt ||
      now() - ownerAt > 2000
    )
      throw Error("Aggregate native admission unavailable or owner proof stale");
    return guard.assertCurrent();
  };
  const refreshOwner = () => {
    if (!ownerProof) {
      ownerPendingAt = now();
      ownerProof = Promise.resolve()
        .then(async () => {
          if (!(await ownerAttachment.attached(container.id, "/eval/control/herdr.sock")))
            throw Error("Exact owner attachment lost");
          if (stopped || container.stopped) throw Error("Owner proof returned after stop");
          if (now() < ownerPendingAt || now() - ownerPendingAt > 2000)
            throw Error("Owner proof elapsed coverage expired");
          ownerAt = ownerPendingAt;
        })
        .finally(() => {
          ownerProof = undefined;
          ownerPendingAt = undefined;
        });
    }
    return Promise.race([ownerProof, revoked]);
  };
  const admit = async () => {
    try {
      assertCurrent();
      await refreshOwner();
      return assertCurrent();
    } catch (error) {
      await stop(error.message);
      throw error;
    }
  };
  container.signal.addEventListener(
    "abort",
    () => {
      clearInterval(timer);
      rejectBarrier(Error("Native containment stopped"));
    },
    { once: true },
  );
  const result = Object.freeze({
    accounts: Object.freeze(accounts),
    signal: container.signal,
    registerObserver(observer) {
      assertLeadAccountObserver(observer);
      const proof = observer.evidence();
      if (
        seen.size ||
        proof.containerId !== container.id ||
        !accounts.includes(proof.accountId) ||
        observers.has(proof.accountId)
      )
        throw Error("Exact distinct observer registration required before startup");
      observers.set(proof.accountId, observer);
    },
    assertObservers(sources) {
      if (
        sources.length !== observers.size ||
        sources.some((source) => observers.get(source.evidence().accountId) !== source)
      )
        throw Error("Aggregate observer origin mismatch");
    },
    async observe(snapshot) {
      try {
        const source = consumeObserverSnapshot(snapshot);
        if (observers.size !== accounts.length || observers.get(snapshot.accountId) !== source)
          throw Error("Unregistered snapshot origin");
        if (stopped || container.stopped) throw Error("Aggregate admission stopped");
        guard.observe(snapshot);
        seen.add(snapshot.accountId);
        if (!baselines.has(snapshot.accountId)) baselines.set(snapshot.accountId, structuredClone(snapshot));
        snapshots.set(snapshot.accountId, structuredClone(snapshot));
        if (seen.size === accounts.length) {
          guard.assertCurrent();
          if (!ready) {
            // Independent watchdog starts before awaited kernel owner proof; a stuck
            // proof cannot leave all observer callbacks pending indefinitely.
            if (!timer)
              timer = setInterval(() => {
                if (
                  (ownerPendingAt !== undefined && now() - ownerPendingAt > 2000) ||
                  (ready && (ownerAt === undefined || now() - ownerAt > 2000))
                ) {
                  void stop("Owner attachment proof stalled").catch(() => {});
                  return;
                }
                try {
                  guard.assertCurrent();
                } catch (error) {
                  void stop(error.message).catch(() => {});
                  return;
                }
                if (ready && !ownerProof) void admit().catch(() => {});
              }, 250);
            await refreshOwner();
            ready = true;
            assertCurrent();
            resolveBarrier();
          }
        }
        await barrier;
        await admit();
      } catch (error) {
        await stop(error.message);
        throw error;
      }
    },
    admit,
    assertCurrent,
    close: (reason = "manual lead run closed") => stop(reason),
    evidence: () => ({
      ready: ready && !container.stopped && !stopped,
      accounts,
      baselines: [...baselines.values()],
      snapshots: [...snapshots.values()],
    }),
  });
  origins.set(result, { container, ownerAttachment });
  return result;
}
