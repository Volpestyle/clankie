/** Opt-in live verification of Prime Agent workers (VUH-1556); never part of pnpm check. */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { SeatControl, SeatEvent } from "@clankie/agent-hosts";
import { createPrimeNativeHost } from "../src/captain/prime-native-host.ts";
import { createPrimeSeatAdapter } from "../src/captain/prime-seat-adapter.ts";
import { connectPrimeDaemon, discoverPrimeAgent, primeSessionState } from "../src/captain/prime-daemon.ts";

const output = resolve(process.argv[2] ?? "prime-seat-evidence.json");
const model = process.argv[3] ?? "anthropic/claude-haiku-4-5";
const repoRoot = resolve(import.meta.dirname, "../../..");
const execute = promisify(execFile);
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const root = await realpath(await mkdtemp("/tmp/prime-seat-"));
const work = join(root, "work");
await mkdir(work);
const session = `prime-verify-${randomUUID().slice(0, 8)}`;
const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), root, model };
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("HERDR_")) delete env[key];
const herdr = spawn("herdr", ["--session", session, "server"], { env, cwd: root, stdio: "ignore" });
const request = (socketPath: string, method: string, params: unknown) =>
  new Promise<unknown>((done, fail) => {
    const socket = createConnection(socketPath);
    let text = "";
    const timer = setTimeout(() => {
      socket.destroy();
      fail(new Error(`herdr ${method} timeout`));
    }, 10_000);
    socket.on("error", fail);
    socket.on("connect", () => socket.write(`${JSON.stringify({ id: randomUUID(), method, params })}\n`));
    socket.on("data", (chunk) => {
      text += chunk;
      if (!text.includes("\n")) return;
      clearTimeout(timer);
      socket.destroy();
      const reply = JSON.parse(text.split("\n")[0]!);
      if (reply.error) fail(new Error(JSON.stringify(reply.error)));
      else done(reply);
    });
  });
