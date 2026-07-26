import { join } from "node:path";
import { z } from "zod";
import {
  captainServiceStatePath,
  DEFAULT_CAPTAIN_URL,
  inspectCaptain,
  readCaptainServiceRecord,
  restartCaptainService,
  type RestartCaptainServiceOptions,
} from "./captain-service.ts";
import { DEFAULT_CONTROL_PLANE_URL } from "./pairing-offer.ts";
import {
  inspectService,
  processIsAlive,
  restartService,
  SERVICE_ORDER,
  startService,
  stopService,
  type ManagedService,
  type ServiceCommandOptions,
  type ServiceId,
  type ServiceRecord,
  type ServiceStatus,
} from "./service-supervisor.ts";

/**
 * The three long-lived processes that make Clankie present in Discord, and the
 * order they depend on each other in:
 *
 *   captain-eve  ->  control-plane  ->  discord-bridge
 *
 * The bridge authenticates to the control plane, and the control plane routes
 * turns to the captain, so a restart walks forwards and a shutdown walks back.
 * Before this registry existed each one was started by hand with a bespoke
 * `pgrep | kill` sequence and an env prefix that duplicated settings.json.
 */

/** Targets an operator may name; `all` fans out over {@link SERVICE_ORDER}. */
export type ServiceTarget = ServiceId | "all";

/** Short aliases, because nobody wants to type `discord-bridge` every time. */
const TARGET_ALIASES: Readonly<Record<string, ServiceTarget>> = {
  all: "all",
  captain: "captain-eve",
  "captain-eve": "captain-eve",
  eve: "captain-eve",
  "control-plane": "control-plane",
  controlplane: "control-plane",
  cp: "control-plane",
  discord: "discord-bridge",
  activity: "activity",
  watch: "activity",
  viewer: "activity",
  "discord-bridge": "discord-bridge",
  bridge: "discord-bridge",
};

export function parseServiceTarget(raw: string | undefined): ServiceTarget {
  if (raw === undefined || raw.length === 0) return "all";
  const target = TARGET_ALIASES[raw.toLowerCase()];
  if (target === undefined) {
    throw new Error(
      `Unknown service "${raw}". Expected one of: all, captain, control-plane, discord (aliases: eve, cp, bridge).`,
    );
  }
  return target;
}

export function resolveTargets(target: ServiceTarget): readonly ServiceId[] {
  return target === "all" ? SERVICE_ORDER : [target];
}

function controlPlaneUrl(env: NodeJS.ProcessEnv): string {
  return env.CLANKIE_CONTROL_PLANE_URL ?? DEFAULT_CONTROL_PLANE_URL;
}

function captainUrl(env: NodeJS.ProcessEnv): string {
  return env.CLANKIE_CAPTAIN_URL ?? DEFAULT_CAPTAIN_URL;
}

const ControlPlaneHealthSchema = z.object({
  ok: z.literal(true),
  service: z.literal("clankie-control-plane"),
});

const PresenceStatusSchema = z.object({
  schemaVersion: z.literal(1),
  sessions: z.array(
    z.object({
      phase: z.string().min(1),
      gatewayConnected: z.boolean(),
      voiceGuildCount: z.number().int().nonnegative(),
      activityCount: z.number().int().nonnegative(),
    }),
  ),
});

/** Read-only operator projection of the bridge's published presence phase. */
export const PRESENCE_STATUS_PATH = "/v1/discord/presence-status";

/**
 * Phases the control plane treats as a live, acting presence. Anything else
 * (`connecting`, `degraded`, `failed`, `off`) is reported verbatim so the
 * operator sees the real phase rather than a flattened "ok".
 */
const LIVE_PRESENCE_PHASES: ReadonlySet<string> = new Set(["present", "voice_active", "go_live_active"]);

async function readPresenceDetail(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly fetchImpl: typeof fetch;
  readonly operatorToken: string | undefined;
}): Promise<string | undefined> {
  const token = input.operatorToken?.trim();
  if (token === undefined || token.length === 0) return undefined;
  try {
    const response = await input.fetchImpl(new URL(PRESENCE_STATUS_PATH, controlPlaneUrl(input.env)), {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(750),
    });
    if (!response.ok) return undefined;
    const parsed = PresenceStatusSchema.safeParse(await response.json());
    if (!parsed.success) return undefined;
    const live = parsed.data.sessions.filter((session) => LIVE_PRESENCE_PHASES.has(session.phase));
    const session = live[0] ?? parsed.data.sessions[0];
    if (session === undefined) return "no presence session";
    const voice = session.voiceGuildCount > 0 ? `, voice in ${String(session.voiceGuildCount)}` : "";
    return `session ${session.phase}${voice}`;
  } catch {
    // Presence detail is decoration on top of process health; never fail on it.
    return undefined;
  }
}

/**
 * The captain's record carries a build generation and is keyed by host, so it
 * has its own reader rather than the generic `<id>-service.json` shape.
 */
