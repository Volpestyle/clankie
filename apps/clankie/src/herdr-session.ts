import { z } from "zod";
import { realpath, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, win32 } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import {
  ExecutionWorkspacesSchema,
  ExecutionConnectionSchema,
  ExecutionWorkerModeSchema,
  type ExecutionWorkerMode,
  type SettingsStore,
  type HerdrSettings,
} from "@clankie/settings";
import type { HerdrBinding } from "@clankie/protocol";
import { startHerdrRuntime, watchHerdrSocket } from "./herdr-runtime.ts";
import { createHerdrFleetRun, type HerdrFleet, type HerdrFleetRun } from "./herdr-fleet.ts";

const exec = promisify(execFile);
type HerdrSessionRunner = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<{ stdout: string }>;

interface HerdrSessionRow {
  readonly name: string;
  readonly socketPath: string;
}

/** A path Herdr can actually listen on; anything else is not a candidate. */
function usableSocket(value: string | undefined): string | undefined {
  const path = value?.trim();
  return path !== undefined && path !== "" && isAbsolute(path) && Buffer.byteLength(path) <= 102
    ? path
    : undefined;
}

/** A name the settings schema and the binding contract both accept. */
function usableSession(value: string | undefined): string | undefined {
  const name = value?.trim();
  return name !== undefined && /^[\w][\w.-]{0,63}$/u.test(name) ? name : undefined;
}

function parseHerdrSessions(stdout: string): readonly HerdrSessionRow[] {
  const parsed = JSON.parse(stdout) as { sessions?: unknown };
  const rows = Array.isArray(parsed.sessions) ? parsed.sessions : [];
  return rows.flatMap((value) => {
    if (value === null || typeof value !== "object") return [];
    const entry = value as Record<string, unknown>;
    const name = typeof entry.name === "string" ? usableSession(entry.name) : undefined;
    const socketPath = typeof entry.socket_path === "string" ? usableSocket(entry.socket_path) : undefined;
    return name === undefined || socketPath === undefined ? [] : [{ name, socketPath }];
  });
}

/** Saved sessions, or none: a missing CLI is one more candidate that cannot answer. */
async function listSessions(
  run: HerdrSessionRunner,
  env: NodeJS.ProcessEnv,
): Promise<readonly HerdrSessionRow[]> {
  try {
    return parseHerdrSessions((await run("herdr", ["session", "list", "--json"], env)).stdout);
  } catch {
    return [];
  }
}

/** One Herdr for every child Clankie spawns, whatever identity the launch env carried. */
export function pinHerdrEnvironment(env: NodeJS.ProcessEnv, socketPath?: string): NodeJS.ProcessEnv {
  for (const name of Object.keys(env)) if (name.startsWith("HERDR_")) delete env[name];
  if (socketPath !== undefined) env.HERDR_SOCKET_PATH = socketPath;
  delete env.HERD_LEAD_SUMMARIES_CACHE;
  return env;
}

/**
 * Whether a server answers on this socket. CLI commands never start one, so a
 * saved session that is down reads as down instead of quietly becoming a fleet.
 */
async function answers(
  socketPath: string,
  env: NodeJS.ProcessEnv,
  run: HerdrSessionRunner,
): Promise<boolean> {
  try {
    const { stdout } = await run("herdr", ["api", "snapshot"], pinHerdrEnvironment({ ...env }, socketPath));
    return Boolean((JSON.parse(stdout) as { result?: { snapshot?: unknown } }).result?.snapshot);
  } catch {
    return false;
  }
}

/**
 * Settings select the runtime, never the launch terminal (ADR 0181).
 * A named session that does not answer falls back to the owned runtime;
 * configured intent remains in settings and active status exposes the fallback.
 */
