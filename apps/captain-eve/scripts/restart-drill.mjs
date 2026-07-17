import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Client } from "eve/client";

const appRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(appRoot, "../..");
const artifactArgument = process.argv[2] === "--" ? process.argv[3] : process.argv[2];
const artifactPath = resolve(artifactArgument ?? join(appRoot, ".eve", "restart-drill.json"));
const eveVersion = JSON.parse(
  await readFile(join(appRoot, "node_modules", "eve", "package.json"), "utf8"),
).version;
const stateRoot = await mkdtemp(join(tmpdir(), "captain-restart-drill-"));
const runtimeRoot = join(stateRoot, "captain-runtime");
const keepState = process.env.CAPTAIN_RESTART_DRILL_KEEP_STATE === "1";
const state = { captain: undefined };

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function withTimeout(promise, label, timeoutMs = 60_000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("failed to allocate port");
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return address.port;
}

function childExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

async function killGroup(child, signal) {
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  return withTimeout(childExit(child), `captain exit after ${signal}`, 15_000);
}

async function buildCaptain() {
  const child = spawn("pnpm", ["exec", "eve", "build"], {
    cwd: appRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      CAPTAIN_TEST_MODEL: "openai/restart-drill",
      CAPTAIN_TEST_MODEL_DELAY_MS: "10000",
    },
    stdio: "inherit",
  });
  const exit = await withTimeout(childExit(child), "captain test build");
  if (exit.code !== 0) throw new Error("captain test build failed");
}

async function startCaptain(port) {
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTail = "";
  let stderrTail = "";
  const child = spawn(
    process.execPath,
    [
      join(appRoot, "node_modules", "eve", "bin", "eve.js"),
      "start",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: runtimeRoot,
      detached: true,
      env: {
        ...process.env,
        XDG_STATE_HOME: stateRoot,
        NODE_ENV: "test",
        CAPTAIN_TEST_MODEL: "openai/restart-drill",
        CAPTAIN_TEST_MODEL_DELAY_MS: "10000",
        // Production's 860-second inline ownership lease prevents a crashed
        // invocation from being stolen too early. One second exercises the
        // same expiry/takeover path without making this drill wait 14 minutes.
        WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => {
    stdoutBytes += chunk.length;
    stdoutTail = `${stdoutTail}${chunk.toString("utf8")}`.slice(-65_536);
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-65_536);
  });
  const client = new Client({ host: `http://127.0.0.1:${port}`, preserveCompletedSessions: true });
  await withTimeout(
    (async () => {
      for (;;) {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error("captain exited before health became ready");
        }
        try {
          await client.health();
          return;
        } catch {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
        }
      }
    })(),
    "captain health",
  );
  return {
    child,
    client,
    logBytes: () => ({ stdout: stdoutBytes, stderr: stderrBytes }),
    logTails: () => ({ stdout: stdoutTail, stderr: stderrTail }),
  };
}

