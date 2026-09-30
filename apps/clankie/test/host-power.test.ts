import { HostPowerReportSchema, type PowerExec } from "@clankie/protocol/host-power";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createHostPowerMonitor } from "../src/host-power.ts";

// VUH-1461 / ADR 0203: a sleeping host is a normal condition. The service
// cannot see itself asleep, so it notices the gap, and it tells the app and
// doctor whether the Mac may sleep at all.

const onBattery: PowerExec = async (_command, args) => ({
  stdout:
    args[1] === "batt"
      ? "Now drawing from 'Battery Power'\n"
      : args[1] === "custom"
        ? "Battery Power:\n sleep 1\nAC Power:\n sleep 0\n"
        : "Listed by owning process:\n",
  stderr: "",
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("host power monitor", () => {
  it("reports unknown until the first probe lands, then what pmset said", async () => {
    const monitor = createHostPowerMonitor({ exec: onBattery, keepAwakeRequested: async () => false });
    expect(monitor.report().state).toBe("unknown");
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.report()).toMatchObject({
      state: "sleep_allowed",
      source: "battery",
      sleepAfterMinutes: 1,
    });
    monitor.stop();
  });

  it("notices a sleep as a timer that fires far too late, and reports it once awake", async () => {
    const slept: unknown[] = [];
    let clock = Date.parse("2026-09-30T03:00:00.000Z");
    const monitor = createHostPowerMonitor({
      exec: onBattery,
      keepAwakeRequested: async () => false,
      now: () => clock,
      onSleep: (sleep) => slept.push(sleep),
    });
    await vi.advanceTimersByTimeAsync(15_000); // an ordinary tick
    expect(monitor.report().lastSleep).toBeUndefined();

    // The Mac sleeps for 14 minutes: the wall clock jumps, one timer fires.
    clock += 14 * 60_000;
    await vi.advanceTimersByTimeAsync(15_000);

    expect(monitor.report().lastSleep).toEqual({
      sleptAt: "2026-09-30T03:00:00.000Z",
      wokeAt: "2026-09-30T03:14:00.000Z",
      seconds: 840,
    });
    expect(slept).toHaveLength(1);
    monitor.stop();
  });

  it("does not mistake an ordinary tick or a brief stall for a sleep", async () => {
    let clock = 0;
    const monitor = createHostPowerMonitor({
      exec: onBattery,
      keepAwakeRequested: async () => false,
      now: () => clock,
    });
    clock += 20_000;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(monitor.report().lastSleep).toBeUndefined();
    monitor.stop();
  });

  it("reads the keep-awake opt-in fresh, so `clankie awake on` needs no restart", async () => {
    let requested = false;
    const monitor = createHostPowerMonitor({
      exec: onBattery,
      keepAwakeRequested: async () => requested,
      refreshMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.report().keepAwakeRequested).toBe(false);
    requested = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(monitor.report().keepAwakeRequested).toBe(true);
    monitor.stop();
  });
});

describe("/health", () => {
  it("carries the host power report the app reads", async () => {
    const power = {
      state: "sleep_allowed" as const,
      source: "battery" as const,
      sleepAfterMinutes: 1,
      heldAwakeBy: [],
      keepAwakeRequested: false,
      advice: "On battery this Mac sleeps after 1 min idle.",
    };
    const { app } = await createClankieApp({ captain: createStubCaptain(), hostPower: () => power });
    const body = (await (await app.request("/health")).json()) as { ok: boolean; power: unknown };
    expect(body.ok).toBe(true);
    expect(HostPowerReportSchema.parse(body.power)).toEqual(power);
  });

  it("omits power when no monitor is wired, and stays healthy", async () => {
    const { app } = await createClankieApp({ captain: createStubCaptain() });
    const body = (await (await app.request("/health")).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, service: "clankie" });
    expect(body).not.toHaveProperty("power");
  });
});
