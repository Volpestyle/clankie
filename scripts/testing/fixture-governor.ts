import {
  createResourceGovernor,
  type FleetResourceGovernor,
} from "../../packages/fleet-resources/src/index.ts";

/** Real native runners and journals beneath the enclosing check's host permit. */
export function fixtureGovernor(directory: string, signal: AbortSignal): FleetResourceGovernor {
  const governor = createResourceGovernor({
    directory,
    probe: async () => ({ loadRatio: 0, cpuRatio: 0, availableMemoryMb: 65_536 }),
  });
  return {
    ...governor,
    runHeavy: (command, args, options = {}) =>
      governor.runHeavy(command, args, {
        ...options,
        signal: AbortSignal.any([signal, ...(options.signal ? [options.signal] : [])]),
      }),
  };
}
