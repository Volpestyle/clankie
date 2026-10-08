import { writeFile, access, rename } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { createResourceGovernor } from "../../src/governor.ts";
import { processIdentity } from "../../src/process.ts";

const [mode, receipt, release, directory] = process.argv.slice(2);
const identity = await processIdentity();
if (!identity) throw new Error("Owned command identity unavailable");
// Receipt existence is the test's readiness boundary; publish complete JSON.
await writeFile(`${receipt}.writing`, JSON.stringify({ pid: identity.pid, startTime: identity.startTime }));
await rename(`${receipt}.writing`, receipt);
if (mode === "nested" || mode === "nested-other-holder") {
  const governor = createResourceGovernor({ directory });
  try {
    const cancelled = new AbortController();
    const code = await governor.runHeavy(
      process.execPath,
      ["-e", "process.exit(17)"],
      mode === "nested-other-holder"
        ? {
            holderId: "other-native-child",
            signal: cancelled.signal,
            onWait: async (snapshot) => {
              await writeFile(`${receipt}.waiting`, JSON.stringify(snapshot));
              cancelled.abort();
            },
          }
        : undefined,
    );
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
