import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BodyLeaseStore } from "../src/body-leases.ts";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "clankie-body-leases-"));
  roots.push(root);
  let now = 1000;
  return {
    root,
    store: new BodyLeaseStore(root, () => now),
    advance: () => {
      now += 2000;
    },
  };
}
function acquire(store: BodyLeaseStore, conversationId = "thread-a") {
  const result = store.acquire("play", conversationId, 1000);
  if (result.outcome !== "acquired") throw new Error(JSON.stringify(result));
  return result.lease;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("exclusive conversation body leases", () => {
  it("retires legacy browser claims on restart without holding conversation tabs for recovery", () => {
    const { store, root } = fixture();
    store.close();
    writeFileSync(
      join(root, "body-leases.json"),
      JSON.stringify({
        schemaVersion: 1,
        claims: [
          {
            resource: "browser",
            conversationId: "old-room",
            token: randomUUID(),
            expiresAt: 0,
            recovery: true,
            operations: [],
          },
        ],
        requests: [],
      }),
    );
    const restarted = new BodyLeaseStore(root);
    expect(restarted.status("browser")).toBeUndefined();
    expect(restarted.acquire("browser", "new-room", 1000)).toEqual({
      outcome: "rejected",
      reason: "unavailable",
    });
    restarted.close();
  });
  it("admits only one simultaneous claimant while leaving other resources free", async () => {
    const { store } = fixture();
    const results = await Promise.all(["a", "b"].map(async (id) => store.acquire("play", id, 1000)));
    expect(results.map((r) => r.outcome)).toEqual(["acquired", "busy"]);
    expect(store.acquire("voice", "b", 1000).outcome).toBe("acquired");
    expect(JSON.stringify(store.status("play"))).not.toContain("token");
    store.close();
  });

  it("fences stale release, renewal and completion even when the same conversation reacquires", () => {
    const { store } = fixture();
    const old = acquire(store);
    const begun = store.begin(old);
    if (begun.outcome !== "admitted") throw new Error("not admitted");
    expect(store.finish(old, begun.operationId, "settled").outcome).toBe("finished");
    expect(store.release(old).outcome).toBe("released");
    const fresh = acquire(store);
    expect(fresh.token).not.toBe(old.token);
    expect(store.release(old)).toEqual({ outcome: "rejected", reason: "stale_lease" });
    expect(store.renew(old, 1000)).toEqual({ outcome: "rejected", reason: "stale_lease" });
    expect(store.finish(old, begun.operationId, "settled")).toEqual({
      outcome: "rejected",
      reason: "stale_lease",
    });
    expect(store.status("play")?.conversationId).toBe("thread-a");
    store.close();
  });

  it("expiry cannot transfer an in-flight resource or revive its token", () => {
    const { store, advance } = fixture();
    const lease = acquire(store);
    const operation = store.begin(lease);
    if (operation.outcome !== "admitted") throw new Error("not admitted");
    advance();
    expect(store.validate(lease, operation.operationId)).toEqual({
      outcome: "rejected",
      reason: "recovery_required",
    });
    expect(store.acquire("play", "b", 1000).outcome).toBe("busy");
    expect(store.renew(lease, 1000).outcome).toBe("rejected");
    expect(store.reconcileStopped(lease).outcome).toBe("rejected");
    expect(() => store.close()).toThrow("must settle");
    store.finish(lease, operation.operationId, "settled");
    expect(store.release(lease).outcome).toBe("rejected");
    expect(store.reconcileStopped(lease).outcome).toBe("released");
    expect(store.acquire("play", "b", 1000).outcome).toBe("acquired");
    store.close();
  });

  it("uncertain effect remains blocked until exact reconciliation", () => {
    const { store } = fixture();
    const lease = acquire(store);
    const operation = store.begin(lease);
    if (operation.outcome !== "admitted") throw new Error("not admitted");
    store.finish(lease, operation.operationId, "uncertain");
    expect(store.begin(lease).outcome).toBe("rejected");
    expect(store.release(lease).outcome).toBe("rejected");
    expect(store.status("play")?.state).toBe("recovery_required");
    expect(store.reconcileStopped(lease).outcome).toBe("released");
    store.close();
  });

  it("restart fences old tokens and retains occupied bodies for recovery", () => {
    const { store, root } = fixture();
    const lease = acquire(store);
    expect(() => new BodyLeaseStore(root)).toThrow();
    store.close();
    const restarted = new BodyLeaseStore(root);
    expect(restarted.status("play")?.state).toBe("recovery_required");
    expect(restarted.release(lease)).toEqual({ outcome: "rejected", reason: "stale_lease" });
    const recovery = restarted.recoveryReference("play");
    if (recovery === undefined) throw new Error("missing recovery");
    expect(restarted.reconcileStopped(recovery).outcome).toBe("released");
    restarted.close();
  });

  it("corrupt or unwritable state fails closed before admission", () => {
    const { store, root } = fixture();
    store.close();
    writeFileSync(join(root, "body-leases.json"), "{corrupt");
    const corrupt = new BodyLeaseStore(root);
    expect(corrupt.acquire("play", "a", 1000)).toEqual({
      outcome: "rejected",
      reason: "store_unavailable",
    });
    expect(() => corrupt.status("play")).toThrow();
    corrupt.close();
    rmSync(join(root, "body-leases.json"));
    const healthy = new BodyLeaseStore(root);
    rmSync(root, { recursive: true });
    expect(healthy.acquire("play", "a", 1000)).toEqual({
      outcome: "rejected",
      reason: "store_unavailable",
    });
  });
});

it("recovers a proven-dead process lock after abrupt death without freeing its body claim", async () => {
  const { spawnSync } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "clankie-body-death-"));
  roots.push(root);
  const module = new URL("../src/body-leases.ts", import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { BodyLeaseStore } from ${JSON.stringify(module)}; const store = new BodyLeaseStore(${JSON.stringify(root)}); store.acquire("voice", "room-a", 1000); process.kill(process.pid, "SIGKILL");`,
    ],
    { encoding: "utf8" },
  );
  expect(child.signal, child.stderr).toBe("SIGKILL");
  const recovered = new BodyLeaseStore(root);
  expect(recovered.status("voice")).toMatchObject({ conversationId: "room-a", state: "recovery_required" });
  expect(recovered.acquire("voice", "room-b", 1000).outcome).toBe("busy");
  recovered.close();
});
