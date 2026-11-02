// Disposable service controller for #277. The desktop core is a read-only
// terminal snapshot; native worker process, Unix server and delivery are real.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHerdrCoreRunner, HERDR_CORE_FLEET } from "../../src/captain/herdr-core-runner.ts";
import type { HerdrCoreTerminal, HerdrCoreSeats } from "../../src/captain/herdr-core-seats.ts";
import { routeHerdrFleets } from "../../src/captain/herdr-fleet-runner.ts";
import { HerdrWatchStore } from "../../src/captain/herdr-watch.ts";

const root = process.argv[2]!;
if (!root || resolve(homedir()) !== resolve(root) || process.env.NODE_ENV !== "test")
  throw new Error("Desktop delivery fixture requires its scratch HOME and NODE_ENV=test");
const terminals = async (): Promise<HerdrCoreTerminal[]> =>
  JSON.parse(await readFile(join(root, "terminals.json"), "utf8"));
const forbidden = async (): Promise<never> => {
  throw new Error("No terminal mutation in delivery fixture");
};
const seats: HerdrCoreSeats = {
  available: async () => true,
  list: terminals,
  get: async (address) => (await terminals()).find((terminal) => terminal.address === address),
  start: forbidden,
  kill: forbidden,
  read: forbidden,
  label: forbidden,
  keys: forbidden,
};
const desktop = createHerdrCoreRunner({ seats, seatDirectory: join(root, "seats") });
const runner = routeHerdrFleets(
  { get: forbidden, resolveTerminal: async () => undefined, wait: forbidden },
  new Map([[HERDR_CORE_FLEET, desktop]]),
);
const watches = new HerdrWatchStore(join(root, "subprocess-watch.json"), {
  runner,
  seatAdapters: [],
  remoteSeatAdapters: () => [],
  remoteCodexQueue: forbidden,
});
process.on("message", async (raw) => {
  const request = raw as { seatId: string; text: string; receipt: string };
  try {
    const result = await watches.deliverToSeat(request.seatId, request.text, undefined, {
      stableReceiptKey: request.receipt,
      delivery: "queue",
    });
    process.send?.({ result });
  } catch (error) {
    process.send?.({ error: String(error) });
  }
});
process.send?.({ ready: true });
