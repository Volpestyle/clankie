/** Exact-container ownership. No command runs merely by importing this module. */
import { assertNativeRuntimeCapability } from "./lead-native-capability.mjs";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";

import { dirname, resolve } from "node:path";

const transports = new WeakMap();
const ID = /^[a-f0-9]{64}$/;
const DIGEST = /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/;
export const RUN_LABEL = "bot.clankie.lead-eval.run";
export const ROLE_LABEL = "bot.clankie.lead-eval.role";

export function dockerTransport({ socketPath, configDirectory }) {
  // An explicit local daemon and isolated CLI configuration avoid ambient contexts,
  // credential helpers and remote Docker destinations selected by the owner shell.
  const socket = lstatSync(socketPath);
  if (!socket.isSocket() || socket.isSymbolicLink() || realpathSync(socketPath) !== socketPath)
    throw Error("Explicit canonical local Docker socket required");
  ownedDirectory(configDirectory);
  const prefix = ["--host", `unix://${socketPath}`, "--config", configDirectory];
  const command = (args, options) => dockerCommand([...prefix, ...args], options);
  command.spawn = (args, options = {}) =>
    spawn("docker", [...prefix, ...args], {
      env: { PATH: process.env.PATH },
      stdio: options.interactive ? "inherit" : ["pipe", "pipe", "pipe"],
    });
  transports.set(command, { socketPath, configDirectory, dev: socket.dev, ino: socket.ino });
  return command;
}

export function dockerTransportIdentity(command) {
  const record = transports.get(command);
  if (!record) throw Error("Controller-created local Docker transport required");
  const socket = lstatSync(record.socketPath);
  ownedDirectory(record.configDirectory);
  if (
    !socket.isSocket() ||
    socket.isSymbolicLink() ||
    socket.dev !== record.dev ||
    socket.ino !== record.ino ||
    realpathSync(record.socketPath) !== record.socketPath
  )
    throw Error("Owned Docker endpoint changed");
  return { ...record };
}

function ownedDirectory(root) {
  if (root !== resolve(root) || /[,\n\r]/u.test(root)) throw Error("Canonical owned directory required");
  for (let current = root; ; current = dirname(current)) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error("Symlink directory ancestry refused");
    if (current === root && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))
      throw Error("Owned directory must be private to the controller");
    if (dirname(current) === current) break;
  }
  return realpathSync(root);
}

