import { z } from "zod";
import { realpath, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import {
  ExecutionWorkspacesSchema,
  ExecutionConnectionSchema,
  type SettingsStore,
  type HerdrSettings,
} from "@clankie/settings";
import type { HerdrBinding } from "@clankie/protocol";
import { startHerdrRuntime, watchHerdrSocket } from "./herdr-runtime.ts";

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

const NamedExecutionConnectSchema = ExecutionConnectionSchema.omit({ enabled: true })
  .partial({ socketPath: true, session: true })
  .refine(
    (value) => value.socketPath !== undefined || value.session !== undefined,
    "Select a session or socket",
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
      action: z.literal("workspaces"),
      id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
      workspaces: ExecutionWorkspacesSchema,
    })
    .strict(),
]);

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
  };
  constructor(options: {
    settings: SettingsStore;
    primary: Pick<Awaited<ReturnType<typeof startHerdrConnection>>, "binding" | "status">;
    env?: NodeJS.ProcessEnv;
    run?: HerdrSessionRunner;
  }) {
    this.options = options;
  }

  private run: HerdrSessionRunner = (command, args, env) =>
    this.options.run
      ? this.options.run(command, args, env)
      : exec(command, [...args], { env, timeout: 5_000, maxBuffer: 8 * 1024 * 1024 });

  async connect(raw: unknown) {
    const input = ExecutionConnectSchema.parse(raw);
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
      const workspaces = await resolveExecutionWorkspaces(input.workspaces);
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
        state: !connection.enabled
          ? "disabled"
          : (await answers(connection.socketPath, this.options.env ?? process.env, this.run))
            ? "healthy"
            : "unavailable",
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
    return connection?.enabled
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