export async function resolveHerdrBinding(
  settings: HerdrSettings,
  env: NodeJS.ProcessEnv = process.env,
  run: HerdrSessionRunner = (command, args, childEnv) =>
    exec(command, [...args], { env: childEnv, timeout: 5_000, maxBuffer: 8 * 1024 * 1024 }),
): Promise<HerdrSettings> {
  pinHerdrEnvironment(env);
  if (settings.runtime === "disabled") return { runtime: "disabled", session: settings.session };
  const bundled = { runtime: "bundled", session: settings.session } as const;
  if (settings.runtime === "bundled") return bundled;
  const named =
    settings.runtime === "external" || settings.session !== "default" || settings.socketPath !== undefined;
  if (!named) return bundled;
  const socketPath =
    usableSocket(settings.socketPath) ??
    (await listSessions(run, env)).find((row) => row.name === settings.session)?.socketPath;
  if (socketPath === undefined || !(await answers(socketPath, env, run))) return bundled;
  pinHerdrEnvironment(env, socketPath);
  return { runtime: "external", session: settings.session, socketPath };
}

export class HerdrUnavailableError extends Error {
  constructor() {
    super("Herdr is unavailable; connect a runtime with clankie herdr use NAME or clankie herdr create");
    this.name = "HerdrUnavailableError";
  }
}

/** Optional execution capability. Losing it never replaces the selected fleet. */
export async function startHerdrConnection(
  input: {
    settings: HerdrSettings;
    repoRoot: string;
    stateRoot: string;
    env: NodeJS.ProcessEnv;
    warn(message: string): void;
  },
  dependencies: {
    resolve?: typeof resolveHerdrBinding;
    start?: typeof startHerdrRuntime;
    watch?: typeof watchHerdrSocket;
  } = {},
) {
  const selected = await (dependencies.resolve ?? resolveHerdrBinding)(input.settings, input.env);
  let owned: Awaited<ReturnType<typeof startHerdrRuntime>> | undefined;
  let watcher: ReturnType<typeof watchHerdrSocket> | undefined;
  let state = selected.runtime === "disabled" ? "disabled" : "unavailable";
  if (selected.runtime !== "disabled") {
    try {
      if (selected.runtime !== "external") {
        owned = await (dependencies.start ?? startHerdrRuntime)(input);
      }
      if (!input.env.HERDR_SOCKET_PATH) throw new Error("Herdr supplied no socket");
      state = "healthy";
      if (selected.runtime === "external") {
        watcher = (dependencies.watch ?? watchHerdrSocket)({
          socketPath: input.env.HERDR_SOCKET_PATH,
          onLost: () => {
            state = "unavailable";
            input.warn("Herdr connection lost; conversations and Swarm remain active. Reconnect on restart.");
          },
        });
      }
    } catch (error) {
      state = "unavailable";
      input.warn(`Herdr unavailable; Clankie continues without terminals: ${String(error)}`);
    }
  }
  // Even a shell command must not fall through to Herdr's ambient/default session.
  const socketPath =
    state === "healthy" ? input.env.HERDR_SOCKET_PATH! : join(input.stateRoot, "herdr", "unavailable.sock");
  if (state !== "healthy") pinHerdrEnvironment(input.env, socketPath);
  const status = () => owned?.status() ?? state;
  const binding = (): HerdrBinding | undefined =>
    status() === "healthy"
      ? {
          runtime: selected.runtime === "external" ? "external" : "bundled",
          session: selected.session,
          socketPath,
        }
      : undefined;
  return {
    status,
    binding,
    available: () => binding() !== undefined,
    async close() {
      watcher?.close();
      await owned?.close();
    },
  };
}

const NamedExecutionConnectSchema = ExecutionConnectionSchema.omit({ enabled: true, relay: true })
  .partial({ socketPath: true, session: true })
  .refine(
    (value) => value.socketPath !== undefined || value.session !== undefined,
    "Select a session or socket",
  )
  .refine(
    (value) => value.ssh === undefined || (value.socketPath === undefined && value.session !== undefined),
    "An ssh fleet names its remote session, never a local socket",
  );

