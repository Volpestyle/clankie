import { createResourceGovernor } from "../../src/governor.ts";

const [directory, seatId, command, ...args] = process.argv.slice(2);
// These fixtures prove process ownership, not machine pressure (covered by the
// darwin-pressure and probe-failure suites), so a busy host must not queue them
// indefinitely (VUH-1956, VUH-1981).
const governor = createResourceGovernor({
  directory,
  probe: async () => ({ loadRatio: 0, availableMemoryMb: 1_000_000 }),
});
try {
  process.exitCode = await governor.runHeavy(command, args, { seatId });
} finally {
  await governor.close();
}
