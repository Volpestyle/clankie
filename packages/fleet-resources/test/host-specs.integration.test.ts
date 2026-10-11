// Published machine policy → host runtime sizing/admission, without remote process work.
import { availableParallelism, totalmem } from "node:os";
import { expect, it } from "vitest";
import { resolveFleetResourcePolicy } from "../../protocol/src/fleet-resources.ts";
import {
  automaticHeavySlots,
  baseHeavySlots,
  defaultResourcePolicy,
  heavyAdmission,
  resourceCapacity,
} from "../src/index.ts";

it("the host runtime and machine API size heavy capacity from the same measured host", () => {
  const policy = defaultResourcePolicy();
  for (const [cores, gib, ceiling, base] of [
    [4, 16, 1, 1],
    [16, 64, 5, 2],
    [18, 128, 9, 4],
    [256, 4096, 64, 64],
  ] as const) {
    const host = { platform: "win32" as const, cores, memoryBytes: gib * 1024 ** 3 };
    const resolved = resolveFleetResourcePolicy(policy, host);
    expect(resourceCapacity(policy, host)).toBe(ceiling);
    expect(resourceCapacity(policy, host)).toBe(resolved.heavySlots);
    expect(baseHeavySlots(policy, host)).toBe(base);
    expect(resolved.simulatorSlots).toBe(0);
    const override = { ...policy, heavySlots: 3 };
    expect(resourceCapacity(override, host)).toBe(resolveFleetResourcePolicy(override, host).heavySlots);
    expect(baseHeavySlots(override, host)).toBe(Math.min(3, base));
  }
  const local = { cores: availableParallelism(), memoryBytes: totalmem() };
  expect(automaticHeavySlots()).toBe(automaticHeavySlots(local));
  expect(baseHeavySlots(policy)).toBe(baseHeavySlots(policy, local));
});

it("admission charges unsettled jobs against the executing host's cores", () => {
  const policy = { ...defaultResourcePolicy(), heavySlots: 8 };
  const pressure = {
    sampledAtMs: 1000,
    healthy: true,
    loadRatio: 0.6,
    cpuRatio: 0.6,
    availableMemoryMb: 65536,
  };
  const held = [{ createdAtMs: 0 }];
  const small = { cores: 4, memoryBytes: 64 * 1024 ** 3 };
  const large = { cores: 16, memoryBytes: 64 * 1024 ** 3 };
  expect(heavyAdmission(policy, pressure, held, 1000, 60000, small)).toBe("pressure");
  expect(heavyAdmission(policy, pressure, held, 1000, 60000, large)).toBe("admit");
  const settled = [{ createdAtMs: 0 }, { createdAtMs: 0 }];
  expect(heavyAdmission(policy, { ...pressure, cpuRatio: 0.7 }, settled, 60000, 60000, large)).toBe(
    "pressure",
  );
  expect(heavyAdmission(policy, pressure, settled, 60000, 60000, large)).toBe("admit");
  expect(
    heavyAdmission(
      policy,
      { ...pressure, availableMemoryMb: policy.minAvailableMemoryMb },
      settled,
      60000,
      60000,
      large,
    ),
  ).toBe("pressure");
  expect(heavyAdmission({ ...policy, heavySlots: 2 }, pressure, settled, 60000, 60000, large)).toBe("slots");
});

it("explicit host facts preserve bounded load progress and unknown/memory refusals", () => {
  const policy = defaultResourcePolicy();
  const host = { cores: 16, memoryBytes: 64 * 1024 ** 3 };
  const pressure = {
    sampledAtMs: 0,
    healthy: false,
    reason: "load" as const,
    loadRatio: 2,
    availableMemoryMb: 65536,
  };
  expect(heavyAdmission(policy, pressure, [], 0, 60000, host)).toBe("admit");
  expect(heavyAdmission(policy, pressure, [{ createdAtMs: 0 }], 0, 60000, host)).toBe("pressure");
  expect(heavyAdmission(policy, { ...pressure, loadRatio: 3 }, [], 0, 60000, host)).toBe("pressure");
  expect(heavyAdmission(policy, { ...pressure, availableMemoryMb: 0 }, [], 0, 60000, host)).toBe("pressure");
  expect(heavyAdmission(policy, { ...pressure, reason: "probe-unavailable" }, [], 0, 60000, host)).toBe(
    "pressure",
  );
});

it("invalid host facts cannot fall back to the observer's hardware or an owner override", () => {
  const policy = { ...defaultResourcePolicy(), heavySlots: 3 };
  const pressure = { sampledAtMs: 0, healthy: true, loadRatio: 0, availableMemoryMb: 65536 };
  for (const host of [
    { cores: 0, memoryBytes: 1024 },
    { cores: 1.5, memoryBytes: 1024 },
    { cores: Infinity, memoryBytes: 1024 },
    { cores: 4097, memoryBytes: 1024 },
    { cores: 4, memoryBytes: NaN },
    { cores: 4, memoryBytes: 0 },
  ]) {
    expect(() => automaticHeavySlots(host)).toThrow("Invalid resource host specs");
    expect(() => resourceCapacity(policy, host)).toThrow("Invalid resource host specs");
    expect(() => baseHeavySlots(policy, host)).toThrow("Invalid resource host specs");
    expect(() => heavyAdmission(policy, pressure, [], 0, 60000, host)).toThrow("Invalid resource host specs");
  }
});
