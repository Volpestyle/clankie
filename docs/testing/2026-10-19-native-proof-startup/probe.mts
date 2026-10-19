// One product-path caller observation through a fresh transport and a never-executed helper copy.
import { copyFile } from "node:fs/promises";
import { createServer, connect, type Socket } from "node:net";
import { observeSocketProcess } from "../../../apps/clankie/src/local-fleet-process.ts";
const [source, copy] = process.argv.slice(2);
await copyFile(source!, copy!);
const server = createServer();
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const accepted = new Promise<Socket>((r) => server.once("connection", r));
const client = connect((server.address() as { port: number }).port, "127.0.0.1");
const socket = await accepted;
const reasons: string[] = [];
const t0 = performance.now();
const first = await observeSocketProcess(socket, copy!, undefined, undefined, (r) => reasons.push(r));
const t1 = performance.now();
const second = await observeSocketProcess(socket, copy!);
console.log(
  JSON.stringify({
    first: first?.owner.pid === process.pid ? "admitted" : "unavailable",
    firstMs: Math.round(t1 - t0),
    reasons,
    warm: second?.owner.pid === process.pid ? "admitted" : "unavailable",
  }),
);
client.destroy();
server.close();
process.exit(0);
