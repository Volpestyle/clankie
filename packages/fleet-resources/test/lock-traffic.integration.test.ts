import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { createResourceGovernor } from "../src/governor.ts";
import { defaultResourcePolicy } from "../src/model.ts";
import { ResourceStore } from "../src/store.ts";

it("queued heavy commands leave the registry lock to the holders that can act (VUH-2053)", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-lock-traffic-"));
  const directory = join(root, "registry");
  const releasePath = join(root, "release");
  const probe = async () => ({ loadRatio: 0.1, availableMemoryMb: 64_000 });
  // Every client is its own governor, as separate `clankie heavy` processes are.
  const clients = Array.from({ length: 9 }, () => createResourceGovernor({ directory, probe }));
  await clients[0]!.configure({ ...defaultResourcePolicy(), heavySlots: 1 });
  const held = `const {existsSync}=require("node:fs");const w=()=>existsSync(${JSON.stringify(releasePath)})?process.exit(0):setTimeout(w,50);w();`;
  const stop = new AbortController();
  const runs: Promise<number>[] = [];
  const transaction = ResourceStore.prototype.transaction;
  let transactions = 0;
  ResourceStore.prototype.transaction = function (this: ResourceStore, ...args) {
    transactions++;
    return transaction.apply(this, args as Parameters<typeof transaction>);
  } as typeof transaction;
  try {
    // One gate holds the only slot; eight more queue behind it.
    runs.push(clients[0]!.runHeavy(process.execPath, ["-e", held], { holderId: "holder" }));
    const status = new ResourceStore(directory);
    while (!(await status.read()).leases.some((lease) => lease.kind === "heavy" && lease.state === "running"))
      await delay(50);
    for (const [index, client] of clients.slice(1).entries())
      runs.push(
        client
          .runHeavy(process.execPath, ["-e", ""], { holderId: `waiter-${index}`, signal: stop.signal })
          .catch(() => -1),
      );
    while ((await status.read()).queue.length < 8) await delay(50);

    // Over a four-second window a waiter that cannot be admitted takes the
    // lock only on its jittered full pass (at most every three seconds), not
    // every half second as before.
    transactions = 0;
    await delay(4_000);
    expect(transactions).toBeLessThanOrEqual(8 * 2);

    // Every waiter still runs once the slot frees.
    await writeFile(releasePath, "");
    expect(await Promise.all(runs)).toEqual(Array(9).fill(0));
  } finally {
    ResourceStore.prototype.transaction = transaction;
    stop.abort();
    await writeFile(releasePath, "");
    await Promise.allSettled(runs);
    await Promise.all(clients.map((client) => client.close()));
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
