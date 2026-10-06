import { writeFile, access } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { createResourceGovernor } from "../../src/governor.ts";

const [mode, receipt, release, directory] = process.argv.slice(2);
await writeFile(receipt, JSON.stringify({ pid: process.pid }));
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
