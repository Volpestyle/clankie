import { createResourceGovernor } from "../../src/governor.ts";

const [directory, seatId, command, ...args] = process.argv.slice(2);
const governor = createResourceGovernor({ directory });
try {
  process.exitCode = await governor.runHeavy(command, args, { seatId });
} finally {
  await governor.close();
}
