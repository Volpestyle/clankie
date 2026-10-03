import { afterEach, expect, test, vi } from "vitest";
const fixtureOrigins = vi.hoisted(() => ({
  snapshots: new WeakMap<object, object>(),
  observers: new Map<string, { evidence(): { containerId: string; accountId: string } }>(),
}));
vi.mock("../../../scripts/evals/lead-account-observer.mjs", () => ({
  assertLeadAccountObserver: (observer: object) => observer,
  consumeObserverSnapshot: (snapshot: object) => {
    const observer = fixtureOrigins.snapshots.get(snapshot);
    fixtureOrigins.snapshots.delete(snapshot);
    if (!observer) throw Error("Fresh controller-observed account snapshot required");
    return observer;
  },
}));
// Only lifecycle fixtures: no native capability or provider observation is claimed.
vi.mock("../../../scripts/evals/lead-containment.mjs", () => ({
  LeadContainer: class {
    id = "c".repeat(64);
    role = "native";
    stopped = false;
    abort = new AbortController();
    get signal() {
      return this.abort.signal;
    }
    async stop() {
      this.stopped = true;
      this.abort.abort();
      return { stopped: true };
    }
  },
}));
vi.mock("../../../scripts/evals/lead-native-attachment.mjs", () => ({
  NativeOwnerAttachment: class {
    container: object;
    constructor(container: object) {
      this.container = container;
    }
    attached = vi.fn(async () => true);
  },
}));
// @ts-expect-error -- manual-only ESM with explicit fake classes above.
import { LeadContainer } from "../../../scripts/evals/lead-containment.mjs";
// @ts-expect-error -- manual-only ESM with explicit fake class above.
import { NativeOwnerAttachment } from "../../../scripts/evals/lead-native-attachment.mjs";
// @ts-expect-error -- manual-only aggregate accounting module.
import * as admissionModule from "../../../scripts/evals/lead-admission.mjs";
const { createLeadAdmission: rawAdmission, assertLeadAdmission } = admissionModule;
afterEach(() => vi.useRealTimers());
function createLeadAdmission(options: any) {
  const admission = rawAdmission(options);
  fixtureOrigins.observers.clear();
  for (const accountId of admission.accounts) {
    const observer = { evidence: () => ({ containerId: options.container.id, accountId }) };
    fixtureOrigins.observers.set(accountId, observer);
    admission.registerObserver(observer);
  }
  return admission;
}
const snapshot = (accountId: string, atMs = Date.now()) => {
  const value = {
    accountId,
    atMs,
    identitySha256: accountId,
    fiveHour: { used: 0.1, resetsAtMs: atMs + 100_000 },
    sevenDay: { used: 0.1, resetsAtMs: atMs + 100_000 },
  };
  fixtureOrigins.snapshots.set(value, fixtureOrigins.observers.get(accountId)!);
  return value;
};

test("parallel distinct-account observers cannot become ready until complete aggregate admission", async () => {
  const container = new LeadContainer(),
    ownerAttachment = new NativeOwnerAttachment(container);
  const admission = createLeadAdmission({ container, ownerAttachment, accountIds: ["a", "b", "a"] });
  expect(admission.accounts).toEqual(["a", "b"]);
  let firstReady = false;
  const first = admission.observe(snapshot("a")).then(() => {
    firstReady = true;
  });
  await Promise.resolve();
  expect(firstReady).toBe(false);
  expect(() => admission.assertCurrent()).toThrow("unavailable");
  await Promise.all([first, admission.observe(snapshot("b"))]);
  expect(firstReady).toBe(true);
  expect(assertLeadAdmission(admission)).toBe(admission);
  expect(() => assertLeadAdmission({ ...admission })).toThrow("controller-created");
  await admission.close();
  expect(container.signal.aborted).toBe(true);
  expect(() => admission.assertCurrent()).toThrow("unavailable");
});

test("independent aggregate watchdog revokes all arms on stale account or lost owner", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  for (const loss of ["owner", "quota"] as const) {
    const container = new LeadContainer(),
      ownerAttachment = new NativeOwnerAttachment(container);
    const admission = createLeadAdmission({ container, ownerAttachment, accountIds: ["a"] });
    await admission.observe(snapshot("a"));
    if (loss === "owner") ownerAttachment.attached.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(loss === "owner" ? 250 : 5250);
    expect(container.signal.aborted).toBe(true);
    await expect(admission.admit()).rejects.toThrow("unavailable");
  }
});

test("failed aggregate threshold rejects every startup callback without partial READY", async () => {
  const container = new LeadContainer(),
    ownerAttachment = new NativeOwnerAttachment(container);
  const admission = createLeadAdmission({ container, ownerAttachment, accountIds: ["a", "b"] });
  const first = admission.observe(snapshot("a"));
  const failed = expect(first).rejects.toThrow();
  const second = snapshot("b");
  second.sevenDay.used = 0.7;
  await expect(admission.observe(second)).rejects.toThrow("exhausted");
  await failed;
  expect(container.signal.aborted).toBe(true);
  expect(admission.evidence().ready).toBe(false);
});

test("an indefinitely suspended owner proof stops startup independently and rejects every waiter", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const container = new LeadContainer(),
    ownerAttachment = new NativeOwnerAttachment(container);
  ownerAttachment.attached.mockImplementation(() => new Promise(() => {}));
  const admission = createLeadAdmission({ container, ownerAttachment, accountIds: ["a"] });
  const pending = admission.observe(snapshot("a"));
  const rejected = expect(pending).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(2250);
  await rejected;
  expect(container.signal.aborted).toBe(true);
  expect(ownerAttachment.attached).toHaveBeenCalledTimes(1);
});
test("branded admission cannot cross containers and imported snapshots never become ready", async () => {
  const container = new LeadContainer(),
    ownerAttachment = new NativeOwnerAttachment(container);
  const admission = createLeadAdmission({ container, ownerAttachment, accountIds: ["a"] });
  expect(() => assertLeadAdmission(admission, { container: new LeadContainer() })).toThrow("Exact");
  await expect(admission.observe(structuredClone(snapshot("a")))).rejects.toThrow("Fresh controller");
  expect(admission.evidence().ready).toBe(false);
});