export const ExecutionConnectSchema = z.union([
  NamedExecutionConnectSchema,
  z
    .object({
      action: z.literal("capacity"),
      id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
      capacity: z.number().int().min(0).nullable(),
    })
    .strict(),
  z.object({ action: z.literal("budget"), budget: z.number().int().min(0).nullable() }).strict(),
  z
    .object({
      action: z.literal("mode"),
      id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
      mode: ExecutionWorkerModeSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("workspaces"),
      id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
      workspaces: ExecutionWorkspacesSchema,
    })
    .strict(),
]);

/**
 * A remote fleet's grants are exact directories on that machine (ADR 0193):
 * this machine can neither realpath them nor resolve a repository identity there.
 */
function remoteExecutionWorkspaces(
  entries: z.infer<typeof ExecutionWorkspacesSchema>,
  shell: "posix" | "powershell",
) {
  return entries.map((entry) => {
    if (entry.kind !== "directory")
      throw new Error("A remote fleet grants exact directories; use --directory PATH");
    const absolute = shell === "powershell" ? win32.isAbsolute(entry.path) : entry.path.startsWith("/");
    if (!absolute || entry.path.includes("\0"))
      throw new Error("A remote workspace must be an absolute path");
    return { kind: "directory" as const, path: entry.path };
  });
}

/** Windows paths compare without case or separator style; POSIX paths exactly. */
function sameRemoteDirectory(granted: string, requested: string, shell: "posix" | "powershell"): boolean {
  if (shell === "posix") return granted.replace(/\/+$/u, "") === requested.replace(/\/+$/u, "");
  const normal = (path: string) => win32.normalize(path).replace(/\\+$/u, "").toLowerCase();
  return normal(granted) === normal(requested);
}

/** Stream is stored as absent, so its route stays identical to one that never chose (ADR 0194). */
function withWorkerMode<T extends { workerMode?: ExecutionWorkerMode | undefined }>(
  value: T,
  mode: ExecutionWorkerMode,
): T {
  const next = { ...value };
  delete next.workerMode;
  return mode === "interactive" ? { ...next, workerMode: mode } : next;
}

async function resolveExecutionWorkspaces(entries: z.infer<typeof ExecutionWorkspacesSchema>) {
  const resolved = await Promise.all(
    entries.map(async (entry) => {
      let path = await realpath(entry.path);
      if (!(await stat(path)).isDirectory()) throw new Error("Execution workspace must be a directory");
      if (entry.kind === "repository") {
        const result = await exec(
          "git",
          ["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"],
          { timeout: 5000 },
        );
        path = await realpath(result.stdout.trim());
      }
      return { kind: entry.kind, path };
    }),
  );
  return [...new Map(resolved.map((entry) => [JSON.stringify(entry), entry])).values()];
}

/** Named external runtimes are never started, stopped or replaced by connection management. */
export class ExecutionConnections {
  private readonly changes = new Set<(id: string) => void>();

  onChange(listener: (id: string) => void): () => void {
    this.changes.add(listener);
    return () => {
      this.changes.delete(listener);
    };
  }

  private readonly options: {
    settings: SettingsStore;
    primary: Pick<Awaited<ReturnType<typeof startHerdrConnection>>, "binding" | "status">;
    env?: NodeJS.ProcessEnv;
    run?: HerdrSessionRunner;
    /** Where each ssh fleet keeps its multiplexed control socket (ADR 0184). */
    sshControlDirectory?: string;
    fleetRun?: (fleet: HerdrFleet) => HerdrFleetRun;
    /**
     * Whether the installed Swarm runtime accepts an interactive worker route
     * (ADR 0194). Absent means it does not: an older owner rejects the field
     * and with it the whole dispatch configuration.
     */
    interactiveWorkers?: () => Promise<boolean>;
  };
  private readonly fleetRuns = new Map<string, { key: string; run: HerdrFleetRun }>();
  /** Each ssh fleet's coordinator relay, reported beside its reachability (VUH-1381). */
  relayStatus: ((fleet: string) => unknown) | undefined;
  /** When each ssh fleet last answered; an unreachable fleet reports it (ADR 0184). */
  private readonly lastSeen = new Map<string, string>();
  constructor(options: ExecutionConnections["options"]) {
    this.options = options;
  }

