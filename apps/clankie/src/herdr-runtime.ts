import { execFile, fork, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { delimiter, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
type RuntimeState = "starting" | "healthy" | "recovering" | "stopped";

/** Where his own Herdr lives, whether or not the current binding uses it. */
export function bundledHerdrBinary(repoRoot: string): string {
  const installed = join(repoRoot, "libexec/herdr");
  if (existsSync(installed) || existsSync(join(repoRoot, "release.json"))) return installed;
  return join(repoRoot, ".data/herdr/bin/herdr");
}

/**
 * A bound session that stops is unbound rather than waited on (ADR 0170).
 * Connect-only: the owner's server answers on its own socket, and a busy one
 * must never read as a dead one, so `onLost` fires only after the socket has
 * refused three checks in a row.
 */
export function watchHerdrSocket(input: { socketPath: string; onLost: () => void; intervalMs?: number }): {
  close: () => void;
} {
  let misses = 0;
  const timer = setInterval(() => {
    void socketListening(input.socketPath).then((listening) => {
      if (listening) {
        misses = 0;
        return;
      }
      if (++misses < 3) return;
      clearInterval(timer);
      input.onLost();
    });
  }, input.intervalMs ?? 10_000);
  timer.unref();
  return { close: () => clearInterval(timer) };
}

/** Env a running harness stamps on its children; none of it belongs to a fresh seat. */
export function isHarnessSessionMarker(name: string): boolean {
  return name === "CLAUDECODE" || name === "CLAUDE_PID" || name.startsWith("CLAUDE_CODE_");
}

/** A child supervisor loses its IPC channel even if Clankie is killed with SIGKILL. */
export async function startHerdrRuntime(input: {
  binary: string;
  repoRoot: string;
  stateRoot: string;
  env: NodeJS.ProcessEnv;
}) {
  if (!existsSync(input.binary))
    throw new Error("Bundled Herdr is missing; run pnpm herdr:build or reinstall Clankie");
  const root = resolve(input.stateRoot, "herdr");
  const socketPath = join(root, "herdr.sock");
  if (Buffer.byteLength(`${root}/herdr-client.sock`) > 103) {
    throw new Error("CLANKIE_STATE is too long for Herdr's Unix sockets; use a shorter state directory");
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  // The fleet outlives the service (ADR 0164): a live server from a previous
  // run that still answers is adopted rather than refused, so restarting
  // Clankie does not close the panes its agents are working in.
  const listening = await socketListening(socketPath);
  const adopt =
    listening &&
    (await runtimeAnswers(input.binary, {
      ...input.env,
      XDG_CONFIG_HOME: root,
      XDG_STATE_HOME: root,
      XDG_RUNTIME_DIR: root,
      HERDR_SOCKET_PATH: socketPath,
    }));
  if (listening && !adopt) throw new Error(`Herdr runtime already has an owner: ${socketPath}`);
  await mkdir(join(root, "herdr"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(root, "herdr/config.toml"),
    "onboarding = false\n[update]\nversion_check = false\nmanifest_check = false\n",
    { mode: 0o600, flag: "wx" },
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  for (const name of Object.keys(input.env)) {
    if (name.startsWith("HERDR_")) delete input.env[name];
    // A harness session marker inherited from whoever restarted the service
    // would make every hire believe it is that session's child (Claude Code
    // then stops saving transcripts). The owned runtime starts clean.
    if (isHarnessSessionMarker(name)) delete input.env[name];
  }
  input.env.HERDR_SOCKET_PATH = socketPath;
  delete input.env.HERD_LEAD_SUMMARIES_CACHE;
  input.env.HERDR_PLUGIN_STATE_DIR = join(root, "herdr/plugins/herd-lead");
  input.env.PATH = `${dirname(input.binary)}${delimiter}${input.env.PATH ?? ""}`;
  // Herdr hands this environment to every pane it opens, and the XDG override
  // below is its own isolation, not the owner's. This pointer is what keeps a
  // pane inside the fleet resolving Clankie's real state home (ADR 0164).
  input.env.CLANKIE_STATE_HOME ??=
    input.env.XDG_STATE_HOME?.trim() || join(input.env.HOME?.trim() || homedir(), ".local", "state");
  const compiled = join(input.repoRoot, "apps/clankie/src/herdr-runtime.js");
  const child = fork(
    existsSync(compiled) ? compiled : compiled.replace(/\.js$/u, ".ts"),
    ["--supervise-herdr", input.binary, ...(adopt ? ["--adopt"] : [])],
    {
      execArgv: [],
      env: { ...input.env, XDG_CONFIG_HOME: root, XDG_STATE_HOME: root, XDG_RUNTIME_DIR: root },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    },
  );
  let state: RuntimeState = "starting";
  const exited = new Promise<void>((done) =>
    child.once("exit", () => {
      state = "stopped";
      done();
    }),
  );
  const ready = new Promise<void>((done, reject) => {
    child.once("error", reject);
    child.once("exit", () => reject(new Error("Herdr supervisor exited; inspect the Clankie service log")));
    child.on("message", (message: unknown) => {
      if (message === "healthy" || message === "recovering") {
        state = message;
        if (message === "healthy") done();
      }
    });
  });
  async function close(): Promise<void> {
    if (child.connected) child.disconnect();
    await exited;
  }
  try {
    await ready;
  } catch (error) {
    await close();
    throw error;
  }
  return { status: () => state, close };
}

/** Whether a server already on the socket answers, which is what makes it adoptable. */
async function runtimeAnswers(binary: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    const { stdout } = await exec(binary, ["api", "snapshot"], {
      env,
      timeout: 5_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const snapshot = JSON.parse(stdout) as { result?: unknown; error?: unknown };
    return snapshot.error === undefined && snapshot.result !== undefined;
  } catch {
    return false;
  }
}

async function socketListening(path: string): Promise<boolean> {
  return await new Promise((done) => {
    const socket = createConnection(path);
    const finish = (listening: boolean) => {
      socket.destroy();
      done(listening);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    // A busy listener must never be mistaken for permission to start another owner.
    socket.setTimeout(1_000, () => finish(true));
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    await exited;
  } finally {
    clearTimeout(force);
  }
}

async function supervise(binary: string, adopt: boolean): Promise<void> {
  let closing = false;
  // Clankie going away is not the fleet going away (ADR 0164): losing the IPC
  // channel, including to a SIGKILL, leaves the server running for the next
  // service to adopt. Only a signal aimed at the supervisor itself stops it.
  let detaching = false;
  let child: ChildProcess | undefined;
  const shutdown = () => {
    closing = true;
    void (child === undefined ? Promise.resolve() : stop(child));
  };
  process.once("disconnect", () => {
    detaching = true;
  });
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  let backoff = 250;
  let booted = false;
  let adopting = adopt;
  while (!closing && !detaching) {
    let exited = false;
    const started = Date.now();
    // The server gets its own process group so the launcher's group-wide stop
    // of Clankie cannot reap the fleet, and its own log file is its stderr.
    child = adopting
      ? undefined
      : spawn(binary, ["server"], { stdio: ["ignore", "ignore", "ignore"], detached: true });
    child?.unref();
    adopting = false;
    child?.once("exit", () => {
      exited = true;
    });
    child?.once("error", (error) => {
      exited = true;
      process.stderr.write(`herdr: ${error.message}\n`);
    });
    let healthy = false;
    let failures = 0;
    while (!closing && !detaching && !exited) {
      try {
        const { stdout } = await exec(binary, ["api", "snapshot"], {
          timeout: 2_000,
          maxBuffer: 8 * 1024 * 1024,
        });
        const snapshot = JSON.parse(stdout) as { result?: unknown; error?: unknown };
        if (snapshot.error !== undefined || snapshot.result === undefined)
          throw new Error("Invalid Herdr snapshot");
        healthy = true;
        booted = true;
        failures = 0;
        if (process.connected) process.send?.("healthy");
      } catch {
        failures++;
        if ((healthy && failures >= 3) || (!healthy && Date.now() - started > 30_000)) break;
      }
      // Short sleeps let shutdown interrupt backoff and health polling promptly.
      const until = Date.now() + (healthy ? 5_000 : 100);
      while (!closing && !detaching && !exited && Date.now() < until) await sleep(100);
    }
    // Detaching leaves the server exactly as it is; only a real stop reaps it.
    if (detaching) break;
    if (child !== undefined) await stop(child);
    if (closing) break;
    if (!booted) throw new Error("Herdr did not become ready within 30 seconds");
    if (process.connected) process.send?.("recovering");
    process.stderr.write("herdr: runtime unavailable; restarting\n");
    if (Date.now() - started > 30_000) backoff = 250;
    const until = Date.now() + backoff;
    while (!closing && !detaching && Date.now() < until) await sleep(100);
    backoff = Math.min(backoff * 2, 30_000);
  }
}

if (process.argv[2] === "--supervise-herdr") {
  const binary = process.argv[3];
  if (binary === undefined || process.send === undefined)
    throw new Error("Herdr supervisor requires its Clankie parent");
  try {
    await supervise(binary, process.argv.includes("--adopt"));
  } finally {
    if (process.connected) process.disconnect();
  }
}
