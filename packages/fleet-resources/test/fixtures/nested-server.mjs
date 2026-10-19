import { access, rename, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { createResourceGovernor } from "../../src/governor.ts";

const [directory, holderId, barrier, receipt, command] = process.argv.slice(2);
/** The test polls these receipts; a rename never exposes a partial write. */
const publish = async (path, text) => {
  await writeFile(`${path}.tmp`, text);
  await rename(`${path}.tmp`, path);
};
const governor = createResourceGovernor({
  directory,
  probe: async () => ({ loadRatio: 0, availableMemoryMb: 64_000 }),
});
try {
  await writeFile(`${receipt}.ready`, "ready");
  for (;;) {
    try {
      await access(barrier);
      break;
    } catch {
      await setTimeout(20);
    }
  }
  const stop = new AbortController();
  const code = await governor.runHeavy(process.execPath, [command, receipt], {
    server: true,
    holderId,
    signal: stop.signal,
    onWait: async (snapshot) => {
      process.stdout.write(
        `Nested server admission wait: ${JSON.stringify({ capacity: snapshot.capacity, queue: snapshot.serverQueue })}\n`,
      );
      await publish(`${receipt}.waiting`, JSON.stringify(snapshot));
      stop.abort();
    },
  });
  await publish(`${receipt}.done`, JSON.stringify({ code, snapshot: await governor.snapshot() }));
  process.exitCode = code;
} finally {
  await governor.close();
}
