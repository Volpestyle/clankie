# Isolated readiness proof source

Captured source used for the interrupted Linux real pi/Herdr run. The completed
native 20-run adaptation is described in [native.md](native.md). Save the fenced
source as `prove.mjs` in this directory to repeat the documented bundle command.
This is an evidence harness, not a shipped application entry point.

```js
// Bundle with esbuild and run only in the isolated, network-disabled proof container.
// The actual Herdr runner/store and real pi binary execute; only the model is canned.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { createHerdrWatchRunner, HerdrWatchStore } from "../../../../apps/clankie/src/captain/herdr-watch.ts";

assert.equal(process.env.CLANKIE_PI_READINESS_PROOF, "isolated-container");
const runs = 20;
const model = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (delta, finish_reason) =>
    res.write(
      `data: ${JSON.stringify({ id: "proof", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  chunk({ role: "assistant", content: "PI_READY_DONE" }, null);
  chunk({}, "stop");
  res.end("data: [DONE]\n\n");
});
await new Promise((resolve) => model.listen(18081, "127.0.0.1", resolve));
const runner = createHerdrWatchRunner();
const records = [];
const suiteStart = Date.now();
console.log(
  JSON.stringify({
    phase: "versions",
    herdr: execFileSync("herdr", ["--version"], { encoding: "utf8" }).trim(),
    pi: execFileSync("pi", ["--version"], { encoding: "utf8" }).trim(),
  }),
);
try {
  for (let i = 1; i <= runs; i++) {
    let startMs;
    const store = new HerdrWatchStore(`/tmp/proof-watches-${i}.json`, {
      runner: {
        ...runner,
        startAgent: async (args) => {
          const t = Date.now();
          try {
            await runner.startAgent(args);
          } finally {
            startMs = Date.now() - t;
          }
        },
      },
    });
    const t = Date.now();
    const result = await store.spawnSeat({
      schemaVersion: 1,
      harness: "pi",
      title: `Readiness ${i}`,
      workingDirectory: "/workspace",
    });
    const hireMs = Date.now() - t;
    let record = {
      i,
      outcome: result.outcome,
      reason: result.reason,
      detail: result.detail,
      startMs,
      hireMs,
    };
    try {
      assert.equal(result.outcome, "spawned", JSON.stringify(result));
      const agent = await runner.get(result.seat.paneId);
      assert.equal(agent.agent, "pi");
      assert.equal(agent.session?.source, "herdr:pi");
      assert.equal(agent.session?.kind, "path");
      assert.ok(["idle", "done"].includes(agent.status));
      assert.equal(
        await store.sendToSeat(result.seat.seatId, `PI_READY_PROBE ${i}: reply PI_READY_DONE`),
        true,
      );
      const deadline = Date.now() + 30_000;
      let transcript = "";
      while (Date.now() < deadline) {
        transcript = await readFile(agent.session.value, "utf8").catch(() => "");
        if (transcript.includes('"role":"assistant"') && transcript.includes("PI_READY_DONE")) break;
        await sleep(100);
      }
      assert.ok(
        transcript.includes('"role":"assistant"') && transcript.includes("PI_READY_DONE"),
        "pi must complete its real turn",
      );
      record = {
        ...record,
        session: agent.session,
        status: agent.status,
        turn: "passed",
        totalMs: Date.now() - t,
      };
    } finally {
      if (result.outcome === "spawned") await store.closeSeat(result.seat.seatId);
      store.close();
      records.push(record);
      console.log(JSON.stringify(record));
    }
  }
  console.log(
    JSON.stringify({
      phase: "summary",
      consecutive: records.length,
      spawned: records.filter((r) => r.outcome === "spawned").length,
      notReady: records.filter((r) => r.reason === "not_ready").length,
      turns: records.filter((r) => r.turn === "passed").length,
      wallMs: Date.now() - suiteStart,
    }),
  );
} finally {
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
}
```
