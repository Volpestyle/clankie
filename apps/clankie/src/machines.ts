import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AgentHostConnectionSchema, type SettingsStore } from "@clankie/settings";
import type { Machine, MachineInventory } from "@clankie/protocol";
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

type Probe = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<{ stdout: string }>;
export class Machines {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private cached: { expires: number; inventory: Promise<MachineInventory> } | undefined;
  private readonly options: {
    settings: SettingsStore;
    primary: () => { session: string; socketPath: string } | undefined;
    changed: (id: string) => void | Promise<void>;
    run?: Probe;
    sshConfig?: () => Promise<string>;
    env?: NodeJS.ProcessEnv;
  };
  constructor(options: Machines["options"]) {
    this.options = options;
  }

  private async probe(machine: Pick<Machine, "transport" | "ssh" | "shell">, args: readonly string[]) {
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

  async add(raw: unknown) {
    const input = AgentHostConnectionSchema.parse(raw);
    await this.options.settings.update((current) => {
      const existing = current.machines.find(
        (entry) => entry.id === input.id || entry.aliases.includes(input.id),
      );
      if (existing && (existing.ssh !== input.ssh || existing.shell !== input.shell))
        throw new Error("Machine ID is pinned to another host; use a new ID");
      return {
        ...current,
        agentHosts: {
          connections: [...current.agentHosts.connections.filter((entry) => entry.id !== input.id), input],
        },
      };
    });
    this.cached = undefined;
    await this.options.changed(input.id);
    return input;
  }

  async remove(id: string) {
    if (id === "local") throw new Error("The local machine cannot be removed");
    const removed: string[] = [];
    await this.options.settings.update((current) => {
      const reference = current.execution.connections.find((entry) => entry.id === id)?.machine;
      const machine = current.machines.find(
        (entry) => entry.id === id || entry.aliases.includes(id) || entry.id === reference,
      );
      if (!machine) throw new Error("Unknown machine");
      for (const connection of current.execution.connections)
        if (connection.machine === machine.id) removed.push(connection.id);
      return {
        ...current,
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

  async list(refresh = false): Promise<MachineInventory> {
    if (!refresh && this.cached && this.cached.expires > Date.now()) return this.cached.inventory;
    const inventory = this.discover();
    this.cached = { expires: Date.now() + 15_000, inventory };
    return inventory;
  }

  private async discover(): Promise<MachineInventory> {
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
    const config = await (
      this.options.sshConfig?.() ?? readFile(join(homedir(), ".ssh", "config"), "utf8")
    ).catch(() => "");
    const candidates = sshConfigHosts(config).filter((ssh) => !configured.some((entry) => entry.ssh === ssh));
    for (const [index, ssh] of candidates.entries()) {
      let id = ssh
        .toLowerCase()
        .replace(/[^a-z0-9-]/gu, "-")
        .slice(0, 60);
      if (!/^[a-z]/u.test(id)) id = `ssh-${id}`;
      if (configured.some((entry) => entry.id === id)) id = `candidate-${index}`;
      configured.push({
        id,
        ssh,
        shell: "posix",
        transport: "ssh",
        configured: false,
        state: "discovering",
        workerCount: null,
        sessions: [],
      });
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
          const { stdout } = await this.probe(machine, ["session", "list", "--json"]);
          const parsed = JSON.parse(stdout) as { sessions?: Array<{ name?: string; socket_path?: string }> };
          if (!Array.isArray(parsed.sessions)) throw new Error("Invalid session inventory");
          machine.state = "available";
          for (const row of parsed.sessions.slice(0, 64)) {
            if (!row.name || !/^[\w][\w.-]{0,63}$/u.test(row.name)) continue;
            const existing = machine.sessions.find((entry) => entry.name === row.name);
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
                const result = await this.probe(machine, ["--session", session.name, "agent", "list"]);
                session.workerCount = parseHerdrAgentList(result.stdout).length;
                if (session.state !== "disabled")
                  session.state = session.connectionId ? "connected" : "available";
              } catch {
                session.state = "unreachable";
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
        deadline = setTimeout(resolve, 6500);
      }),
    ]);
    clearTimeout(deadline);
    return { observedAt: new Date().toISOString(), machines: structuredClone(configured) };
  }
}