  /** The one transport per fleet; a changed host or session replaces it. */
  fleetRun(fleet: HerdrFleet): HerdrFleetRun {
    const key = JSON.stringify(fleet);
    const cached = this.fleetRuns.get(fleet.id);
    if (cached?.key === key) return cached.run;
    const run =
      this.options.fleetRun?.(fleet) ??
      createHerdrFleetRun(fleet, {
        controlDirectory: this.options.sshControlDirectory ?? join(homedir(), ".clankie", "ssh"),
      });
    this.fleetRuns.set(fleet.id, { key, run });
    return run;
  }

  private async fleetAnswers(fleet: HerdrFleet): Promise<boolean> {
    try {
      const stdout = await this.fleetRun(fleet)(["api", "snapshot"], undefined, 15_000);
      const answered = Boolean((JSON.parse(stdout) as { result?: { snapshot?: unknown } }).result?.snapshot);
      if (answered) this.lastSeen.set(fleet.id, new Date().toISOString());
      return answered;
    } catch {
      return false;
    }
  }

  /** Enabled ssh fleets, as registered; reachability is each call's own outcome. */
  async fleets(): Promise<readonly HerdrFleet[]> {
    return (await this.options.settings.load()).execution.connections.flatMap((entry) =>
      entry.enabled && entry.ssh !== undefined
        ? [{ id: entry.id, session: entry.session, ssh: entry.ssh }]
        : [],
    );
  }

  /** The conversation whose coordinator an ssh fleet's relay exposes, if one was chosen. */
  async relayConversation(fleetId: string): Promise<string | undefined> {
    const connection = (await this.options.settings.load()).execution.connections.find(
      (entry) => entry.id === fleetId,
    );
    return connection?.enabled && connection.ssh !== undefined ? connection.relay?.conversationId : undefined;
  }

  /** Pin a fleet's relay to one conversation's coordinator; a second scope needs its own fleet entry. */
  async setRelay(fleetId: string, conversationId: string): Promise<void> {
    await this.options.settings.update((current) => {
      const connection = current.execution.connections.find((entry) => entry.id === fleetId);
      if (connection?.ssh === undefined || !connection.enabled) throw new Error("Unknown ssh fleet");
      if (connection.relay !== undefined && connection.relay.conversationId !== conversationId)
        throw new Error(`Fleet ${fleetId} already relays another conversation's coordinator`);
      return {
        ...current,
        execution: {
          ...current.execution,
          connections: current.execution.connections.map((entry) =>
            entry.id === fleetId ? { ...entry, relay: { conversationId } } : entry,
          ),
        },
      };
    });
  }

  /** The owner's exact-directory grant for a remote fleet (ADR 0193). */
  async remoteWorkspace(fleetId: string, directory: string): Promise<boolean> {
    const connection = (await this.options.settings.load()).execution.connections.find(
      (entry) => entry.id === fleetId,
    );
    if (connection?.ssh === undefined || !connection.enabled) return false;
    const shell = connection.ssh.shell;
    return (connection.workspaces ?? []).some(
      (entry) => entry.kind === "directory" && sameRemoteDirectory(entry.path, directory, shell),
    );
  }

  private run: HerdrSessionRunner = (command, args, env) =>
    this.options.run
      ? this.options.run(command, args, env)
      : exec(command, [...args], { env, timeout: 5_000, maxBuffer: 8 * 1024 * 1024 });

  private async requireInteractiveWorkers() {
    if (!(await this.options.interactiveWorkers?.()))
      throw new Error(
        "Interactive workers need an upgraded Swarm runtime; this install's swarm-mcp runs stream workers only",
      );
  }