let control: SeatControl | undefined;
let activeSessionId: string | undefined;
try {
  let socketPath: string | undefined;
  for (let attempt = 0; attempt < 100 && !socketPath; attempt++) {
    const rows = JSON.parse((await execute("herdr", ["session", "list", "--json"], { env })).stdout).sessions;
    socketPath = rows.find((row: { name: string; running: boolean }) => row.name === session && row.running)
      ?.socket_path;
    if (!socketPath) await pause(100);
  }
  assert.ok(socketPath, "Owned Herdr server unavailable");
  const herdrEnv = { ...env, HERDR_SOCKET_PATH: socketPath };
  await execute("herdr", ["workspace", "create", "--cwd", work, "--label", "prime-verify", "--no-focus"], {
    env: herdrEnv,
  });
  const binding = async () => ({ runtime: "external" as const, session, socketPath: socketPath! });
  const native = createPrimeNativeHost({
    binding,
    processHelper: join(repoRoot, "integrations/opencode-plugin/process-birth.py"),
    request: (current, method, params) => request(current.socketPath, method, params),
  });
  const adapter = createPrimeSeatAdapter({ repoRoot, stateDir: join(root, "state"), native });
  const prepared = await adapter.prepare!({
    harness: "prime",
    cwd: work,
    brief: "Reply with exactly the word READY and nothing else.",
    model,
    effort: "low",
  });
  activeSessionId = prepared.command.at(-1);
  evidence.command = prepared.command;
  const paneId = await native.createCommandTab({
    cwd: work,
    label: "prime-verify",
    command: prepared.command,
    env: prepared.env ?? {},
  });
  const started = await prepared.start({
    paneId,
    name: "prime-verify",
    run: async () => {
      throw new Error("No terminal input");
    },
  });
  assert.equal(started.outcome, "started", JSON.stringify(started));
  control = started.control;
  evidence.ref = control.ref;
  const brief = await control.settled(AbortSignal.timeout(120_000));
  evidence.brief = brief;
  assert.equal(brief.type, "turn_completed");
  assert.match((brief as Extract<SeatEvent, { type: "turn_completed" }>).text ?? "", /READY/u);
  const pane = await request(socketPath, "pane.get", { pane_id: paneId });
  evidence.paneAfterBrief = pane;

  // Owner draft: typed into the visible composer, never submitted.
  await execute("herdr", ["pane", "send-text", paneId, "OWNER DRAFT KEEP"], { env: herdrEnv });
  await pause(500);
  const idle = await control.send("Reply with exactly IDLE-OK.");
  evidence.idleSend = idle;
  assert.equal(idle.outcome, "accepted");
  const idleDone = await control.settled(AbortSignal.timeout(120_000), idle.outcome === "accepted" ? idle.messageId : undefined);
  evidence.idleDone = idleDone;
  assert.match((idleDone as { text?: string }).text ?? "", /IDLE-OK/u);
  const visible = (await execute("herdr", ["pane", "read", paneId, "--source", "visible"], { env: herdrEnv })).stdout;
  evidence.draftPreserved = visible.includes("OWNER DRAFT KEEP");
  evidence.visibleAfterIdle = visible.slice(-3000);

  // Busy: a long turn, then a queued follow-up and a steer.
  const long = await control.send(
    "In your Python REPL run `import time; time.sleep(12)` and then reply with exactly LONG-DONE.",
  );
  evidence.longSend = long;
  for (let index = 0; index < 100 && (await control.status()) !== "working"; index++) await pause(100);
  const queued = await control.send("After that, reply with exactly QUEUED-OK.", { delivery: "queue" });
  evidence.queuedSend = queued;
  assert.equal(queued.outcome, "accepted");
  assert.equal(queued.outcome === "accepted" && queued.state, "queued");
  const queuedDone = await control.settled(
    AbortSignal.timeout(180_000),
    queued.outcome === "accepted" ? queued.messageId : undefined,
  );
  evidence.queuedDone = queuedDone;
  assert.match((queuedDone as { text?: string }).text ?? "", /QUEUED-OK/u);
  const longDone = await control.settled(
    AbortSignal.timeout(60_000),
    long.outcome === "accepted" ? long.messageId : undefined,
  );
  evidence.longDone = longDone;
  assert.equal(longDone.type, "turn_completed");

  // Interrupt an owned running turn.
  const interruptible = await control.send("In your Python REPL run `import time; time.sleep(60)` then say SLEPT.");
  evidence.interruptibleSend = interruptible;
  for (let index = 0; index < 100 && (await control.status()) !== "working"; index++) await pause(100);
  await pause(2000);
  evidence.interrupted = await control.interrupt();
  const afterInterrupt = await control.settled(
    AbortSignal.timeout(60_000),
    interruptible.outcome === "accepted" ? interruptible.messageId : undefined,
  );
  evidence.afterInterrupt = afterInterrupt;
  assert.equal(evidence.interrupted, true);
  assert.equal(afterInterrupt.type === "turn_completed" && afterInterrupt.ok, false);

  // Fleet MCP admission predicate against the real worker process.
  const daemon = await connectPrimeDaemon(await discoverPrimeAgent());
  const summary = await primeSessionState(daemon, activeSessionId!);
  evidence.workerPid = summary.workerPid;
  evidence.allowsWorkerChain = await native.allows([summary.workerPid!, 1], control.ref.paneId, await binding());
  evidence.refusesOtherChain = !(await native.allows([process.pid, 1], control.ref.paneId, await binding()));
  evidence.refusesOtherPane = !(await native.allows([summary.workerPid!, 1], "w9:p9", await binding()));

  await control.close();
  control = undefined;
  evidence.residentAfterClose = (await primeSessionState(daemon, activeSessionId!)).lifecycle;
  assert.equal(evidence.draftPreserved, true);
  assert.equal(evidence.allowsWorkerChain, true);
  assert.equal(evidence.refusesOtherChain, true);
  assert.equal(evidence.refusesOtherPane, true);
  daemon.close();
  evidence.ok = true;
} catch (error) {
  evidence.ok = false;
  evidence.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
} finally {
  await control?.close().catch(() => {});
  if (activeSessionId) {
    const daemon = await connectPrimeDaemon(await discoverPrimeAgent()).catch(() => undefined);
    await daemon?.request({ type: "kill", activeSessionId }).catch(() => {});
    daemon?.close();
  }
  herdr.kill("SIGTERM");
  evidence.finishedAt = new Date().toISOString();
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ ok: evidence.ok, output }));
  process.exit(evidence.ok ? 0 : 1);
}
