import { execFile } from "node:child_process";
import { appendFile, chmod, glob, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { AgentHostConnectionSchema, type SettingsStore } from "@clankie/settings";
import {
  MachineAccessChangeSchema,
  machineAccessAllows,
  type MachineAccessLevel,
  type Machine,
  type MachineInventory,
} from "@clankie/protocol";
import { JoinedMachineIdSchema, type JoinedShellAuditEntry } from "@clankie/protocol/machine-join";
import { readMachineAccessRefusals, machineAccessLevel } from "./machine-access.ts";
import { verifiedLocalSandbox } from "@clankie/settings";
import { remoteProgramCommand } from "./herdr-fleet.ts";
import { parseHerdrAgentList } from "./captain/herdr-census.ts";

const exec = promisify(execFile);
const MACHINE_PROBE_MS = 3000;
/** Literal owner aliases only; wildcards and negative patterns are not destinations. */
export function sshConfigHosts(config: string): string[] {
  return [
    ...new Set(
      config.split(/\r?\n/u).flatMap((line) => {
        const match = /^\s*Host\s+([^#]+)/iu.exec(line);
        return match
          ? match[1]!
              .trim()
              .split(/\s+/u)
              .filter((host) => /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/u.test(host))
          : [];
      }),
    ),
  ].slice(0, 30);
}

/** Bounded Include expansion; like OpenSSH, relative includes start in ~/.ssh. */
export async function readSshConfig(path = join(homedir(), ".ssh", "config")): Promise<string> {
  const root = dirname(path);
  const seen = new Set<string>();
  const contents: string[] = [];
  async function read(file: string): Promise<void> {
    const absolute = resolve(file);
    if (seen.has(absolute) || seen.size >= 32) return;
    seen.add(absolute);
    try {
      if ((await stat(absolute)).size > 256 * 1024) return;
      const content = await readFile(absolute, "utf8");
      contents.push(content);
      for (const line of content.split(/\r?\n/u)) {
        const include = /^\s*Include\s+([^#]+)/iu.exec(line);
        if (!include) continue;
        for (const token of include[1]!.match(/"[^"]*"|'[^']*'|\S+/gu) ?? []) {
          const pattern = token.replace(/^["']|["']$/gu, "").replace(/^~\//u, `${homedir()}/`);
          for await (const entry of glob(pattern, { cwd: root })) {
            if (seen.size >= 32) return;
            await read(resolve(root, entry));
          }
        }
      }
    } catch {
      /* An unreadable include is not a reachable candidate. */
    }
  }
  await read(path);
  return contents.join("\n");
}

/** A machine on the owner's tailnet, as Tailscale itself reports it (ADR 0314). */
export interface TailnetPeer {
  /** The MagicDNS label Clankie reaches it at, e.g. `desktop` in `desktop.tail1234.ts.net`. */
  readonly host: string;
  readonly dnsName: string;
  readonly name: string;
  readonly platform?: "darwin" | "win32" | "linux";
  /** Host keys Tailscale SSH advertises for it; empty when the machine runs its own sshd. */
  readonly sshHostKeys: readonly string[];
}

const TAILNET_PEER_MAX = 16;
const HOST_KEY = /^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa) [A-Za-z0-9+/]+={0,3}$/u;

/** Online computers in `tailscale status --json`; phones and the Mac itself are left out. */
export function tailnetPeers(status: string): TailnetPeer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(status);
  } catch {
    return [];
  }
  const peers = (parsed as { Peer?: unknown } | null)?.Peer;
  if (peers === null || typeof peers !== "object") return [];
  const result: TailnetPeer[] = [];
  for (const raw of Object.values(peers as Record<string, unknown>)) {
    const peer = raw as {
      HostName?: unknown;
      DNSName?: unknown;
      OS?: unknown;
      Online?: unknown;
      sshHostKeys?: unknown;
    };
    if (peer.Online !== true || typeof peer.DNSName !== "string") continue;
    const dnsName = peer.DNSName.replace(/\.$/u, "").toLowerCase();
    const host = dnsName.split(".")[0] ?? "";
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(host)) continue;
    const os = typeof peer.OS === "string" ? peer.OS.toLowerCase() : "";
    const platform =
      os === "macos" ? "darwin" : os === "windows" ? "win32" : os === "linux" ? "linux" : undefined;
    if (platform === undefined) continue;
    const name =
      typeof peer.HostName === "string" && peer.HostName.trim().length > 0
        ? peer.HostName.trim().slice(0, 64)
        : host;
    const sshHostKeys = Array.isArray(peer.sshHostKeys)
      ? peer.sshHostKeys
          .filter((key): key is string => typeof key === "string" && HOST_KEY.test(key))
          .slice(0, 8)
      : [];
    result.push({ host, dnsName, name, platform, sshHostKeys });
    if (result.length >= TAILNET_PEER_MAX) break;
  }
  return result;
}

const TAILSCALE_BINARIES = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

/** This machine's view of its tailnet, or "" when Tailscale isn't installed or running. */
export async function readTailscaleStatus(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  for (const binary of TAILSCALE_BINARIES) {
    try {
      const { stdout } = await exec(binary, ["status", "--json"], {
        env,
        timeout: 1500,
        maxBuffer: 2 * 1024 * 1024,
      });
      return stdout;
    } catch {
      /* Try the next install location; none means no tailnet. */
    }
  }
  return "";
}

type Probe = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<{ stdout: string }>;
interface JoinedMachineProvider {
  readonly count: number;
  has(id: string): boolean;
  accessCeiling(id: string): MachineAccessLevel | undefined;
  inventory(): Promise<Machine[]>;
  remove(id: string): Promise<void>;
  shellAudit?(limit?: number): Promise<{ entries: JoinedShellAuditEntry[] }>;
}
export class Machines {
  private joined: JoinedMachineProvider | undefined;
  setJoinedProvider(provider: NonNullable<Machines["joined"]>) {
    this.joined = provider;
    this.invalidate();
  }
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private cached: { expires: number; inventory: Promise<MachineInventory> } | undefined;
  private readonly options: {
    settings: SettingsStore;
    primary: () => { session: string; socketPath: string } | undefined;
    changed: (id: string) => void | Promise<void>;
    run?: Probe;
    sshConfig?: () => Promise<string>;
    /** `tailscale status --json`; "" when there is no tailnet. */
    tailnet?: () => Promise<string>;
    /** The service user's known_hosts, which Tailscale's host keys join when a machine is added. */
    knownHostsPath?: string;
    env?: NodeJS.ProcessEnv;
  };
  /** Tailscale's host keys for the peers of the latest discovery, by MagicDNS label. */
  private tailnetKeys = new Map<string, readonly string[]>();
  constructor(options: Machines["options"]) {
    this.options = options;
  }

  private async probe(
    machine: Pick<Machine, "transport" | "ssh" | "shell">,
    args: readonly string[],
    socketPath?: string,
    knownHosts?: string,
  ) {
    if (this.active >= 4)
      await new Promise<void>((resolve, reject) => {
        const admit = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          const index = this.waiting.indexOf(admit);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(new Error("Discovery queue deadline"));
        }, MACHINE_PROBE_MS);
        this.waiting.push(admit);
      });
    else this.active += 1;
    const env = { ...(this.options.env ?? process.env) };
    for (const key of Object.keys(env)) if (key.startsWith("HERDR_")) delete env[key];
    if (machine.transport === "local" && socketPath) env.HERDR_SOCKET_PATH = socketPath;
    const command = machine.transport === "local" ? "herdr" : "ssh";
    const argv =
      machine.transport === "local"
        ? args
        : [
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            // Tailscale's own record of the machine's keys, beside the owner's.
            ...(knownHosts === undefined
              ? []
              : ["-o", `UserKnownHostsFile=${this.knownHostsPath()} ${knownHosts}`]),
            "-o",
            "ConnectTimeout=2",
            "-o",
            "ConnectionAttempts=1",
            "--",
            machine.ssh!,
            remoteProgramCommand(machine.shell ?? "posix", "herdr", args),
          ];
    // The independent deadline also bounds injected runners and protects the HTTP request.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (
          this.options.run ??
          ((cmd, values, childEnv) =>
            exec(cmd, [...values], { env: childEnv, timeout: MACHINE_PROBE_MS, maxBuffer: 1024 * 1024 }))
        )(command, argv, env),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Machine probe timed out")), MACHINE_PROBE_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }

  private knownHostsPath() {
    return this.options.knownHostsPath ?? join(homedir(), ".ssh", "known_hosts");
  }

  /**
   * A machine added from the tailnet is trusted with the host keys Tailscale
   * reports for it, so later fleet calls (which never accept a new key) reach it.
   * An owner entry already there for that name is left as it is.
   */
  private async trustTailnetKeys(ssh: string) {
    const host = ssh.slice(ssh.lastIndexOf("@") + 1);
    const keys = this.tailnetKeys.get(host);
    if (keys === undefined || keys.length === 0) return;
    const path = this.knownHostsPath();
    const existing = await readFile(path, "utf8").catch(() => "");
    const named = existing
      .split(/\r?\n/u)
      .some((line) => line.trim().split(/\s+/u)[0]?.split(",").includes(host) === true);
    if (named) return;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    await appendFile(path, prefix + keys.map((key) => `${host} ${key}\n`).join(""), { mode: 0o600 });
  }

  async add(raw: unknown) {
    const input = AgentHostConnectionSchema.parse(raw);
    if (JoinedMachineIdSchema.safeParse(input.id).success)
      throw new Error("Joined identities are reserved for approved registration");
    await this.options.settings.update((current) => {
      const existing = current.machines.find(
        (entry) => entry.id === input.id || entry.aliases.includes(input.id),
      );
      if (!existing && this.joined && current.machines.length + this.joined.count >= 63)
        throw new Error("Machine inventory capacity reached");
      if (existing && (existing.ssh !== input.ssh || existing.shell !== input.shell))
        throw new Error("Machine ID is pinned to another host; use a new ID");
      return {
        ...current,
        machineAccess: existing ? current.machineAccess : { ...current.machineAccess, [input.id]: "portal" },
        agentHosts: {
          connections: [...current.agentHosts.connections.filter((entry) => entry.id !== input.id), input],
        },
      };
    });
    await this.trustTailnetKeys(input.ssh);
    this.cached = undefined;
    await this.options.changed(input.id);
    return input;
  }

  async remove(id: string) {
    if (id === "local") throw new Error("The local machine cannot be removed");
    if (this.joined?.has(id)) {
      await this.joined.remove(id);
      await this.options.settings.update((current) => ({
        ...current,
        machineAccess: Object.fromEntries(
          Object.entries(current.machineAccess).filter(([key]) => key !== id),
        ),
      }));
      this.invalidate();
      await this.options.changed(id);
      return;
    }
    const removed: string[] = [];
    await this.options.settings.update((current) => {
      const reference = current.execution.connections.find((entry) => entry.id === id)?.machine;
      const named = current.machines.find((entry) => entry.id === id || entry.aliases.includes(id));
      if (named && reference && named.id !== reference)
        throw new Error(
          `Ambiguous machine name ${id}: it also names a connection on ${reference}; use an unambiguous machine alias`,
        );
      const machine = named ?? current.machines.find((entry) => entry.id === reference);
      if (!machine) throw new Error("Unknown machine");
      for (const connection of current.execution.connections)
        if (connection.machine === machine.id) removed.push(connection.id);
      return {
        ...current,
        machineAccess: Object.fromEntries(
          Object.entries(current.machineAccess).filter(
            ([id]) => id !== machine.id && !machine.aliases.includes(id),
          ),
        ),
        machines: current.machines.filter((entry) => entry !== machine),
        agentHosts: {
          connections: current.agentHosts.connections.filter(
            (entry) => entry.id !== machine.id && !machine.aliases.includes(entry.id),
          ),
        },
        execution: {
          ...current.execution,
          connections: current.execution.connections.filter((entry) => entry.machine !== machine.id),
        },
      };
    });
    this.cached = undefined;
    for (const connection of removed) await this.options.changed(connection);
    await this.options.changed(id);
  }

  invalidate() {
    this.cached = undefined;
  }

  async setAccess(id: string, raw: unknown) {
    const input = MachineAccessChangeSchema.parse(raw);
    let selected = id;
    const sandbox = verifiedLocalSandbox();
    if (id === "local" && sandbox && !machineAccessAllows(sandbox.accessLevel, input.accessLevel))
      throw new Error(
        "The OS sandbox ceiling requires owner removal and a new service launch to raise access",
      );
    await this.options.settings.update((current) => {
      const machine = current.machines.find((entry) => entry.id === id || entry.aliases.includes(id));
      if (id !== "local" && !machine && !this.joined?.has(id)) throw new Error("Unknown machine");
      selected = machine?.id ?? id;
      if (
        this.joined?.has(selected) &&
        !machineAccessAllows(this.joined.accessCeiling(selected) ?? "portal", input.accessLevel)
      )
        throw Error("Rejoin with owner approval to raise this machine's access ceiling");
      return { ...current, machineAccess: { ...current.machineAccess, [selected]: input.accessLevel } };
    });
    this.cached = undefined;
    await this.options.changed(selected);
    return {
      id: selected,
      ...input,
      accessEnforcement:
        selected === "local" && sandbox
          ? ("os-sandbox" as const)
          : this.joined?.has(selected)
            ? ("joined-host" as const)
            : ("service-preference" as const),
    };
  }

  /** Clankie's own shell calls on joined machines, newest last. */
  async shellAudit(limit?: number) {
    return (await this.joined?.shellAudit?.(limit)) ?? { entries: [] };
  }

  async accessRefusals() {
    return { refusals: await readMachineAccessRefusals(this.options.settings, this.joined) };
  }

  async list(refresh = false): Promise<MachineInventory> {
    if (!refresh && this.cached && this.cached.expires > Date.now()) return this.cached.inventory;
    const inventory = this.discover();
    this.cached = { expires: Date.now() + 15_000, inventory };
    return inventory;
  }

  private async discover(): Promise<MachineInventory> {
    const started = Date.now();
    const settings = await this.options.settings.load();
    const primary = this.options.primary();
    const configured: Machine[] = [
      {
        id: "local",
        transport: "local",
        configured: true,
        state: "discovering",
        workerCount: null,
        sessions: [],
      },
      ...settings.machines.map(
        ({ id, ssh, shell }): Machine => ({
          id,
          ssh,
          shell,
          transport: "ssh",
          configured: true,
          state: "discovering",
          workerCount: null,
          sessions: [],
        }),
      ),
    ];
    for (const machine of configured) {
      machine.accessLevel = machineAccessLevel(settings, machine.id);
      machine.accessEnforcement = "service-preference";
      const sandbox = machine.id === "local" ? verifiedLocalSandbox() : undefined;
      if (sandbox) {
        machine.accessEnforcement = "os-sandbox";
        machine.accessCeiling = sandbox.accessLevel;
        machine.approvedDirectories = [...sandbox.workspaces];
      }
    }
    let configTimer: ReturnType<typeof setTimeout> | undefined;
    const config = await Promise.race([
      (this.options.sshConfig?.() ?? readSshConfig()).catch(() => ""),
      new Promise<string>((resolve) => {
        configTimer = setTimeout(() => resolve(""), 500);
      }),
    ]);
    clearTimeout(configTimer);
    const candidates = sshConfigHosts(config).filter((ssh) => !configured.some((entry) => entry.ssh === ssh));
    for (const ssh of candidates) {
      let id = ssh
        .toLowerCase()
        .replace(/[^a-z0-9-]/gu, "-")
        .slice(0, 60);
      if (!/^[a-z]/u.test(id)) id = `ssh-${id}`;
      const base = id.slice(0, 48);
      for (let suffix = 1; configured.some((entry) => entry.id === id); suffix += 1) id = `${base}-${suffix}`;
      configured.push({
        id,
        ssh,
        shell: "posix",
        transport: "ssh",
        configured: false,
        accessLevel: "portal",
        accessEnforcement: "service-preference",
        state: "discovering",
        workerCount: null,
        sessions: [],
      });
    }
    let tailnetTimer: ReturnType<typeof setTimeout> | undefined;
    const status = await Promise.race([
      (this.options.tailnet?.() ?? readTailscaleStatus(this.options.env)).catch(() => ""),
      new Promise<string>((resolve) => {
        tailnetTimer = setTimeout(() => resolve(""), 2000);
      }),
    ]);
    clearTimeout(tailnetTimer);
    const reached = new Set(configured.map((entry) => entry.ssh?.slice(entry.ssh.lastIndexOf("@") + 1)));
    const knownHosts: string[] = [];
    const tailnetKeys = new Map<string, readonly string[]>();
    for (const peer of tailnetPeers(status)) {
      if (reached.has(peer.host) || reached.has(peer.dnsName)) continue;
      reached.add(peer.host);
      tailnetKeys.set(peer.host, peer.sshHostKeys);
      for (const key of peer.sshHostKeys) knownHosts.push(`${peer.host} ${key}`);
      let id = peer.host;
      if (!/^[a-z]/u.test(id)) id = `ts-${id}`;
      const base = id.slice(0, 48);
      for (let suffix = 1; configured.some((entry) => entry.id === id); suffix += 1) id = `${base}-${suffix}`;
      configured.push({
        id,
        name: peer.name,
        platform: peer.platform!,
        ssh: peer.host,
        shell: peer.platform === "win32" ? "powershell" : "posix",
        transport: "ssh",
        configured: false,
        accessLevel: "portal",
        accessEnforcement: "service-preference",
        state: "discovering",
        workerCount: null,
        sessions: [],
      });
    }
    this.tailnetKeys = tailnetKeys;
    // Probes read Tailscale's keys from a private file that lives only for this discovery.
    const keyDirectory =
      knownHosts.length === 0
        ? undefined
        : await mkdtemp(join(tmpdir(), "clankie-tailnet-")).catch(() => undefined);
    const keyFile = keyDirectory === undefined ? undefined : join(keyDirectory, "known_hosts");
    if (keyFile !== undefined) {
      await writeFile(keyFile, `${knownHosts.join("\n")}\n`, { mode: 0o600 });
      await chmod(keyFile, 0o600);
    }
    const pending = Promise.all(
      configured.map(async (machine) => {
        const connections = settings.execution.connections.filter((entry) => entry.machine === machine.id);
        const pinned = connections.map((entry) => ({
          name: entry.session,
          connectionId: entry.id,
          ...(entry.socketPath ? { socketPath: entry.socketPath } : {}),
          state: entry.enabled ? ("unreachable" as const) : ("disabled" as const),
          workerCount: null,
        }));
        if (machine.id === "local" && primary)
          pinned.unshift({
            name: primary.session,
            connectionId: "default",
            socketPath: primary.socketPath,
            state: "unreachable",
            workerCount: null,
          });
        machine.sessions = pinned;
        try {
          const tailnetFile =
            machine.ssh !== undefined && tailnetKeys.get(machine.ssh)?.length ? keyFile : undefined;
          const { stdout } = await this.probe(machine, ["session", "list", "--json"], undefined, tailnetFile);
          const parsed = JSON.parse(stdout) as { sessions?: Array<{ name?: string; socket_path?: string }> };
          if (!Array.isArray(parsed.sessions)) throw new Error("Invalid session inventory");
          machine.state = "available";
          for (const row of parsed.sessions.slice(0, 64)) {
            if (!row.name || !/^[\w][\w.-]{0,63}$/u.test(row.name)) continue;
            const existing = machine.sessions.find(
              (entry) =>
                entry.name === row.name &&
                (machine.transport !== "local" ||
                  entry.socketPath === undefined ||
                  entry.socketPath === row.socket_path),
            );
            if (existing) {
              if (existing.state !== "disabled") existing.state = "connected";
            } else
              machine.sessions.push({
                name: row.name,
                ...(machine.transport === "local" && row.socket_path ? { socketPath: row.socket_path } : {}),
                state: "available",
                workerCount: null,
              });
          }
          machine.sessions = machine.sessions.slice(0, 64);
          await Promise.all(
            machine.sessions.map(async (session) => {
              try {
                const result = await this.probe(
                  machine,
                  machine.transport === "local" && session.socketPath
                    ? ["agent", "list"]
                    : ["--session", session.name, "agent", "list"],
                  session.socketPath,
                  tailnetFile,
                );
                session.workerCount = parseHerdrAgentList(result.stdout).length;
                if (session.state !== "disabled")
                  session.state = session.connectionId ? "connected" : "available";
              } catch {
                if (session.state !== "disabled") session.state = "unreachable";
              }
            }),
          );
          machine.workerCount = machine.sessions.some((entry) => entry.workerCount === null)
            ? null
            : machine.sessions.reduce((sum, entry) => sum + (entry.workerCount ?? 0), 0);
        } catch (error) {
          machine.state = String(error).includes("queue deadline") ? "discovering" : "unreachable";
        }
      }),
    );
    let deadline: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      pending,
      new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, Math.max(0, 6500 - (Date.now() - started)));
      }),
    ]);
    clearTimeout(deadline);
    // Probes still running past the deadline lose their key file and fail closed.
    if (keyDirectory !== undefined) await rm(keyDirectory, { recursive: true, force: true }).catch(() => {});
    return {
      observedAt: new Date().toISOString(),
      machines: [
        ...structuredClone(configured.filter((machine) => machine.configured)),
        ...((await this.joined?.inventory()) ?? []),
        ...structuredClone(configured.filter((machine) => !machine.configured)),
      ].slice(0, 64),
    };
  }
}