  /** How Swarm runs workers it dispatches into this runtime (ADR 0194). */
  private async setWorkerMode(id: string, mode: ExecutionWorkerMode) {
    if (mode === "interactive") {
      const target = (await this.options.settings.load()).execution.connections.find(
        (entry) => entry.id === id,
      );
      if (target?.ssh !== undefined)
        throw new Error("An ssh fleet's peers enroll themselves; Swarm dispatches no workers into it");
      await this.requireInteractiveWorkers();
    }
    await this.options.settings.update((current) => {
      if (id === "default") return { ...current, execution: withWorkerMode(current.execution, mode) };
      const connection = current.execution.connections.find((entry) => entry.id === id);
      if (connection === undefined) throw new Error("Unknown runtime connection");
      if (connection.ssh !== undefined && mode === "interactive")
        throw new Error("An ssh fleet's peers enroll themselves; Swarm dispatches no workers into it");
      return {
        ...current,
        execution: {
          ...current.execution,
          connections: current.execution.connections.map((entry) =>
            entry.id === id ? withWorkerMode(entry, mode) : entry,
          ),
        },
      };
    });
    for (const listener of this.changes) listener(id);
    return { id, workerMode: mode };
  }

  async connect(raw: unknown) {
    const parsed = ExecutionConnectSchema.parse(raw);
    if ("action" in parsed && parsed.action === "mode") return this.setWorkerMode(parsed.id, parsed.mode);
    if (!("action" in parsed) && parsed.workerMode === "interactive") {
      if (parsed.ssh !== undefined)
        throw new Error("An ssh fleet's peers enroll themselves; Swarm dispatches no workers into it");
      await this.requireInteractiveWorkers();
    }
    const input = "action" in parsed ? parsed : withWorkerMode(parsed, parsed.workerMode ?? "stream");
    if ("action" in input && input.action !== "workspaces") {
      await this.options.settings.update((current) => {
        if (input.action === "budget")
          return { ...current, execution: { ...current.execution, budget: input.budget } };
        if (input.id !== "default" && !current.execution.connections.some((entry) => entry.id === input.id))
          throw new Error("Unknown runtime connection");
        return {
          ...current,
          execution: {
            ...current.execution,
            ...(input.id === "default"
              ? { capacity: input.capacity }
              : {
                  connections: current.execution.connections.map((entry) =>
                    entry.id === input.id ? { ...entry, capacity: input.capacity } : entry,
                  ),
                }),
          },
        };
      });
      for (const listener of this.changes) listener(input.action === "budget" ? "default" : input.id);
      return input;
    }
    if ("action" in input) {
      const target = (await this.options.settings.load()).execution.connections.find(
        (entry) => entry.id === input.id,
      );
      const workspaces =
        target?.ssh === undefined
          ? await resolveExecutionWorkspaces(input.workspaces)
          : remoteExecutionWorkspaces(input.workspaces, target.ssh.shell);
      await this.options.settings.update((current) => {
        if (input.id !== "default" && !current.execution.connections.some((entry) => entry.id === input.id))
          throw new Error("Unknown runtime connection");
        return {
          ...current,
          execution: {
            ...current.execution,
            ...(input.id === "default"
              ? { workspaces }
              : {
                  connections: current.execution.connections.map((entry) =>
                    entry.id === input.id ? { ...entry, workspaces } : entry,
                  ),
                }),
          },
        };
      });
      for (const listener of this.changes) listener(input.id);
      return { id: input.id, workspaces };
    }
    if (input.ssh !== undefined) return this.connectFleet({ ...input, ssh: input.ssh });
    const env = pinHerdrEnvironment({ ...(this.options.env ?? process.env) });
    const socketPath =
      input.socketPath ??
      (await listSessions(this.run, env)).find((row) => row.name === input.session)?.socketPath;
    if (!socketPath || !(await answers(socketPath, env, this.run)))
      throw new Error("Herdr runtime did not answer");
    const connection = ExecutionConnectionSchema.parse({
      ...input,
      ...(input.workspaces ? { workspaces: await resolveExecutionWorkspaces(input.workspaces) } : {}),
      socketPath,
      session: input.session ?? input.id,
      enabled: true,
    });
    await this.options.settings.update((current) => {
      const previous = current.execution.connections.find((entry) => entry.id === connection.id);
      if (previous && (previous.socketPath !== socketPath || previous.session !== connection.session))
        throw new Error("Runtime connection ID is pinned to another session/socket; use a new ID");
      if (
        current.execution.connections.some(
          (entry) => entry.id !== connection.id && entry.socketPath === socketPath,
        ) ||
        this.options.primary.binding()?.socketPath === socketPath
      )
        throw new Error("This runtime already has a connection");
      return {
        ...current,
        execution: {
          ...current.execution,
          connections: [
            ...current.execution.connections.filter((entry) => entry.id !== connection.id),
            connection,
          ],
        },
      };
    });
    for (const listener of this.changes) listener(connection.id);
    return connection;
  }

