import { describe, expect, it } from "vitest";
import {
  HerdrTerminalControlStore,
  type HerdrTerminalController,
  type StartHerdrTerminalController,
} from "../src/captain/herdr-terminal-control.ts";

const TERMINAL = "term-worker";
const PHONE = "command-center-mobile";
const TABLET = "command-center-tablet";

function controlRequest(
  action: "request" | "renew" | "release",
  surfaceClientId: string,
  leaseToken?: string,
) {
  return {
    schemaVersion: 1 as const,
    action,
    terminalId: TERMINAL,
    surfaceClientId,
    ...(leaseToken === undefined ? {} : { leaseToken }),
  };
}

function fakeController(): HerdrTerminalController & { written: string[]; closed: boolean } {
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const controller = {
    written: [] as string[],
    closed: false,
    write(line: string) {
      if (controller.closed) return false;
      controller.written.push(line);
      return true;
    },
    done,
    close() {
      controller.closed = true;
      resolveDone();
    },
  };
  return controller;
}

describe("herdr terminal control leases", () => {
  it("grants an exclusive lease, writes raw bytes through it, and releases the controller", () => {
    const controllers: ReturnType<typeof fakeController>[] = [];
    const startController: StartHerdrTerminalController = () => {
      const controller = fakeController();
      controllers.push(controller);
      return controller;
    };
    const store = new HerdrTerminalControlStore({ startController });

    const granted = store.control(controlRequest("request", PHONE));
    if (granted.status !== "granted") throw new Error("grant expected");
    expect(granted.grant.owner).toEqual({ principalId: PHONE });

    const delivered = store.input({
      schemaVersion: 1,
      terminalId: TERMINAL,
      surfaceClientId: PHONE,
      leaseToken: granted.grant.leaseToken,
      dataBase64: "aGVsbG8=",
    });
    expect(delivered).toMatchObject({ status: "delivered" });
    expect(controllers).toHaveLength(1);
    expect(controllers[0]!.written).toEqual([JSON.stringify({ type: "terminal.input", bytes: "aGVsbG8=" })]);

    const released = store.control(controlRequest("release", PHONE, granted.grant.leaseToken));
    expect(released).toMatchObject({ status: "released" });
    expect(controllers[0]!.closed).toBe(true);
    store.close();
  });

  it("reports contention to another surface and lets the holder renew or reclaim", () => {
    const store = new HerdrTerminalControlStore({ startController: fakeController });
    const granted = store.control(controlRequest("request", PHONE));
    if (granted.status !== "granted") throw new Error("grant expected");

    expect(store.control(controlRequest("request", TABLET))).toMatchObject({
      status: "contended",
      owner: { principalId: PHONE },
    });
    expect(
      store.input({
        schemaVersion: 1,
        terminalId: TERMINAL,
        surfaceClientId: TABLET,
        leaseToken: granted.grant.leaseToken,
        dataBase64: "aGVsbG8=",
      }),
    ).toMatchObject({ status: "contended", owner: { principalId: PHONE } });

    const renewed = store.control(controlRequest("renew", PHONE, granted.grant.leaseToken));
    expect(renewed).toMatchObject({ status: "granted" });
    // A relaunched holder reclaims with a plain request; the stale token dies.
    const reclaimed = store.control(controlRequest("request", PHONE));
    if (reclaimed.status !== "granted") throw new Error("grant expected");
    expect(store.control(controlRequest("renew", PHONE, granted.grant.leaseToken))).toMatchObject({
      status: "denied",
      reason: "lease_expired",
    });
    store.close();
  });

  it("expires leases on the clock and fails soft when Herdr cannot spawn", () => {
    let now = 0;
    const store = new HerdrTerminalControlStore({
      startController: fakeController,
      leaseTtlMs: 1_000,
      clock: () => now,
    });
    const granted = store.control(controlRequest("request", PHONE));
    if (granted.status !== "granted") throw new Error("grant expected");
    now = 2_000;
    expect(
      store.input({
        schemaVersion: 1,
        terminalId: TERMINAL,
        surfaceClientId: PHONE,
        leaseToken: granted.grant.leaseToken,
        dataBase64: "aGVsbG8=",
      }),
    ).toMatchObject({ status: "denied", reason: "lease_required" });
    store.close();

    const unavailable = new HerdrTerminalControlStore({
      startController: () => {
        throw new Error("spawn herdr ENOENT");
      },
    });
    expect(unavailable.control(controlRequest("request", PHONE))).toMatchObject({
      status: "unavailable",
      reason: "herdr_unavailable",
    });
  });

  it("drops the lease when the controller process dies so input fails typed", async () => {
    const controller = fakeController();
    const store = new HerdrTerminalControlStore({ startController: () => controller });
    const granted = store.control(controlRequest("request", PHONE));
    if (granted.status !== "granted") throw new Error("grant expected");
    controller.close();
    await Promise.resolve();
    expect(
      store.input({
        schemaVersion: 1,
        terminalId: TERMINAL,
        surfaceClientId: PHONE,
        leaseToken: granted.grant.leaseToken,
        dataBase64: "aGVsbG8=",
      }),
    ).toMatchObject({ status: "denied", reason: "lease_required" });
    store.close();
  });
});
