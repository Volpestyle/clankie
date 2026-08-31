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
  action: "request" | "renew" | "release" | "resize" | "scroll",
  surfaceClientId: string,
  leaseToken?: string,
  fields?: Record<string, number | string>,
) {
  return {
    schemaVersion: 1 as const,
    action,
    terminalId: TERMINAL,
    surfaceClientId,
    ...(leaseToken === undefined ? {} : { leaseToken }),
    ...fields,
  };
}

function fakeController(): HerdrTerminalController & {
  written: string[];
  closed: boolean;
} {
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
  it("grants an exclusive lease, writes raw bytes through it, and releases the controller", async () => {
    const controllers: ReturnType<typeof fakeController>[] = [];
    const startController: StartHerdrTerminalController = () => {
      const controller = fakeController();
      controllers.push(controller);
      return controller;
    };
    const store = new HerdrTerminalControlStore({
      readGrid: async () => undefined,
      startController,
    });

    const granted = await store.control(controlRequest("request", PHONE));
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

    const released = await store.control(controlRequest("release", PHONE, granted.grant.leaseToken));
    expect(released).toMatchObject({ status: "released" });
    expect(controllers[0]!.closed).toBe(true);
    store.close();
  });

  it("reports contention to another surface and lets the holder renew or reclaim", async () => {
    const store = new HerdrTerminalControlStore({
      readGrid: async () => undefined,
      startController: fakeController,
    });
    const granted = await store.control(controlRequest("request", PHONE));
    if (granted.status !== "granted") throw new Error("grant expected");

    expect(await store.control(controlRequest("request", TABLET))).toMatchObject({
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

    const renewed = await store.control(controlRequest("renew", PHONE, granted.grant.leaseToken));
    expect(renewed).toMatchObject({ status: "granted" });
    // A relaunched holder reclaims with a plain request; the stale token dies.
    const reclaimed = await store.control(controlRequest("request", PHONE));
    if (reclaimed.status !== "granted") throw new Error("grant expected");
    expect(await store.control(controlRequest("renew", PHONE, granted.grant.leaseToken))).toMatchObject({
      status: "denied",
      reason: "lease_expired",
    });
    store.close();
  });

  it("expires leases on the clock and fails soft when Herdr cannot spawn", async () => {
    let now = 0;
    const store = new HerdrTerminalControlStore({
      readGrid: async () => undefined,
      startController: fakeController,
      leaseTtlMs: 1_000,
      clock: () => now,
    });
    const granted = await store.control(controlRequest("request", PHONE));
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
      readGrid: async () => undefined,
      startController: () => {
        throw new Error("spawn herdr ENOENT");
      },
    });
    await expect(unavailable.control(controlRequest("request", PHONE))).resolves.toMatchObject({
      status: "unavailable",
      reason: "herdr_unavailable",
    });
  });

  it("claims control at the pane's own grid so the pane never reflows", async () => {
    const claims: unknown[] = [];
    const store = new HerdrTerminalControlStore({
      readGrid: async () => ({ columns: 126, rows: 50 }),
      startController: (terminalId, grid) => {
        claims.push({ terminalId, grid });
        return fakeController();
      },
    });

    await store.control(controlRequest("request", PHONE));
    expect(claims).toEqual([{ terminalId: TERMINAL, grid: { columns: 126, rows: 50 } }]);
    store.close();
  });

  it("resizes only through the holder's lease and exposes that grid to its observer", async () => {
    const controller = fakeController();
    const store = new HerdrTerminalControlStore({
      readGrid: async () => ({ paneId: "w1:p4", columns: 126, rows: 50 }),
      startController: () => controller,
    });
    const granted = await store.control(controlRequest("request", PHONE));
    if (granted.status !== "granted") throw new Error("grant expected");

    expect(
      await store.control(
        controlRequest("resize", TABLET, granted.grant.leaseToken, { columns: 48, rows: 24 }),
      ),
    ).toMatchObject({ status: "contended" });
    expect(
      await store.control(
        controlRequest("resize", PHONE, granted.grant.leaseToken, { columns: 48, rows: 24 }),
      ),
    ).toMatchObject({ status: "granted", grant: { leaseToken: granted.grant.leaseToken } });
    expect(controller.written).toEqual([JSON.stringify({ type: "terminal.resize", cols: 48, rows: 24 })]);
    expect(store.geometryFor(TERMINAL, PHONE)).toEqual({ paneId: "w1:p4", columns: 48, rows: 24 });
    expect(store.geometryFor(TERMINAL, `${PHONE}:native-feed`)).toEqual({
      paneId: "w1:p4",
      columns: 48,
      rows: 24,
    });
    expect(store.geometryFor(TERMINAL, TABLET)).toBeUndefined();
    store.close();
  });

  it("hands a scroll intent to Herdr as a wheel through the holder's lease", async () => {
    const controller = fakeController();
    const store = new HerdrTerminalControlStore({
      readGrid: async () => ({ paneId: "w1:p4", columns: 126, rows: 50 }),
      startController: () => controller,
    });
    const granted = await store.control(controlRequest("request", PHONE));
    if (granted.status !== "granted") throw new Error("grant expected");

    const scroll = { direction: "up", lines: 3, column: 10, row: 4 };
    expect(
      await store.control(controlRequest("scroll", TABLET, granted.grant.leaseToken, scroll)),
    ).toMatchObject({
      status: "contended",
    });
    expect(await store.control(controlRequest("scroll", PHONE, "stale", scroll))).toMatchObject({
      status: "denied",
    });
    expect(
      await store.control(controlRequest("scroll", PHONE, granted.grant.leaseToken, scroll)),
    ).toMatchObject({ status: "granted", grant: { leaseToken: granted.grant.leaseToken } });
    expect(controller.written).toEqual([
      JSON.stringify({
        type: "terminal.scroll",
        direction: "up",
        lines: 3,
        source: "wheel",
        column: 10,
        row: 4,
      }),
    ]);
    store.close();
  });

  it("drops the lease when the controller process dies so input fails typed", async () => {
    const controller = fakeController();
    const store = new HerdrTerminalControlStore({
      readGrid: async () => undefined,
      startController: () => controller,
    });
    const granted = await store.control(controlRequest("request", PHONE));
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
