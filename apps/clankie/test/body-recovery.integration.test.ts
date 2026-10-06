import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { BodyResource } from "@clankie/protocol";
import { BodyLeaseStore } from "../src/body-leases.ts";
import { BodyLeaseRouter } from "../src/body-lease-router.ts";
import { BodyLeaseRecovery } from "../src/body-lease-recovery.ts";
import { ConversationStore } from "../src/captain/conversations.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, description: string) {
  const end = Date.now() + 4000;
  while (!check()) {
    if (Date.now() >= end) throw Error(`Timed out: ${description}`);
    await pause(5);
  }
}

// No mocked timers, process host, lease persistence, turn tracking or recovery router.
async function fixture(
  reboot = false,
  options: {
    resource?: "browser" | "play";
    holderEvidence?: "missing" | "unreadable" | "native_responding";
  } = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-body-recovery-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const entered = deferred(),
    finished = deferred();
  const createConversations = () =>
    new ConversationStore(join(root, "conversations"), async () => {
      entered.resolve();
      await finished.promise;
    });
  let conversations = createConversations();
  cleanup.push(async () => {
    finished.resolve();
    await conversations.close();
  });
  const resource = options.resource ?? "browser";
  let conversationId = "global-default";
  if (options.holderEvidence) {
    const created = await conversations.serve({
      schemaVersion: 1,
      op: "create",
      scope: { kind: "workspace", workspaceId: root },
      title: "Recovery holder",
    });
    if (created.op !== "create") throw Error("No fixture holder");
    conversationId = created.conversation.conversationId;
    if (options.holderEvidence === "native_responding") {
      if (!conversations.syncNativeSeatTranscript(conversationId, "body-native-session", [], "responding"))
        throw Error("No fixture native holder");
    }
  }
  let store = new BodyLeaseStore(join(root, "leases"));
  const held = store.acquire(resource, conversationId, 300000);
  if (held.outcome !== "acquired") throw Error("No fixture lease");
  const operation = store.begin(held.lease);
  if (operation.outcome !== "admitted") throw Error("No fixture operation");
  store.finish(held.lease, operation.operationId, "uncertain");
  if (reboot) {
    store.close();
    if (options.holderEvidence) {
      await conversations.close();
      const holderRoot = join(root, "conversations", conversationId);
      if (options.holderEvidence === "missing") await rm(holderRoot, { recursive: true });
      if (options.holderEvidence === "unreadable") await writeFile(join(holderRoot, "meta.json"), "{");
      conversations = createConversations();
    }
    store = new BodyLeaseStore(join(root, "leases"));
  }
  cleanup.push(async () => {
    store.close();
  });
  const router = new BodyLeaseRouter(store);
  const child = spawn(
    process.execPath,
    [new URL("./fixtures/body-recovery-service.ts", import.meta.url).pathname],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  });
  const [ready] = (await once(child, "message")) as [{ port: number }];
  const host = `http://127.0.0.1:${ready.port}`;
  const attempts: number[] = [];
  let beforeStop: (() => Promise<void>) | undefined;
  const confirmStopped = async (_resource: BodyResource, guard: () => Promise<void>) => {
    attempts.push(Date.now());
    await guard();
    await beforeStop?.();
    await guard();
    const response = await fetch(`${host}/stop`);
    const proof = (await response.json()) as { stopped: boolean };
    if (proof.stopped) {
      if (child.exitCode === null) await once(child, "exit");
      await guard();
      return child.exitCode === 0;
    }
    return false;
  };
  const recovery = new BodyLeaseRecovery({
    store,
    router,
    retryMs: 20,
    maxRetryMs: 80,
    current: () => true,
    holderTurnEnded: (id) => conversations.turnIdle(id),
    confirmStopped,
  });
  cleanup.push(async () => {
    recovery.close();
    await recovery.settled();
  });
  const turn = () => {
    const submitted = conversations.submitInternal("global-default", "fixture work", "wake");
    if (submitted.status !== "accepted") throw Error("No fixture turn");
    return {
      entered: entered.promise,
      finish: async () => {
        finished.resolve();
        await conversations.awaitRun(submitted.runId);
      },
    };
  };
  const allowStop = async () => {
    await fetch(`${host}/allow-stop`);
  };
  return {
    root,
    resource,
    conversationId,
    store,
    router,
    conversations,
    recovery,
    attempts,
    held: store.recoveryReference(resource)!,
    child,
    host,
    turn,
    allowStop,
    confirmStopped,
    beforeStop: (hook: () => Promise<void>) => {
      beforeStop = hook;
    },
  };
}

