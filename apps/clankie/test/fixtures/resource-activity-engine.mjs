// Explicit original-native engine surrogate. Runs the shipped mod and its
// real report helpers in a disposable fixture process, never a real harness.
import { spawn } from "node:child_process";
import { Writable } from "node:stream";
import { writeFile } from "node:fs/promises";
import { createResourceGovernor } from "../../../../packages/fleet-resources/src/governor.ts";
import { resolve, relative } from "node:path";
const scratch = resolve(process.env.ACTIVITY_FIXTURE_ROOT);
for (const name of [
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
]) {
  const path = process.env[name];
  if (!path || relative(scratch, resolve(path)).startsWith("..")) throw Error(`Unconfined ${name}`);
}
let sessionId = "fixture-original-session",
  now = Date.now(),
  activityExitCode,
  workerHookResult;
let children = [];
const hooks = new Map(),
  after = [],
  timers = [];
const timer = (queue, callback) => {
  const entry = { callback, cancelled: false };
  queue.push(entry);
  return { cancel: () => (entry.cancelled = true) };
};
const api = {
  plugin: { name: "clankie-worker", root: process.env.ACTIVITY_PLUGIN_ROOT },
  session: { id: async () => sessionId },
  env: { get: async (name) => process.env[name] },
  clock: {
    now: async () => now,
    after: (_, callback) => timer(after, callback),
    every: (_, callback) => timer(timers, callback),
  },
  agent: { list: async () => children },
  mcp: { connect: async () => ({ isConnected: true, server: "fixture" }) },
  tool: { list: async () => [] },
  ui: { status() {}, log() {} },
  process: {
    run: async (args, options) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args.slice(1), {
          env: process.env,
          stdio: ["pipe", "pipe", "pipe"],
          timeout: options.timeoutMs,
        });
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (data) => (stdout += data));
        child.stderr.on("data", (data) => (stderr += data));
        child.once("error", reject);
        child.once("close", (code) => {
          if (args.at(-1).endsWith("/activity.mjs")) activityExitCode = code;
          resolve({ exitCode: code ?? -1, stdout, stderr });
        });
        child.stdin.end(options.stdin);
      }),
  },
};
const emit = async (name, event = {}) => {
  for (const hook of hooks.get(name) ?? []) await hook(api, event, async () => ({}));
};
const mod = await import(process.env.ACTIVITY_MOD_PATH);
mod.register((name, matcher, hook) => {
  const entries = hooks.get(name) ?? [];
  entries.push(typeof matcher === "function" ? matcher : hook);
  hooks.set(name, entries);
});
const drain = async () => {
  for (const entry of after.splice(0)) if (!entry.cancelled) await entry.callback();
};
let chain = Promise.resolve();
let heavy, heavyGovernor, heavyReady, heavyRelease, heavyAbort;

process.on("message", (message) => {
  chain = chain.then(async () => {
    try {
      now = message.now ?? now;
      if (message.sessionId) sessionId = message.sessionId;
      if (message.children) children = message.children;
      if (message.heavy === "start") {
        heavyGovernor = createResourceGovernor({
          directory: message.directory,
          probe: async () => ({ loadRatio: 0, cpuRatio: 0, availableMemoryMb: 32768 }),
          simulatorBootSettleMs: 0,
          heavyJobSettleMs: 0,
        });
        heavyAbort = new AbortController();
        heavyRelease = message.release;
        let queued, ready;
        const started = new Promise((done) => (queued = done));
        heavyReady = new Promise((done) => (ready = done));
        heavy = heavyGovernor.runHeavy(
          process.execPath,
          [
            "-e",
            `process.stdout.write('ready'); const fs = require('node:fs'); const timer = setInterval(() => { if (fs.existsSync(process.argv[1])) { clearInterval(timer); process.exit(); } }, 20);`,
            heavyRelease,
          ],
          {
            seatId: "fixture-seat",
            holderId: message.holderId,
            signal: heavyAbort.signal,
            stdout: new Writable({
              write(_chunk, _encoding, callback) {
                ready();
                queued();
                callback();
              },
            }),
            onWait: () => queued(),
          },
        );
        // allow-swallowed-rejection -- the owned completion is joined during stop, including expected cancellation.
        heavy.catch(() => {});
        await started;
      }
      if (message.heavy === "ready") await heavyReady;
      if (message.heavy === "stop") {
        await writeFile(heavyRelease, "release");
        heavyAbort.abort();
        // allow-swallowed-rejection -- abort is the fixture teardown outcome, never a successful job claim.
        await heavy.catch(() => {});
        await heavyGovernor.close();
      }
      if (message.workerHook) {
        const result = await api.process.run(
          [process.execPath, resolve(process.env.ACTIVITY_PLUGIN_ROOT, "bin/seat-hook.mjs")],
          { stdin: JSON.stringify(message.workerHook), timeoutMs: 6000 },
        );
        workerHookResult = result;
        if (!message.allowHookFailure && (result.exitCode !== 0 || result.stderr)) throw Error(result.stderr);
      }
      if (message.hook) {
        const helper = new URL("../../../../integrations/claude-plugin/worker/bin/link.mjs", import.meta.url)
          .href;
        const code = `import { authorization, readLink, seatRoute } from ${JSON.stringify(helper)};
          let input = ""; for await (const chunk of process.stdin) input += chunk;
          const link = readLink(); const response = await fetch(seatRoute(link, process.env.HERDR_PANE_ID, "hook"), {
            method: "POST", headers: { ...authorization(link), "content-type": "application/json" }, body: input
          }); if (!response.ok) { process.stderr.write(await response.text()); process.exitCode = 1; }`;
        const result = await api.process.run([process.execPath, "-e", code], {
          stdin: JSON.stringify(message.hook),
          timeoutMs: 4500,
        });
        if (result.exitCode !== (message.hookExitCode ?? 0)) throw Error(result.stderr);
      }
      if (message.event) await emit(message.event, message.input);
      if (message.tick) for (const entry of timers) if (!entry.cancelled) await entry.callback();
      await drain();
      process.send({ id: message.id, ok: true, activityExitCode, workerHookResult });
    } catch (error) {
      process.send({ id: message.id, error: String(error) });
    }
  });
});
process.on("disconnect", () => process.exit());
process.send({ ready: true });
