import { describe, expect, it } from "vitest";
import {
  HostPowerReportSchema,
  assertionsHoldingSleep,
  assessHostPower,
  parsePmsetAssertions,
  parsePmsetSleepMinutes,
  parsePmsetSource,
  probeHostPower,
  type PowerExec,
} from "../src/host-power.ts";

const BATT_AC = `Now drawing from 'AC Power'
 -InternalBattery-0 (id=36765795)\t100%; charged; 0:00 remaining present: true
`;
const BATT_BATTERY = `Now drawing from 'Battery Power'
 -InternalBattery-0 (id=36765795)\t83%; discharging; 4:10 remaining present: true
`;
// Real `pmset -g custom` shape: displaysleep/disksleep must not be mistaken for `sleep`.
const CUSTOM = `Battery Power:
 Sleep On Power Button 1
 displaysleep         2
 sleep                1
 disksleep            10
AC Power:
 Sleep On Power Button 1
 displaysleep         10
 sleep                0
 disksleep            10
`;
const ASSERTIONS = `Assertion status system-wide:
   PreventUserIdleSystemSleep     1
Listed by owning process:
   pid 1023(sharingd): [0x0009ea8000018703] 00:01:36 PreventUserIdleSystemSleep named: "Handoff"  
   pid 27816(Amphetamine): [0x000765070005a62c] 50:00:34 PreventUserIdleDisplaySleep named: "Amphetamine (Single-Use - Display)"  
   pid 26534(caffeinate): [0x0009ead100018715] 00:00:15 PreventSystemSleep named: "caffeinate command-line tool"  
	Details: caffeinate asserting for 300 secs
`;

describe("pmset parsing", () => {
  it("reads the power source", () => {
    expect(parsePmsetSource(BATT_AC)).toBe("ac");
    expect(parsePmsetSource(BATT_BATTERY)).toBe("battery");
    expect(parsePmsetSource("pmset: command not found")).toBe("unknown");
  });

  it("reads system sleep minutes per source and ignores displaysleep and disksleep", () => {
    expect(parsePmsetSleepMinutes(CUSTOM, "battery")).toBe(1);
    expect(parsePmsetSleepMinutes(CUSTOM, "ac")).toBe(0);
    expect(parsePmsetSleepMinutes("nothing here", "ac")).toBeNull();
  });

  it("reads assertions by owning process", () => {
    expect(parsePmsetAssertions(ASSERTIONS)).toEqual([
      { process: "sharingd", type: "PreventUserIdleSystemSleep" },
      { process: "Amphetamine", type: "PreventUserIdleDisplaySleep" },
      { process: "caffeinate", type: "PreventSystemSleep" },
    ]);
  });

  it("counts PreventSystemSleep only on AC and never counts display assertions", () => {
    const assertions = parsePmsetAssertions(ASSERTIONS);
    expect(assertionsHoldingSleep(assertions, "ac").sort()).toEqual(["caffeinate", "sharingd"]);
    expect(assertionsHoldingSleep(assertions, "battery")).toEqual(["sharingd"]);
  });
});

describe("assessHostPower", () => {
  const base = { heldAwakeBy: [], keepAwakeRequested: false } as const;

  it("is always_on when power settings never sleep and says nothing", () => {
    const report = assessHostPower({ ...base, source: "ac", sleepAfterMinutes: 0 });
    expect(report).toMatchObject({ state: "always_on" });
    expect(report.advice).toBeUndefined();
  });

  it("is always_on while an assertion holds the Mac awake", () => {
    expect(
      assessHostPower({ ...base, source: "battery", sleepAfterMinutes: 1, heldAwakeBy: ["caffeinate"] }),
    ).toMatchObject({ state: "always_on" });
  });

  it("warns on battery with sleep allowed and names the way to stay awake", () => {
    const report = assessHostPower({ ...base, source: "battery", sleepAfterMinutes: 1 });
    expect(report.state).toBe("sleep_allowed");
    expect(report.advice).toContain("On battery");
    expect(report.advice).toContain("clankie awake on");
    expect(report.advice).toContain("hosted");
  });

  it("warns when plugged in but allowed to sleep", () => {
    const report = assessHostPower({ ...base, source: "ac", sleepAfterMinutes: 10 });
    expect(report.state).toBe("sleep_allowed");
    expect(report.advice).toContain("plugged in");
  });

  it("explains that keep-awake does not hold on battery", () => {
    const report = assessHostPower({
      ...base,
      keepAwakeRequested: true,
      source: "battery",
      sleepAfterMinutes: 1,
    });
    expect(report.advice).toContain("only holds while plugged in");
  });

  it("flags requested keep-awake that nothing is holding on AC", () => {
    const report = assessHostPower({
      ...base,
      keepAwakeRequested: true,
      source: "ac",
      sleepAfterMinutes: 10,
    });
    expect(report.state).toBe("sleep_allowed");
    expect(report.advice).toContain("clankie restart awake");
  });

  it("is unknown, without advice, when there is no signal", () => {
    const report = assessHostPower({ ...base, source: "unknown", sleepAfterMinutes: null });
    expect(report.state).toBe("unknown");
    expect(report.advice).toBeUndefined();
  });

  it("produces a report its own schema accepts, with the last sleep carried through", () => {
    const lastSleep = {
      sleptAt: "2026-09-30T08:00:00.000Z",
      wokeAt: "2026-09-30T08:14:00.000Z",
      seconds: 840,
    };
    const report = assessHostPower({ ...base, source: "battery", sleepAfterMinutes: 1, lastSleep });
    expect(HostPowerReportSchema.parse(report)).toEqual(report);
    expect(report.lastSleep).toEqual(lastSleep);
  });
});

describe("probeHostPower", () => {
  const fakePmset =
    (outputs: { batt: string; custom: string; assertions: string }): PowerExec =>
    (command, args) => {
      if (command !== "pmset") return Promise.reject(Object.assign(new Error("nope"), { code: "ENOENT" }));
      const flag = args[1];
      const stdout = flag === "batt" ? outputs.batt : flag === "custom" ? outputs.custom : outputs.assertions;
      return Promise.resolve({ stdout, stderr: "" });
    };

  it("assesses the current source from three pmset reads", async () => {
    const report = await probeHostPower({
      exec: fakePmset({ batt: BATT_BATTERY, custom: CUSTOM, assertions: "Listed by owning process:\n" }),
      keepAwakeRequested: false,
    });
    expect(report).toMatchObject({ state: "sleep_allowed", source: "battery", sleepAfterMinutes: 1 });
  });

  it("degrades to unknown when pmset is absent", async () => {
    const report = await probeHostPower({
      exec: () => Promise.reject(Object.assign(new Error("spawn pmset ENOENT"), { code: "ENOENT" })),
      keepAwakeRequested: true,
    });
    expect(report).toMatchObject({ state: "unknown", keepAwakeRequested: true });
  });
});