it.each([
  { resource: "browser", holderEvidence: "missing" },
  { resource: "play", holderEvidence: "missing" },
  { resource: "browser", holderEvidence: "unreadable" },
  { resource: "play", holderEvidence: "unreadable" },
  { resource: "browser", holderEvidence: "native_responding" },
  { resource: "play", holderEvidence: "native_responding" },
] as const)(
  "never automatically stops a restored $resource with $holderEvidence holder evidence",
  async (options) => {
    const f = await fixture(true, options);
    const restored = f.store.recoveryReference(f.resource);
    const durableClaim = await readFile(join(f.root, "leases/body-leases.json"), "utf8");
    if (options.holderEvidence === "native_responding") {
      expect(f.conversations.hasNativeSeat(f.conversationId)).toBe(true);
      expect(f.conversations.conversation(f.conversationId)?.sessionState).not.toBe("active");
      const replay = await f.conversations.serve({
        op: "replay",
        schemaVersion: 1,
        replay: {
          schemaVersion: 1,
          conversationId: f.conversationId,
          surfaceClientId: "body-recovery-proof",
        },
      });
      if (replay.op !== "replay" || replay.result.status !== "page") throw Error("No native activity proof");
      expect(replay.result.events).toContainEqual(
        expect.objectContaining({ type: "activity", phase: "responding" }),
      );
    } else {
      expect(f.conversations.has(f.conversationId)).toBe(false);
    }
    expect(f.conversations.turnIdle(f.conversationId)).toBe(false);
    await f.allowStop();
    f.recovery.start();
    await pause(120);
    f.recovery.close();
    await f.recovery.settled();
    expect(f.attempts).toEqual([]);
    expect(f.child.exitCode).toBeNull();
    expect(f.child.signalCode).toBeNull();
    expect(f.store.status(f.resource)?.state).toBe("recovery_required");
    expect(f.store.recoveryReference(f.resource)).toEqual(restored);
    expect(await readFile(join(f.root, "leases/body-leases.json"), "utf8")).toBe(durableClaim);
    if (options.holderEvidence === "native_responding") {
      const manual = await f.router.recover(
        {
          conversationId: f.conversationId,
          current: () => true,
          authorize: async () => true,
        },
        f.resource,
        (guard) => f.confirmStopped(f.resource, guard),
      );
      expect(manual).toEqual({ outcome: "released" });
      expect(f.child.exitCode).toBe(0);
      expect(f.attempts).toHaveLength(1);
      expect(f.store.recoveryReference(f.resource)).toBeUndefined();
    }
  },
);

it("automatically recovers a boot-restored idle lease only after the real host confirms stop, with capped backoff", async () => {
  const f = await fixture(true);
  expect(f.store.status("browser")?.state).toBe("recovery_required");
  f.recovery.start();
  await until(() => f.attempts.length >= 5, "bounded retries");
  expect(f.store.status("browser")?.state).toBe("recovery_required");
  expect(f.child.exitCode).toBeNull();
  const intervals = f.attempts.slice(1).map((at, index) => at - f.attempts[index]!);
  expect(intervals[0]).toBeGreaterThanOrEqual(20);
  expect(intervals[1]).toBeGreaterThanOrEqual(40);
  expect(intervals[2]).toBeGreaterThanOrEqual(80);
  expect(intervals.slice(-2).every((ms) => ms < 300)).toBe(true);
  await f.allowStop();
  await until(() => f.store.status("browser") === undefined, "confirmed body release");
  expect(f.child.exitCode).toBe(0);
  expect(JSON.parse(await readFile(join(f.root, "leases/body-leases.json"), "utf8")).claims).toEqual([]);
});