async function dockerCommand(args, options = {}) {
  return new Promise((resolve, reject) => {
    const { input, ...execution } = options;
    const child = execFile(
      "docker",
      args,
      {
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
        env: { PATH: process.env.PATH, HOME: "/nonexistent" },
        ...execution,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** A controller only gains authority over the ID returned by its own create. */
export class LeadContainer {
  #id;
  #imageId;
  #stopped = false;
  constructor({ image, root, role = "native", command, verifierLogs, capability }) {
    if (!DIGEST.test(image) && !/^sha256:[a-f0-9]{64}$/.test(image))
      throw Error("A digest-pinned image is required");
    if (!["native", "verifier", "probe"].includes(role)) throw Error("Unknown containment role");
    if (typeof command !== "function") throw Error("Explicit Docker transport required");
    this.capability = capability;
    this.root = ownedDirectory(root);
    if (!process.getuid() || !process.getgid()) throw Error("Non-root controller identity required");
    this.user = `${process.getuid()}:${process.getgid()}`;
    this.image = image;
    this.role = role;
    this.network = role === "native" ? "bridge" : "none";
    this.mounts = [{ source: this.root, target: verifierLogs ? "/app" : "/eval", writable: !verifierLogs }];
    if (verifierLogs) {
      if (role !== "verifier") throw Error("Only verifier containers accept log mounts");
      this.mounts.push({ source: ownedDirectory(verifierLogs), target: "/logs/verifier", writable: true });
    }
    this.runId = randomUUID();
    this.command = command;
  }
  get id() {
    return this.#id;
  }
  get stopped() {
    return this.#stopped;
  }
  async create(argv, { memoryMb = 8192, cpus = 2 } = {}) {
    if (this.role === "native") await assertNativeRuntimeCapability(this.capability, this);
    ownedDirectory(this.root);
    if (this.#id || this.#stopped || !Array.isArray(argv) || !argv.length)
      throw Error("Container can be created once with an explicit entrypoint");
    if (!Number.isSafeInteger(memoryMb) || memoryMb < 256 || memoryMb > 32768 || !(cpus >= 1 && cpus <= 8))
      throw Error("Invalid container resource limit");
    const inspected = JSON.parse(await this.command(["image", "inspect", this.image]));
    if (
      inspected.length !== 1 ||
      !/^sha256:[a-f0-9]{64}$/.test(inspected[0].Id) ||
      inspected[0].Os !== "linux" ||
      !(inspected[0].Id === this.image || inspected[0].RepoDigests?.includes(this.image))
    )
      throw Error("Pinned Linux runtime image is not installed/verified; no implicit pull");
    this.#imageId = inspected[0].Id;
    const id = await this.command([
      "create",
      "--pull=never",
      "--init",
      "--read-only",
      `--network=${this.network}`,
      `--user=${this.user}`,
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=512",
      `--memory=${memoryMb}m`,
      `--cpus=${cpus}`,
      "--stop-timeout=1",
      "--label",
      `${RUN_LABEL}=${this.runId}`,
      "--label",
      `${ROLE_LABEL}=${this.role}`,
      ...this.mounts.flatMap((mount) => [
        "--mount",
        `type=bind,src=${mount.source},dst=${mount.target}${mount.writable ? "" : ",readonly"}`,
      ]),
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=256m",
      `--workdir=${this.mounts[0].target}`,
      "--entrypoint",
      argv[0],
      this.image,
      ...argv.slice(1),
    ]);
    if (!ID.test(id)) throw Error("Ambiguous Docker create result; never retry creation automatically");
    this.#id = id;
    await this.inspect();
    return id;
  }
  async inspect() {
    if (!this.#id) throw Error("No controller-created container");
    for (const mount of this.mounts) ownedDirectory(mount.source);
    const rows = JSON.parse(await this.command(["inspect", this.#id]));
    const info = rows[0];
    if (
      rows.length !== 1 ||
      info.Id !== this.#id ||
      info.Image !== this.#imageId ||
      info.Config?.User !== this.user ||
      info.Config?.Labels?.[RUN_LABEL] !== this.runId ||
      info.Config?.Labels?.[ROLE_LABEL] !== this.role ||
      info.HostConfig?.Privileged !== false ||
      info.HostConfig?.ReadonlyRootfs !== true ||
      info.HostConfig?.NetworkMode !== this.network ||
      info.HostConfig?.PidMode ||
      info.HostConfig?.CapDrop?.includes("ALL") !== true ||
      info.HostConfig?.SecurityOpt?.includes("no-new-privileges") !== true ||
      info.Mounts?.length !== this.mounts.length ||
      this.mounts.some(
        (mount) =>
          !info.Mounts.some(
            (actual) =>
              actual.Type === "bind" &&
              actual.Source === mount.source &&
              actual.Destination === mount.target &&
              actual.RW === mount.writable,
          ),
      )
    )
      throw Error("Exact container identity/isolation changed; refusing control");
    return info;
  }
  async start() {
    if (this.role === "native") await assertNativeRuntimeCapability(this.capability, this);
    if (this.#stopped) throw Error("Stopped containers never resume");
    await this.inspect();
    await this.command(["start", this.#id]);
  }
  async exec(argv, { input, detached = false, cwd, timeoutMs, signal } = {}) {
    if (this.role === "native") await assertNativeRuntimeCapability(this.capability, this);
    if (this.#stopped) throw Error("Stopped containers never dispatch");
    const info = await this.inspect();
    if (info.State?.Running !== true) throw Error("Owned container is not running");
    return this.command(
      [
        "exec",
        ...(detached ? ["--detach"] : []),
        ...(cwd ? ["--workdir", cwd] : []),
        ...(input === undefined ? [] : ["-i"]),
        this.#id,
        ...argv,
      ],
      {
        input,
        ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
        ...(signal === undefined ? {} : { signal }),
      },
    );
  }
  async attach(argv) {
    if (this.role === "native") await assertNativeRuntimeCapability(this.capability, this);
    if (this.role !== "native" || this.#stopped || !process.stdin.isTTY || !process.stdout.isTTY)
      throw Error("Native owner attachment requires the owner's interactive terminal");
    const info = await this.inspect();
    if (!info.State?.Running || !this.command.spawn) throw Error("Native attachment transport unavailable");
    return this.command.spawn(["exec", "-it", this.#id, ...argv], { interactive: true });
  }
  async pipe(argv) {
    if (this.role === "native") await assertNativeRuntimeCapability(this.capability, this);
    if (this.#stopped || typeof this.command.spawn !== "function")
      throw Error("Owned streaming transport unavailable");
    const info = await this.inspect();
    if (info.State?.Running !== true) throw Error("Owned container is not running");
    return this.command.spawn(["exec", "-i", this.#id, ...argv]);
  }
  /** SIGKILL of the exact namespace boundary also stops detached/setsid descendants. */
  async stop(reason) {
    if (!reason) throw Error("Stop requires a retained reason");
    this.#stopped = true;
    const info = await this.inspect();
    if (info.State?.Running) await this.command(["kill", "--signal=KILL", this.#id]);
    const after = await this.inspect();
    if (after.State?.Running) throw Error("Container stop unconfirmed");
    return { containerId: this.#id, stopped: true, reason };
  }
  /** Owner executes this manually; the controller never attaches or types. */
  attachCommand() {
    if (!this.#id || this.role !== "native") throw Error("No native container");
    return [
      "docker",
      "exec",
      "-it",
      "--env",
      "HERDR_SOCKET_PATH=/eval/control/herdr.sock",
      this.#id,
      "herdr",
      "client",
    ];
  }
}