function readCaptainRecord(
  env: NodeJS.ProcessEnv,
  processIsAliveImpl: (pid: number) => boolean,
): ServiceRecord | undefined {
  const record = readCaptainServiceRecord(captainServiceStatePath(env), captainUrl(env), processIsAliveImpl);
  return record === undefined ? undefined : { id: "captain-eve", pid: record.pid, version: 1 };
}

const CAPTAIN_EVE: ManagedService = {
  id: "captain-eve",
  label: "Captain Eve",
  dependsOn: [],
  spawnArgs: [
    "--filter",
    "@clankie/captain-eve",
    "exec",
    "eve",
    "start",
    "--host",
    "127.0.0.1",
    "--port",
    "4321",
  ],
  commandMatches: (command) =>
    command.includes("@clankie/captain-eve") && /\beve\b.*\bstart\b/u.test(command),
  readRecord: (env, processIsAliveImpl) => readCaptainRecord(env, processIsAliveImpl),
  probe: async ({ env, fetchImpl }) => {
    const inspection = await inspectCaptain(captainUrl(env), fetchImpl);
    return {
      state: inspection.state,
      ...(inspection.generation === undefined
        ? {}
        : { detail: `generation ${inspection.generation.slice(0, 8)}` }),
    };
  },
};

const CONTROL_PLANE: ManagedService = {
  id: "control-plane",
  label: "Control plane",
  dependsOn: ["captain-eve"],
  spawnArgs: ["--filter", "@clankie/control-plane", "start"],
  commandMatches: (command) => command.includes("@clankie/control-plane"),
  /**
   * The presence runtime module is a repository path, not a preference, so the
   * launcher supplies it rather than making the operator remember an env
   * prefix. Guild and channel allowlists are deliberately absent: settings.json
   * is their source of truth and `@clankie/settings` fills the unset env.
   */
  serviceEnv: ({ env, repoRoot }) => ({
    ...env,
    CLANKIE_DISCORD_PRESENCE_RUNTIME_MODULE:
      env.CLANKIE_DISCORD_PRESENCE_RUNTIME_MODULE ??
      join(repoRoot, "apps", "discord-bridge", "src", "presence-runtime-module.ts"),
  }),
  probe: async ({ env, fetchImpl }) => {
    try {
      const response = await fetchImpl(new URL("/health", controlPlaneUrl(env)), {
        redirect: "error",
        signal: AbortSignal.timeout(750),
      });
      if (!response.ok) return { state: "unhealthy" };
      return ControlPlaneHealthSchema.safeParse(await response.json()).success
        ? { state: "healthy" }
        : { state: "unhealthy" };
    } catch {
      return { state: "unreachable" };
    }
  },
};

const DISCORD_BRIDGE: ManagedService = {
  id: "discord-bridge",
  label: "Discord bridge",
  dependsOn: ["control-plane"],
  spawnArgs: ["--filter", "@clankie/discord-bridge", "start"],
  commandMatches: (command) => command.includes("@clankie/discord-bridge"),
  /**
   * The bridge serves no HTTP surface, so process liveness is the only signal it
   * owns. Its *semantic* phase is published to the control plane, which is the
   * authority the doctrine points at for operator status (ADR 0024): read it
   * when a credential is available, and never downgrade health on its absence.
   */
  probe: async ({ env, fetchImpl, operatorToken, record, matchingPids }) => {
    const presence = await readPresenceDetail({ env, fetchImpl, operatorToken });
    if (record !== undefined) {
      return { state: "healthy", ...(presence === undefined ? {} : { detail: presence }) };
    }
    // No launcher record. A bridge started by hand is still a bridge, and
    // calling it "unreachable" would be a lie the operator can see through — so
    // report it, but only once a live process confirms one exists.
    //
    // Presence phase alone cannot carry that: it is durable state written on
    // transition, never on a heartbeat, and a fresh control plane replays it
    // from the event store. A bridge that died without publishing `off` leaves
    // `present` standing indefinitely, which is exactly how a phantom bridge
    // came to block `clankie restart` against a process that no longer existed.
    if (matchingPids.length === 0) return { state: "unreachable" };
    return presence === undefined || presence === "no presence session"
      ? { state: "healthy", detail: "started outside the launcher" }
      : { state: "healthy", detail: `${presence} (started outside the launcher)` };
  },
};

/**
 * The rendering surface for anything Clankie is playing.
 *
 * It holds no credentials, no gateway, and no mission authority — it draws
 * frames a producer sends it — so it depends on nothing and nothing depends on
 * it. It is in the registry because starting it by hand was the last thing an
 * operator had to remember, and because it is the same app Discord embeds as
 * the activity ([ADR 0047](../../../docs/adr/0047-discord-activity-presence-plane.md)):
 * one thing to start whether you are watching locally or in a voice channel.
 */
