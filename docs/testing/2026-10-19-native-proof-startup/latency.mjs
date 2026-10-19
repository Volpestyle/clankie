// Times the real native proof helper over its --serve pipe: spawn-to-first-reply (cold) and warm replies.
import { spawn } from "node:child_process";
import { createServer, connect } from "node:net";
import { loadavg } from "node:os";
import { createInterface } from "node:readline";

const helper = process.argv[2];
const rounds = Number(process.argv[3] ?? 10);
const warmPerRound = Number(process.argv[4] ?? 5);
const server = createServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const accepted = new Promise((r) => server.once("connection", r));
const client = connect(server.address().port, "127.0.0.1");
const socket = await accepted;
const socketArgs = [String(socket.remotePort), String(socket.localPort)];

async function round() {
  const t0 = performance.now();
  const child = spawn(helper, ["--serve"], { stdio: "pipe" });
  const lines = createInterface({ input: child.stdout });
  const replies = [];
  lines.on("line", (l) => replies.shift()?.(l));
  let id = 0;
  const ask = (args) =>
    new Promise((resolve) => {
      const start = performance.now();
      replies.push((line) => {
        const ok = JSON.parse(line).ok;
        resolve({ ms: performance.now() - start, ok });
      });
      child.stdin.write(`${++id} ${args.join(" ")}\n`);
    });
  const cold = await ask(socketArgs);
  const coldTotal = performance.now() - t0;
  const warm = [];
  for (let i = 0; i < warmPerRound; i++) warm.push(await ask(socketArgs));
  const birth = await ask(["--birth", String(process.pid)]);
  child.kill("SIGKILL");
  await new Promise((r) => child.once("close", r));
  return {
    cold: coldTotal,
    coldOk: cold.ok,
    warm: warm.map((w) => w.ms),
    warmOk: warm.every((w) => w.ok),
    birth: birth.ms,
  };
}
const results = [];
for (let i = 0; i < rounds; i++) results.push(await round());
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const cold = results.map((r) => r.cold),
  warm = results.flatMap((r) => r.warm),
  birth = results.map((r) => r.birth);
const f = (xs) => ({
  n: xs.length,
  p50: +pct(xs, 0.5).toFixed(1),
  p90: +pct(xs, 0.9).toFixed(1),
  max: +Math.max(...xs).toFixed(1),
  over1s: xs.filter((x) => x > 1000).length,
});
console.error("cold", cold.map((x) => x.toFixed(0)).join(" "));
console.log(
  JSON.stringify({
    load1: loadavg()[0].toFixed(1),
    cold: f(cold),
    warmSocket: f(warm),
    warmBirth: f(birth),
    allOk: results.every((r) => r.coldOk && r.warmOk),
  }),
);
client.destroy();
server.close();
