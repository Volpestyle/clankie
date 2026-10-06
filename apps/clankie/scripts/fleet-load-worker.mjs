#!/usr/bin/env node
/** Controlled external Codex-shaped worker; the bridge and service are production code. */
import { spawn, execFile } from "node:child_process";
import { writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

const [bridge, session, metricsPath, toolInterval, initialOffset] = process.argv.slice(2);
const execute = promisify(execFile);
const pane = process.env.HERDR_PANE_ID;
const metrics = { pid: process.pid, pane, session, ready: false, calls: [], errors: [] };
let sequence = 0;
const pending = new Map();
const child = spawn(process.execPath, [bridge], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    // Exercise the channel's native 25-second mailbox long poll as well as its
    // five-second catalog watcher. No captain messages or model turns are sent.
    CLANKIE_SEAT_PARENT_ARGV: "codex --dangerously-load-development-channels plugin:clankie-worker@clankie",
  },
});
child.stderr.on("data", (chunk) => {
  const text = String(chunk);
  if (/403|401|refus|denied|unavailable|failed|error/iu.test(text))
    metrics.errors.push({ at: Date.now(), error: text.slice(0, 2000) });
});
createInterface({ input: child.stdout }).on("line", (line) => {
  let reply;
  try {
    reply = JSON.parse(line);
  } catch {
    return;
  }
  const waiter = pending.get(reply.id);
  if (!waiter) return;
  pending.delete(reply.id);
  clearTimeout(waiter.timer);
  if (reply.error) waiter.reject(new Error(JSON.stringify(reply.error)));
  else waiter.resolve(reply.result);
});
child.on("exit", (code, signal) => {
  metrics.errors.push({ at: Date.now(), error: `Production bridge exited (${code ?? signal})` });
  for (const waiter of pending.values()) waiter.reject(new Error("Bridge exited"));
});
const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 35_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
const persist = async () => {
  await writeFile(`${metricsPath}.tmp`, JSON.stringify(metrics));
  await rename(`${metricsPath}.tmp`, metricsPath);
};
let stopped = false;
const stop = () => {
  stopped = true;
  child.kill("SIGTERM");
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
try {
  await execute("herdr", [
    "pane",
    "report-agent-session",
    pane,
    "--source",
    "herdr:codex",
    "--agent",
    "codex",
    "--agent-session-id",
    session,
    "--seq",
    "1",
  ]);
  await execute("herdr", [
    "pane",
    "report-agent",
    pane,
    "--source",
    "fixture-codex",
    "--agent",
    "codex",
    "--state",
    "working",
    "--agent-session-id",
    session,
    "--seq",
    "1",
  ]);
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "fleet-load", version: "1" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const catalog = await rpc("tools/list", {});
  if (!["clankie_tools", "clankie_call"].every((name) => catalog.tools?.some((tool) => tool.name === name)))
    throw new Error(`Legitimate worker did not receive its fleet tools: ${JSON.stringify(catalog)}`);
  const schema = await rpc("tools/call", {
    name: "clankie_tools",
    arguments: { names: ["linear_get_issue"] },
  });
  if (schema.isError) throw new Error(`Tool discovery failed: ${JSON.stringify(schema)}`);
  metrics.ready = true;
  await persist();
  while (!stopped && !existsSync(join(dirname(metricsPath), "start"))) await sleep(100);
  // Independent workers make calls at different points in the same 30-second
  // cadence. Catalog/mailbox polling remains the production bridge's own.
  await sleep(Number(initialOffset ?? 0));
  while (!stopped) {
    const at = Date.now();
    try {
      const result = await rpc("tools/call", {
        name: "clankie_call",
        arguments: { name: "linear_get_issue", arguments: { id: "LOAD-1" } },
      });
      metrics.calls.push({ at, latencyMs: Date.now() - at });
      if (result.isError) throw new Error(`Legitimate tool call failed: ${JSON.stringify(result)}`);
    } catch (error) {
      metrics.errors.push({ at, error: String(error) });
    }
    await persist();
    await sleep(Math.max(0, Number(toolInterval) - (Date.now() - at)));
  }
} catch (error) {
  metrics.errors.push({ at: Date.now(), error: String(error) });
} finally {
  await persist();
  child.kill("SIGTERM");
  process.exitCode = metrics.errors.length ? 1 : 0;
}
