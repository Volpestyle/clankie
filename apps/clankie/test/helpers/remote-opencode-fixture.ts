import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { execFile, type ChildProcess, type spawn } from "node:child_process";
import { promisify } from "node:util";
import { inflateRawSync } from "node:zlib";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { remoteProgramCommand, type HerdrFleet } from "../../src/herdr-fleet.ts";
import { remoteCheckoutProgram } from "../../src/captain/checkout-freshness.ts";
import { RemoteOpenCodeWorkers } from "../../src/captain/remote-opencode-workers.ts";
import { createRemoteOpenCodeHelper } from "../../src/captain/remote-opencode-helper.ts";
import { remoteHireReceiptCommand, type RemoteHireClaim } from "../../src/remote-hire-receipts.ts";
import { REMOTE_HIRE_RECEIPT_PROGRAM } from "../../src/remote-hire-receipt-program.ts";

/** SSH/remote OS inputs only; RPC framing, socket API, reader and controller remain real. */
export async function remoteOpenCodeFixture(options: {
  root: string;
  state: string;
  executable: string;
  nativeRequest(binding: unknown, method: string, params: unknown): Promise<unknown>;
}) {
  const fleet: HerdrFleet = {
    id: "fixture-mac",
    session: "fixture",
    ssh: { host: "fixture@mac", shell: "posix" },
  };
  let fleets: readonly HerdrFleet[] = [fleet];
  let birth = "123456";
  let socketOwner = process.pid;
  let uid = process.getuid!();
  let retargetDuringProbe = false;
  let nextDiscover: (() => Promise<void>) | undefined;
  const sshPid = 987654;
  const sockets = new Set<Socket>();
  const servers: Server[] = [];
  const children: ChildProcess[] = [];
  const kinds = new Map<ChildProcess, "helper" | "forward">();
  const closed = new Set<ChildProcess>();
  const operations: string[] = [];
  const commands: string[] = [];
  const root = await realpath(options.root);
  const remoteState = join(root, "remote-state");
  await mkdir(remoteState, { mode: 0o700 });
  const receiptHome = join(remoteState, "receipt-home");
  await mkdir(receiptHome, { mode: 0o700 });
  const execute = promisify(execFile);
  // Darwin UNIX socket addresses are bounded to 104 bytes; TMPDIR can be longer.
  const socketRoot = await mkdtemp("/private/tmp/vuh1555-ssh-");
  const socketPath = join(socketRoot, "herdr.sock");
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let input = "";
    socket.on("data", (bytes: Buffer) => {
      input += bytes.toString();
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const frame = JSON.parse(input.slice(0, newline));
      void options
        .nativeRequest(undefined, frame.method, frame.params)
        .then((value) => socket.end(JSON.stringify({ ...(value as object), id: frame.id }) + "\n"))
        .catch(() => socket.end(JSON.stringify({ id: frame.id, error: { code: "fixture_refused" } }) + "\n"));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  servers.push(server);
  // OS input only: lsof's inspected p/n shape, grounded in these held real
  // fixture sockets. Both ends live in this process. Avoid a wall-clock OS
  // scan racing the fixture/controller deadline, or caching a vanished socket.
  const sample = async (port: number) => {
    const rows = new Set<string>();
    for (const socket of sockets) {
      if (
        socket.destroyed ||
        !socket.remotePort ||
        !socket.localPort ||
        (socket.localPort !== port && socket.remotePort !== port)
      )
        continue;
      rows.add(`n127.0.0.1:${socket.localPort}->127.0.0.1:${socket.remotePort}`);
      rows.add(`n127.0.0.1:${socket.remotePort}->127.0.0.1:${socket.localPort}`);
    }
    return "p" + process.pid + "\n" + [...rows].join("\n") + "\n";
  };
  const assetsRoot = fileURLToPath(new URL("../../../../integrations/opencode-plugin", import.meta.url));
  const stream = (_command: string) => {
    commands.push(_command);
    const handle = createRemoteOpenCodeHelper({
      assetsRoot,
      probeVersion: async () => "1.18.18",
      run: async (file, args) => {
        if (file === "herdr")
          return JSON.stringify({ sessions: [{ name: fleet.session, socket_path: socketPath }] });
        if (file === "/usr/bin/which") {
          const callback = nextDiscover;
          nextDiscover = undefined;
          await callback?.();
          return options.executable + "\n";
        }
        if (file === "/usr/bin/python3") {
          if (retargetDuringProbe) {
            retargetDuringProbe = false;
            fleets = [{ ...fleet, ssh: { ...fleet.ssh, host: "fixture@other" } }];
          }
          return JSON.stringify({
            pid: process.pid,
            uid,
            birth: ["1700000000", birth],
            executable: options.executable,
            cwd: root,
          });
        }
        if (file === "/usr/sbin/lsof" && args.includes("cwd")) return "p" + process.pid + "\nn" + root + "\n";
        if (file === "/usr/sbin/lsof") {
          const port = Number(args.find((arg) => arg.startsWith("-iTCP:"))!.slice(6));
          return (await sample(port)).replaceAll("p" + process.pid + "\n", "p" + socketOwner + "\n");
        }
        throw new Error("Unexpected remote observation fixture");
      },
    });
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    let retired = false;
    let pending = Promise.resolve();
    const stdin = new Writable({
      write(chunk, _encoding, done) {
        const frame = JSON.parse(chunk.toString());
        operations.push(frame.method);
        pending = pending.then(async () => {
          try {
            const result = await handle(frame.method, frame.input);
            if (!retired) stdout.write(JSON.stringify({ id: frame.id, result }) + "\n");
          } catch {
            if (!retired)
              stdout.write(
                JSON.stringify({ id: frame.id, error: "Remote fixture operation refused" }) + "\n",
              );
          }
        });
        done();
      },
    });
    Object.assign(child, {
      pid: sshPid + children.length + 1,
      stdin,
      stdout,
      stderr: new PassThrough(),
      kill() {
        if (!retired) {
          retired = true;
          closed.add(child);
          stdin.destroy();
          stdout.destroy();
          child.emit("exit", 0);
        }
        return true;
      },
    });
    children.push(child);
    kinds.set(child, "helper");
    return child;
  };
  const forward = (_file: string, args: readonly string[]) => {
    commands.push(args.join(" "));
    const localPort = Number(args[args.indexOf("-R") + 1]!.split(":").at(-1));
    const child = new EventEmitter() as ChildProcess;
    const stderr = new PassThrough();
    let retired = false;
    const forwarded = new Set<Socket>();
    const proxy = createServer((client) => {
      const upstream = createConnection({ host: "127.0.0.1", port: localPort });
      sockets.add(client);
      sockets.add(upstream);
      forwarded.add(client);
      forwarded.add(upstream);
      client.pipe(upstream).pipe(client);
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      client.once("close", () => {
        sockets.delete(client);
        forwarded.delete(client);
        upstream.destroy();
      });
      upstream.once("close", () => {
        sockets.delete(upstream);
        forwarded.delete(upstream);
        client.destroy();
      });
    });
    servers.push(proxy);
    proxy.listen(0, "127.0.0.1", () => {
      const address = proxy.address();
      if (address && typeof address !== "string")
        stderr.write("Allocated port " + address.port + " for remote forward\n");
    });
    Object.assign(child, {
      pid: sshPid,
      stderr,
      kill() {
        if (!retired) {
          retired = true;
          closed.add(child);
          proxy.close();
          for (const socket of forwarded) socket.destroy();
          child.emit("exit", 0);
        }
        return true;
      },
    });
    children.push(child);
    kinds.set(child, "forward");
    return child;
  };
  const shell = async (command: string) => {
    commands.push(command);
    if (command.includes("remote-opencode-workers"))
      return JSON.stringify({ root: assetsRoot, node: process.execPath, stateDir: remoteState });
    // Checkout admission runs the exact remote program against the real fixture
    // directory. This workspace is intentionally non-Git; preserve that actual
    // observation rather than manufacturing a fresh checkout receipt.
    if (
      command.replaceAll(/clankie-launch-[a-f0-9]{16}/gu, "clankie-launch-fixture") ===
      remoteProgramCommand(fleet.ssh.shell, "node", ["-e", remoteCheckoutProgram(root)]).replaceAll(
        /clankie-launch-[a-f0-9]{16}/gu,
        "clankie-launch-fixture",
      )
    ) {
      const { stdout } = await execute("/bin/sh", ["-c", command], {
        cwd: root,
        env: { ...process.env, HOME: receiptHome },
        timeout: 30_000,
      });
      return stdout;
    }
    // Admit only the canonical service-authored reservation/launch program.
    // Its real filesystem locks, original claim and launch fence run in this
    // fixture's private host HOME, never the owner's ~/.clankie receipts.
    const compressed = command.match(/[A-Za-z0-9+/]{128,}={0,2}/u)?.[0];
    if (!compressed) throw new Error("Unexpected SSH fixture command");
    const script = inflateRawSync(Buffer.from(compressed, "base64")).toString();
    const prefix = `Promise.resolve().then(()=>(${REMOTE_HIRE_RECEIPT_PROGRAM})(`;
    if (!script.startsWith(prefix)) throw new Error("Unexpected SSH fixture command");
    const request = JSON.parse(
      script.slice(prefix.length, script.indexOf(")).then(value=>", prefix.length)),
    ) as {
      op: "reserve" | "launch";
      claim: RemoteHireClaim;
    };
    if (
      !["reserve", "launch"].includes(request.op) ||
      command.replaceAll(/clankie-launch-[a-f0-9]{16}/gu, "clankie-launch-fixture") !==
        remoteHireReceiptCommand(request.claim, request.op).replaceAll(
          /clankie-launch-[a-f0-9]{16}/gu,
          "clankie-launch-fixture",
        )
    )
      throw new Error("Unexpected SSH fixture command");
    const { stdout } = await execute("/bin/sh", ["-c", command], {
      cwd: root,
      env: { ...process.env, HOME: receiptHome },
      timeout: 30_000,
    });
    return stdout;
  };
  const workers = new RemoteOpenCodeWorkers({
    repoRoot: fileURLToPath(new URL("../../../../", import.meta.url)),
    stateDir: options.state,
    fleets: async () => fleets,
    shell: () => shell,
    stream: () => stream,
    spawn: forward as unknown as typeof spawn,
    timeoutMs: 4000,
    localRun: async (_file, args) => {
      const port = Number(args.find((arg) => arg.startsWith("-iTCP:"))!.slice(6));
      return (await sample(port)).replaceAll("p" + process.pid + "\n", "p" + sshPid + "\n");
    },
  });
  return {
    fleet,
    workers,
    commands,
    shell,
    stream,
    operations,
    onNextDiscover(callback: () => Promise<void>) {
      nextDiscover = callback;
    },
    transportState: () =>
      children.map((child, id) => ({ id, kind: kinds.get(child)!, closed: closed.has(child) })),
    fleets: async () => fleets,
    mutate(mode: string) {
      if (mode === "birth") birth = "123457";
      if (mode === "socket-owner") socketOwner++;
      if (mode === "uid") uid++;
      if (mode === "disconnect") fleets = [];
      if (mode === "reconnect") fleets = [fleet];
      if (mode === "retarget") fleets = [{ ...fleet, ssh: { ...fleet.ssh, host: "fixture@other" } }];
      if (mode === "during-probe") retargetDuringProbe = true;
      if (mode === "windows") fleets = [{ ...fleet, ssh: { ...fleet.ssh, shell: "powershell" } }];
      if (mode === "link-loss") children.find((child) => child.pid === sshPid)!.emit("exit", 255);
    },
    async close() {
      for (const child of children) child.kill();
      for (const socket of sockets) socket.destroy();
      for (const item of servers)
        if (item.listening) await new Promise<void>((resolve) => item.close(() => resolve()));
      await rm(socketRoot, { recursive: true, force: true });
    },
  };
}