async function readLedger(sessionId) {
  const source = [
    'import { captainSessionLedger } from "./lib/session/runtime.ts";',
    "async function main() {",
    "const ledger = await captainSessionLedger();",
    `const snapshot = await ledger.snapshot(${JSON.stringify(sessionId)});`,
    "const verification = await ledger.verify();",
    "console.log(JSON.stringify({ snapshot, verification }));",
    "ledger.close();",
    "}",
    "main().catch((error) => { console.error(error); process.exitCode = 1; });",
  ].join(" ");
  const child = spawn(join(repoRoot, "node_modules", ".bin", "tsx"), ["--eval", source], {
    cwd: appRoot,
    env: {
      ...process.env,
      XDG_STATE_HOME: stateRoot,
      NODE_ENV: "test",
      CAPTAIN_TEST_MODEL: "openai/restart-drill",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const exit = await withTimeout(childExit(child), "ledger read", 15_000);
  if (exit.code !== 0) throw new Error(`ledger read failed (${stderr.length} stderr bytes)`);
  return JSON.parse(stdout.trim());
}

try {
  await mkdir(runtimeRoot, { recursive: true });
  await Promise.all([
    symlink(join(appRoot, ".output"), join(runtimeRoot, ".output")),
    symlink(join(appRoot, "node_modules"), join(runtimeRoot, "node_modules")),
    symlink(join(appRoot, "package.json"), join(runtimeRoot, "package.json")),
  ]);
  await buildCaptain();
  const captainPort = await freePort();
  const first = await startCaptain(captainPort);
  state.captain = first.child;
  const session = first.client.session();
  const preKillStartIndex = session.state.streamIndex;
  const response = await session.send("restart-drill-sentinel");
  const preKillEvents = [];
  let resolveStepStarted;
  let rejectStepStarted;
  const stepStarted = new Promise((resolveStep, rejectStep) => {
    resolveStepStarted = resolveStep;
    rejectStepStarted = rejectStep;
  });
  const consumeBeforeKill = (async () => {
    try {
      for await (const event of response) {
        preKillEvents.push(event);
        if (event.type === "step.started") resolveStepStarted?.();
        if (event.type === "session.failed") {
          rejectStepStarted?.(new Error(`session failed before kill: ${JSON.stringify(first.logTails())}`));
        }
      }
    } catch (error) {
      rejectStepStarted?.(error);
    }
  })();
  await withTimeout(stepStarted, "mid-session delayed model step");
  const killAt = new Date().toISOString();
  const firstExit = await killGroup(first.child, "SIGKILL");
  await withTimeout(consumeBeforeKill, "pre-kill stream shutdown", 10_000);
  state.captain = undefined;
  const boundaryTypes = new Set([
    "session.waiting",
    "session.completed",
    "session.failed",
    "turn.completed",
    "turn.failed",
  ]);
  const preKillBoundary = preKillEvents.find((event) => boundaryTypes.has(event.type));
  if (preKillBoundary !== undefined) throw new Error(`boundary ${preKillBoundary.type} preceded SIGKILL`);

  const second = await startCaptain(captainPort);
  state.captain = second.child;
  const replaySession = second.client.session({ sessionId: response.sessionId, streamIndex: 0 });
  const replayEvents = [];
  let continuationToken;
  await withTimeout(
    (async () => {
      for await (const event of replaySession.stream({ startIndex: 0 })) {
        replayEvents.push(event);
        if (event.type === "session.waiting") {
          continuationToken = event.data.continuationToken;
          return;
        }
        if (event.type === "session.failed") {
          throw new Error(`session failed after restart: ${JSON.stringify(second.logTails())}`);
        }
      }
    })(),
    "restarted session boundary",
  );
  if (typeof continuationToken !== "string" || continuationToken.length === 0) {
    throw new Error("restart did not produce a continuation token");
  }

  const resumed = second.client.session({
    sessionId: response.sessionId,
    continuationToken,
    streamIndex: replayEvents.length,
  });
  const followup = await resumed.send("Reply with followup-restart-drill-sentinel.");
  const followupResult = await withTimeout(followup.result(), "follow-up turn");
  const secondExit = await killGroup(second.child, "SIGTERM");
  state.captain = undefined;

  const replayedPrefix = replayEvents.slice(preKillStartIndex, preKillStartIndex + preKillEvents.length);
  const prefixExact = JSON.stringify(replayedPrefix) === JSON.stringify(preKillEvents);
  const firstReceived = replayEvents.find((event) => event.type === "message.received");
  const firstCompleted = replayEvents.find((event) => event.type === "message.completed");
  const ledger = await readLedger(response.sessionId);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    build: { eveVersion, model: "deterministic delayed mock" },
    process: {
      isolatedState: true,
      firstExit,
      secondExit,
      killAt,
      killedAfter: "step.started during deterministic 10s model delay",
      recoveryLeaseSeconds: 1,
      preKillBoundaryObserved: false,
      firstServerLogBytes: first.logBytes(),
      secondServerLogBytes: second.logBytes(),
    },
    replay: {
      sessionIdSha256: sha256(response.sessionId),
      preKillStartIndex,
      preKillEventTypes: preKillEvents.map((event) => event.type),
      replayEventTypes: replayEvents.map((event) => event.type),
      prefixExact,
      prefixLength: preKillEvents.length,
      firstMessageSha256:
        firstReceived?.type === "message.received" ? sha256(firstReceived.data.message) : null,
      firstResponseSha256:
        firstCompleted?.type === "message.completed" ? sha256(firstCompleted.data.message ?? "") : null,
      resumedBoundary: replayEvents.at(-1)?.type ?? null,
      continuationTokenPresent: true,
    },
    followup: {
      accepted: followupResult.status === "waiting",
      status: followupResult.status,
      eventTypes: followupResult.events.map((event) => event.type),
      responseSha256: sha256(followupResult.message ?? ""),
    },
    accounting: {
      snapshot: ledger.snapshot,
      chainVerification: ledger.verification,
    },
    privacy: {
      continuationTokenPersisted: false,
      rawPromptPersistedInArtifact: false,
      rawResponsePersistedInArtifact: false,
      rawSessionStateRemoved: !keepState,
    },
  };
  if (firstExit.signal !== "SIGKILL") throw new Error("first captain did not exit from SIGKILL");
  if (!preKillEvents.some((event) => event.type === "step.started")) {
    throw new Error("captain was not killed during an active model step");
  }
  if (!prefixExact) throw new Error("replayed durable prefix differs from the pre-kill prefix");
  if (followupResult.status !== "waiting") throw new Error("follow-up did not resume the session");
  if (secondExit.code !== 0) throw new Error("restarted captain did not stop cleanly");
  if (ledger.snapshot?.state !== "waiting") throw new Error("accounting did not reach waiting");
  if ((ledger.snapshot?.usage.input ?? 0) <= 0 || (ledger.snapshot?.usage.output ?? 0) <= 0) {
    throw new Error("accounting did not retain nonzero model usage");
  }
  if (ledger.verification.valid !== true) throw new Error("accounting hash chain is invalid");
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await chmod(artifactPath, 0o600);
  process.stdout.write(`${artifactPath}\n`);
} finally {
  if (state.captain !== undefined) await killGroup(state.captain, "SIGKILL").catch(() => undefined);
  if (!keepState) await rm(stateRoot, { recursive: true, force: true });
}
