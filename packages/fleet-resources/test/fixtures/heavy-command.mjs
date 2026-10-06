import { writeFile, access } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { createResourceGovernor } from "../../src/governor.ts";
import { processIdentity } from "../../src/process.ts";

const [mode, receipt, release, directory] = process.argv.slice(2);
const identity = await processIdentity();
if (!identity) throw new Error("Owned command identity unavailable");
await writeFile(receipt, JSON.stringify({ pid: identity.pid, startTime: identity.startTime }));
if (mode === "nested") {
  const governor = createResourceGovernor({ directory });
  try {
    const code = await governor.runHeavy(process.execPath, ["-e", "process.exit(17)"]);
    await writeFile(`${receipt}.nested`, JSON.stringify({ code, snapshot: await governor.snapshot() }));
    process.exitCode = code;
  } finally {
    await governor.close();
  }
} else if (mode === "hold") {
  for (;;) {
    try {
      await access(release);
      break;
    } catch {
      await setTimeout(20);
    }
  }
} else if (mode === "exit") process.exitCode = Number(release);