const ACTIVITY: ManagedService = {
  id: "activity",
  label: "Activity surface",
  dependsOn: [],
  spawnArgs: ["--filter", "@clankie/discord-activity", "start"],
  commandMatches: (command) => command.includes("@clankie/discord-activity"),
  probe: async ({ env, fetchImpl }) => {
    const port = env["CLANKIE_ACTIVITY_PORT"] ?? "4320";
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/`);
      return response.ok
        ? { state: "healthy", detail: `viewer on 127.0.0.1:${port}` }
        : { state: "unhealthy" };
    } catch {
      return { state: "unreachable" };
    }
  },
};

const SERVICES: Readonly<Record<ServiceId, ManagedService>> = {
  "captain-eve": CAPTAIN_EVE,
  "control-plane": CONTROL_PLANE,
  "discord-bridge": DISCORD_BRIDGE,
  activity: ACTIVITY,
};

export function managedService(id: ServiceId): ManagedService {
  return SERVICES[id];
}

export interface ServiceRegistryOptions extends ServiceCommandOptions {
  /** Test seam for the captain's build-and-boot path. */
  readonly restartCaptainImpl?: (
    options: RestartCaptainServiceOptions,
  ) => Promise<{ readonly generation?: string }>;
}

/**
 * The captain owns a build step, a shared build lock, and a generation hash, so
 * its restart stays in `captain-service.ts` rather than being flattened into the
 * generic supervisor. The registry just routes to it.
 */
async function restartCaptain(options: ServiceRegistryOptions): Promise<ServiceStatus> {
  const env = options.env ?? process.env;
  const handle = await (options.restartCaptainImpl ?? restartCaptainService)({
    repoRoot: options.repoRoot,
    host: captainUrl(env),
    env,
    fetchImpl: options.fetchImpl ?? fetch,
    ...(options.onStatus === undefined ? {} : { onStatus: options.onStatus }),
    ...(options.spawnImpl === undefined ? {} : { spawnImpl: options.spawnImpl }),
  });
  const record = readCaptainRecord(env, options.processIsAliveImpl ?? processIsAlive);
  return {
    id: "captain-eve",
    label: CAPTAIN_EVE.label,
    state: "healthy",
    owned: true,
    ...(handle.generation === undefined ? {} : { detail: `generation ${handle.generation.slice(0, 8)}` }),
    ...(record === undefined ? {} : { pid: record.pid }),
  };
}

export async function restartOne(id: ServiceId, options: ServiceRegistryOptions): Promise<ServiceStatus> {
  if (id === "captain-eve") return await restartCaptain(options);
  return await restartService(managedService(id), options);
}

export async function startOne(id: ServiceId, options: ServiceRegistryOptions): Promise<ServiceStatus> {
  if (id === "captain-eve") {
    const status = await inspectService(CAPTAIN_EVE, options);
    return status.state === "healthy" ? status : await restartCaptain(options);
  }
  return await startService(managedService(id), options);
}

export interface ServiceOutcome {
  readonly id: ServiceId;
  readonly label: string;
  readonly ok: boolean;
  readonly state?: ServiceStatus["state"];
  readonly detail?: string;
  readonly pid?: number;
  readonly error?: string;
}

function outcomeFrom(status: ServiceStatus): ServiceOutcome {
  return {
    id: status.id,
    label: status.label,
    ok: status.state === "healthy",
    state: status.state,
    ...(status.detail === undefined ? {} : { detail: status.detail }),
    ...(status.pid === undefined ? {} : { pid: status.pid }),
  };
}

function failureFrom(id: ServiceId, error: unknown): ServiceOutcome {
  return {
    id,
    label: managedService(id).label,
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Restarts in dependency order and stops at the first failure. Continuing past a
 * dead captain would only produce a bridge that cannot route a turn, and a wall
 * of downstream errors that hide the one that mattered.
 */
export async function restartTarget(
  target: ServiceTarget,
  options: ServiceRegistryOptions,
): Promise<readonly ServiceOutcome[]> {
  const outcomes: ServiceOutcome[] = [];
  for (const id of resolveTargets(target)) {
    try {
      outcomes.push(outcomeFrom(await restartOne(id, options)));
    } catch (error) {
      outcomes.push(failureFrom(id, error));
      break;
    }
  }
  return outcomes;
}

/** Stops in reverse dependency order so dependents never outlive what they call. */
export async function stopTarget(
  target: ServiceTarget,
  options: ServiceRegistryOptions,
): Promise<readonly ServiceOutcome[]> {
  const outcomes: ServiceOutcome[] = [];
  for (const id of [...resolveTargets(target)].reverse()) {
    try {
      await stopService(managedService(id), options);
      outcomes.push({ id, label: managedService(id).label, ok: true, state: "unreachable" });
    } catch (error) {
      outcomes.push(failureFrom(id, error));
    }
  }
  return outcomes;
}

/** Inspects the named services concurrently; probes are read-only and independent. */
export async function inspectServices(
  ids: readonly ServiceId[],
  options: ServiceRegistryOptions,
): Promise<readonly ServiceStatus[]> {
  return await Promise.all(ids.map((id) => inspectService(managedService(id), options)));
}

export async function inspectTarget(
  target: ServiceTarget,
  options: ServiceRegistryOptions,
): Promise<readonly ServiceStatus[]> {
  return await inspectServices(resolveTargets(target), options);
}