  /**
   * Register an ssh fleet (ADR 0184). The remote session must already answer:
   * registration never starts, stops or replaces the server that owns it.
   */
  private async connectFleet(
    input: z.infer<typeof NamedExecutionConnectSchema> & { ssh: HerdrFleet["ssh"] },
  ) {
    const fleet: HerdrFleet = { id: input.id, session: input.session ?? input.id, ssh: input.ssh };
    if (!(await this.fleetAnswers(fleet)))
      throw new Error(
        `Herdr fleet ${fleet.id} did not answer: no running session ${fleet.session} over ssh ${fleet.ssh.host}`,
      );
    const connection = ExecutionConnectionSchema.parse({
      ...input,
      ...(input.workspaces
        ? { workspaces: remoteExecutionWorkspaces(input.workspaces, input.ssh.shell) }
        : {}),
      session: fleet.session,
      enabled: true,
    });
    await this.options.settings.update((current) => {
      const previous = current.execution.connections.find((entry) => entry.id === connection.id);
      if (
        previous &&
        (previous.ssh?.host !== fleet.ssh.host ||
          previous.ssh.shell !== fleet.ssh.shell ||
          previous.session !== fleet.session)
      )
        throw new Error("Runtime connection ID is pinned to another host/session; use a new ID");
      if (
        current.execution.connections.some(
          (entry) =>
            entry.id !== connection.id &&
            entry.ssh?.host === fleet.ssh.host &&
            entry.session === fleet.session,
        )
      )
        throw new Error("This fleet already has a connection");
      return {
        ...current,
        execution: {
          ...current.execution,
          connections: [
            ...current.execution.connections.filter((entry) => entry.id !== connection.id),
            {
              ...connection,
              ...(previous?.workspaces && !input.workspaces ? { workspaces: previous.workspaces } : {}),
              ...(previous?.relay ? { relay: previous.relay } : {}),
            },
          ],
        },
      };
    });
    for (const listener of this.changes) listener(connection.id);
    return connection;
  }

  /** Remove a registration entirely; the remote fleet itself is untouched. */
  async remove(id: string) {
    await this.options.settings.update((current) => {
      if (!current.execution.connections.some((entry) => entry.id === id))
        throw new Error("Unknown runtime connection");
      return {
        ...current,
        execution: {
          ...current.execution,
          connections: current.execution.connections.filter((entry) => entry.id !== id),
        },
      };
    });
    this.fleetRuns.delete(id);
    for (const listener of this.changes) listener(id);
  }

  async disconnect(id: string) {
    await this.options.settings.update((current) => {
      if (!current.execution.connections.some((entry) => entry.id === id))
        throw new Error("Unknown runtime connection");
      return {
        ...current,
        execution: {
          ...current.execution,
          connections: current.execution.connections.map((entry) =>
            entry.id === id ? { ...entry, enabled: false } : entry,
          ),
        },
      };
    });
    for (const listener of this.changes) listener(id);
  }

