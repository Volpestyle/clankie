import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { ResourceStore } from "../../src/store.ts";
import { processIdentity, resourceNativeHelperPath, resourcePython } from "../../src/process.ts";

const [directory, mode, claimReceipt, readyReceipt, commandReceipt] = process.argv.slice(2);
const owner = await processIdentity();
const lease = {
  id: randomUUID(),
  token: randomUUID(),
  kind: "heavy",
  state: "starting",
  executable: "node",
  claimOwner: owner,
  createdAtMs: Date.now(),
  lastUsedAtMs: Date.now(),
};
await new ResourceStore(directory).transaction((state) => state.leases.push(lease));
await writeFile(claimReceipt, JSON.stringify({ id: lease.id, token: lease.token }));
if (mode === "registered") {
  const runner = spawn(
    resourcePython,
    ["-I", resourceNativeHelperPath(), "run", directory, lease.id, lease.token],
    { detached: true, stdio: ["ignore", "ignore", "inherit", "pipe", "pipe"] },
  );
  runner.stdio[3].write(
    `${JSON.stringify({ command: process.execPath, args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'submitted')", commandReceipt] })}\n`,
  );
  const replies = createInterface({ input: runner.stdio[4] });
  await replies[Symbol.asyncIterator]().next();
  await writeFile(readyReceipt, "registered");
}
setInterval(() => {}, 1_000);
await new Promise(() => {});
