import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const clientPath = fileURLToPath(new URL("./socket-client.mjs", import.meta.url));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export interface Reply {
  status: number;
  elapsedMs: number;
  port: number;
  coOwnerPid?: number;
  effects: number;
  error?: string;
}
interface Pending {
  resolve(value: Reply): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Owns only a fresh Herdr namespace and its ordinary process/socket clients. */
export async function isolatedHerdr(logDirectory: string) {
  // macOS Unix sockets have a 104-byte path limit; do not use the long worktree.
  const root = await mkdtemp("/tmp/clankie-proof-");
  const socketPath = join(root, "herdr.sock");
  const controlPath = join(root, "control.sock");
  await mkdir(logDirectory, { recursive: true });
  await mkdir(join(root, "config"), { recursive: true });
  const configPath = join(root, "config", "config.toml");
  await writeFile(
    configPath,
    'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\n[update]\nversion_check = false\nmanifest_check = false\n',
  );
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("HERDR_")) delete env[key];
  delete env.ENV;
  delete env.BASH_ENV;
  Object.assign(env, {
    HERDR_SOCKET_PATH: socketPath,
    HERDR_CONFIG_PATH: configPath,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
    SHELL: "/bin/sh",
  });
  await mkdir(env.XDG_RUNTIME_DIR!, { recursive: true });
  const children: ChildProcess[] = [];
  const controlSockets = new Set<Socket>();
  const clients = new Map<string, { socket: Socket; pid: number }>();
  const pending = new Map<number, Pending>();
  const control = createServer((socket) => {
    controlSockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => controlSockets.delete(socket));
    createInterface({ input: socket }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.ready) clients.set(message.ready, { socket, pid: message.pid });
      else {
        const call = pending.get(message.id);
        if (!call) return;
        clearTimeout(call.timer);
        pending.delete(message.id);
        if (message.transportError) call.reject(new Error(message.transportError));
        else call.resolve(message);
      }
    });
  });
  const log = createWriteStream(join(logDirectory, "herdr.log"));
  let daemon: ChildProcess | undefined;
  const cli = async (...args: string[]) => {
    const result = await exec("herdr", args, { env, timeout: 5_000, maxBuffer: 1_000_000 });
    return result.stdout.trim() ? JSON.parse(result.stdout) : undefined;
  };
  const close = async () => {
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error("Fixture closed"));
    }
    pending.clear();
    for (const socket of controlSockets) socket.destroy();
    if (control.listening) await new Promise<void>((resolve) => control.close(() => resolve()));
    if (daemon?.pid && daemon.exitCode === null && daemon.signalCode === null) {
      await cli("server", "stop").catch(() => {});
    }
    for (const child of children) {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await Promise.race([exited, delay(2_000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    }
    await new Promise<void>((resolve) => log.end(resolve));
    await rm(root, { recursive: true, force: true });
  };
  try {
    await new Promise<void>((resolve, reject) => {
      control.once("error", reject);
      control.listen(controlPath, resolve);
    });
    daemon = spawn("herdr", ["server"], { env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(daemon);
    daemon.stdout!.pipe(log, { end: false });
    daemon.stderr!.pipe(log, { end: false });
    let spawnError: Error | undefined;
    daemon.once("error", (error) => {
      spawnError = error;
    });
    const deadline = Date.now() + 10_000;
    for (;;) {
      if (spawnError) throw spawnError;
      if (daemon.exitCode !== null)
        throw new Error(`Owned Herdr exited ${daemon.exitCode}; see ${logDirectory}`);
      try {
        await cli("workspace", "list");
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await delay(30);
      }
    }
    const created = await cli("workspace", "create", "--cwd", root, "--no-focus");
    const pane = created.result.root_pane.pane_id as string;
    const other = await cli("pane", "split", pane, "--direction", "right", "--cwd", root, "--no-focus");
    const foreignPane = other.result.pane.pane_id as string;
    const shellPid = (await cli("pane", "process-info", "--pane", pane)).result.process_info
      .shell_pid as number;
    if (!Number.isSafeInteger(shellPid) || shellPid <= 1) throw new Error("Missing real pane shell");
    const startClient = async (name: string, endpoint: string, inPane: boolean) => {
      const args = [clientPath, controlPath, name, endpoint, pane];
      if (inPane) await cli("pane", "run", pane, [process.execPath, ...args].map(quote).join(" "));
      else {
        const child = spawn(process.execPath, args, { env, stdio: "ignore" });
        children.push(child);
      }
      const until = Date.now() + 5_000;
      while (!clients.has(name)) {
        if (Date.now() >= until) throw new Error(`Client ${name} did not connect; see ${logDirectory}`);
        await delay(20);
      }
      return clients.get(name)!.pid;
    };
    let id = 0;
    return {
      root,
      pane,
      foreignPane,
      shellPid,
      socketPath,
      cli,
      startClient,
      close,
      request(name: string, selectedPane = pane, action?: "share" | "release"): Promise<Reply> {
        const client = clients.get(name);
        if (!client) return Promise.reject(new Error(`Unknown client ${name}`));
        const requestId = ++id;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(requestId);
            reject(new Error(`Client ${name} request timed out`));
          }, 6_000);
          pending.set(requestId, { resolve, reject, timer });
          client.socket.write(JSON.stringify({ id: requestId, pane: selectedPane, action }) + "\n");
        });
      },
      async startFdChurn() {
        const binary = join(root, "fd-churn");
        const source = fileURLToPath(new URL("./fd-churn.c", import.meta.url));
        await exec("cc", ["-O2", "-Wall", "-Wextra", "-Werror", "-pthread", source, "-o", binary], {
          timeout: 10_000,
        });
        const child = spawn(binary, [], { env, stdio: ["pipe", "pipe", "pipe"] });
        children.push(child);
        const exited = once(child, "exit");
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("FD churn did not become ready")), 2_000);
          child.stdout.once("data", (chunk) => {
            clearTimeout(timer);
            if (String(chunk).trim() === "ready") resolve();
            else reject(new Error("Unexpected FD churn readiness"));
          });
          child.once("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(`FD churn exited before ready: ${code} ${stderr}`));
          });
          child.once("error", reject);
        });
        return {
          pid: child.pid!,
          stop: async () => {
            child.stdin.end();
            const [code] = await exited;
            if (code !== 0) throw new Error(`FD churn failed: ${code} ${stderr}`);
          },
        };
      },
      async startCpuLoad() {
        const startedAt = new Date().toISOString();
        const loads = [0, 1].map(() => {
          const child = spawn(process.execPath, [fileURLToPath(new URL("./cpu-load.mjs", import.meta.url))], {
            env,
            stdio: ["ignore", "pipe", "pipe"],
          });
          children.push(child);
          const events: unknown[] = [];
          let ready!: () => void;
          const readiness = new Promise<void>((resolve) => {
            ready = resolve;
          });
          createInterface({ input: child.stdout }).on("line", (line) => {
            const event = JSON.parse(line);
            events.push(event);
            if (event.stage === "ready") ready();
          });
          const completion = once(child, "exit").then(([code]) => {
            if (code !== 0) throw new Error(`CPU load process failed: ${code}`);
            return { pid: child.pid, events };
          });
          return { readiness, completion };
        });
        await Promise.all(loads.map(({ readiness, completion }) => Promise.race([readiness, completion])));
        return {
          done: async () => {
            const processes = await Promise.all(loads.map(({ completion }) => completion));
            await writeFile(
              join(logDirectory, "cpu-load.json"),
              JSON.stringify({ startedAt, processes }, null, 2) + "\n",
            );
          },
        };
      },
      async waitForExit(pid: number) {
        const until = Date.now() + 2_000;
        for (;;) {
          try {
            process.kill(pid, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH")
              return { pid, errno: "ESRCH" as const, checkedAt: new Date().toISOString() };
            throw error;
          }
          if (Date.now() >= until) throw new Error(`Owned process ${pid} did not exit`);
          await delay(10);
        }
      },
      async quitClient(name: string) {
        const client = clients.get(name);
        if (!client || client.socket.destroyed) return;
        const closed = once(client.socket, "close");
        client.socket.write(JSON.stringify({ quit: true }) + "\n");
        const timer = setTimeout(() => client.socket.destroy(), 2_000);
        try {
          await closed;
        } finally {
          clearTimeout(timer);
        }
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