  async dispatchBudget() {
    const budget = (await this.options.settings.load()).execution.budget;
    return budget === undefined ? 16 : budget;
  }

  async list() {
    const settings = await this.options.settings.load();
    const configured = settings.execution.connections;
    const checked = await Promise.all(
      configured.map(async (connection) => ({
        ...connection,
        capacity: connection.capacity === undefined ? 16 : connection.capacity,
        capacitySource:
          connection.capacity === undefined
            ? "default"
            : connection.capacity === null
              ? "unlimited"
              : "owner",
        ...(connection.ssh === undefined
          ? { workerMode: connection.workerMode ?? ("stream" as const) }
          : { transport: "ssh" as const }),
        state: !connection.enabled
          ? "disabled"
          : connection.ssh !== undefined
            ? (await this.fleetAnswers({
                id: connection.id,
                session: connection.session,
                ssh: connection.ssh,
              }))
              ? "healthy"
              : "unreachable"
            : connection.socketPath !== undefined &&
                (await answers(connection.socketPath, this.options.env ?? process.env, this.run))
              ? "healthy"
              : "unavailable",
        ...(connection.ssh !== undefined && this.lastSeen.has(connection.id)
          ? { lastSeenAt: this.lastSeen.get(connection.id) }
          : {}),
        ...(connection.ssh !== undefined && this.relayStatus?.(connection.id) !== undefined
          ? { relayState: this.relayStatus(connection.id) }
          : {}),
      })),
    );
    const current = (await this.options.settings.load()).execution.connections;
    const primary = this.options.primary.binding();
    return [
      {
        id: "default",
        kind: "herdr" as const,
        session: primary?.session ?? settings.herdr.session,
        configured: settings.herdr,
        socketPath: primary?.socketPath,
        state: this.options.primary.status(),
        enabled: primary !== undefined,
        ...(settings.execution.workspaces ? { workspaces: settings.execution.workspaces } : {}),
        capacity: settings.execution.capacity === undefined ? 16 : settings.execution.capacity,
        capacitySource:
          settings.execution.capacity === undefined
            ? "default"
            : settings.execution.capacity === null
              ? "unlimited"
              : "owner",
        workerMode: settings.execution.workerMode ?? ("stream" as const),
        budget: settings.execution.budget === undefined ? 16 : settings.execution.budget,
        budgetSource:
          settings.execution.budget === undefined
            ? "default"
            : settings.execution.budget === null
              ? "unlimited"
              : "owner",
        capabilities: ["code", "review", "research"],
      },
      ...checked.map((connection) =>
        isDeepStrictEqual(
          configured.find((entry) => entry.id === connection.id),
          current.find((entry) => entry.id === connection.id),
        )
          ? connection
          : { ...connection, enabled: false, state: "changed" },
      ),
    ];
  }

  /** Current admission, without a health probe on every terminal input packet. */
  async configuredBinding(id: string): Promise<HerdrBinding | undefined> {
    if (id === "default") return this.options.primary.binding();
    const connection = (await this.options.settings.load()).execution.connections.find(
      (entry) => entry.id === id,
    );
    // An ssh fleet has no local socket for terminal observe/control yet (ADR 0184).
    return connection?.enabled && connection.socketPath !== undefined
      ? { runtime: "external", session: connection.session, socketPath: connection.socketPath }
      : undefined;
  }

  async binding(id: string): Promise<HerdrBinding | undefined> {
    if (id === "default") return this.options.primary.binding();
    const connection = (await this.options.settings.load()).execution.connections.find(
      (entry) => entry.id === id,
    );
    if (
      !connection?.enabled ||
      connection.socketPath === undefined ||
      !(await answers(connection.socketPath, this.options.env ?? process.env, this.run))
    )
      return undefined;
    const current = (await this.options.settings.load()).execution.connections.find(
      (entry) => entry.id === id,
    );
    return isDeepStrictEqual(connection, current)
      ? { runtime: "external", session: connection.session, socketPath: connection.socketPath }
      : undefined;
  }
}