it("does not attempt stop during a real holder turn, then retries after the turn ends", async () => {
  const f = await fixture();
  const turn = f.turn();
  await turn.entered;
  expect(f.conversations.turnIdle("global-default")).toBe(false);
  await f.allowStop();
  f.recovery.start();
  await pause(90);
  expect(f.attempts).toEqual([]);
  expect(f.child.exitCode).toBeNull();
  await turn.finish();
  await until(() => f.store.status("browser") === undefined, "release after ended turn");
  expect(f.attempts).toHaveLength(1);
});

it("cannot stop or release a live body operation even if its holder turn is idle", async () => {
  const f = await fixture();
  // A normal active effect becomes uncertain only after its operation has settled.
  f.store.reconcileStopped(f.held);
  const acquired = f.store.acquire("browser", "global-default", 300000);
  if (acquired.outcome !== "acquired") throw Error("No live lease");
  const operation = f.store.begin(acquired.lease);
  if (operation.outcome !== "admitted") throw Error("No live operation");
  const recoveryPin = f.store.beginRecovery(acquired.lease);
  if (recoveryPin.outcome !== "admitted") throw Error("No recovery pin");
  f.store.finish(acquired.lease, recoveryPin.operationId, "uncertain");
  await f.allowStop();
  f.recovery.start();
  await pause(90);
  expect(f.attempts).toEqual([]);
  expect(f.store.status("browser")?.state).toBe("recovery_required");
  f.store.finish(acquired.lease, operation.operationId, "settled");
  await until(() => f.store.status("browser") === undefined, "release after body operation settles");
});

it("waits for a service driver to settle even when conversation metadata already says waiting", async () => {
  const f = await fixture(),
    entered = deferred(),
    finish = deferred();
  const drive = f.conversations.runWithConversationDriver(
    "global-default",
    () => undefined,
    async () => {
      entered.resolve();
      await finish.promise;
    },
  );
  await entered.promise;
  expect(f.conversations.conversation("global-default")?.sessionState).not.toBe("active");
  expect(f.conversations.turnIdle("global-default")).toBe(false);
  await f.allowStop();
  f.recovery.start();
  await pause(90);
  expect(f.attempts).toEqual([]);
  finish.resolve();
  await drive;
  await until(() => f.store.status("browser") === undefined, "driver settles before recovery");
});

it("reauthorizes after awaited discovery when a holder starts a new turn", async () => {
  const f = await fixture();
  let turn: ReturnType<typeof f.turn> | undefined;
  f.beforeStop(async () => {
    turn = f.turn();
    await turn.entered;
  });
  await f.allowStop();
  f.recovery.start();
  await until(() => f.attempts.length > 0, "stop discovery");
  await pause(90);
  expect(f.store.status("browser")?.state).toBe("recovery_required");
  expect(f.child.exitCode).toBeNull();
  f.beforeStop(async () => {});
  await turn!.finish();
  await until(() => f.store.status("browser") === undefined, "guarded retry");
});

it("shutdown cancels the original check's authority and waits for it without releasing the lease", async () => {
  const f = await fixture(),
    checking = deferred(),
    finish = deferred();
  f.beforeStop(async () => {
    checking.resolve();
    await finish.promise;
  });
  await f.allowStop();
  f.recovery.start();
  await checking.promise;
  f.recovery.close();
  finish.resolve();
  await f.recovery.settled();
  expect(f.store.status("browser")?.state).toBe("recovery_required");
  expect(f.child.exitCode).toBeNull();
  const count = f.attempts.length;
  await pause(90);
  expect(f.attempts).toHaveLength(count);
});

it("leaves active leases and the separate computer recovery contract untouched", async () => {
  const f = await fixture();
  f.store.reconcileStopped(f.held);
  expect(f.store.acquire("browser", "global-default", 300000).outcome).toBe("acquired");
  const computer = f.store.acquire("computer", "global-default", 300000);
  if (computer.outcome !== "acquired") throw Error("No computer lease");
  const operation = f.store.begin(computer.lease);
  if (operation.outcome !== "admitted") throw Error("No computer operation");
  f.store.finish(computer.lease, operation.operationId, "uncertain");
  await f.allowStop();
  f.recovery.start();
  await pause(90);
  expect(f.attempts).toEqual([]);
  expect(f.store.status("browser")?.state).toBe("active");
  expect(f.store.status("computer")?.state).toBe("recovery_required");
});
