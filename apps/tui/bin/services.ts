import { join } from "node:path";
import { resolveDiscordActiveBody } from "@clankie/settings";
import { z } from "zod";
import { DEFAULT_CONTROL_PLANE_URL } from "./pairing-offer.ts";
import {
  inspectService,
  restartService,
  SERVICE_ORDER,
  startService,
  stopService,
  type ManagedService,
  type ServiceCommandOptions,
  type ServiceId,
  type ServiceStatus,
} from "./service-supervisor.ts";

/**
 * The long-lived processes that make Clankie present, and the order they
 * depend on each other in:
 *
 *   clankie  ->  discord-bridge          (active body = bot)
 *            ->  discord-user-session    (active body = user_session)
 *   activity stands alone, tunnel fronts it
 *
 * The clankie service is the single backend: it hosts the captain, the
 * operator conversation dispatch, the lane listing, and every operator API
 * route on port 4310. The bridge authenticates to it; the activity
 * surface and its tunnel publish what he plays.
 */

/** Targets an operator may name; `all` fans out over {@link SERVICE_ORDER}. */
export type ServiceTarget = ServiceId | "all";

/** Short aliases, because nobody wants to type `discord-bridge` every time. */
const TARGET_ALIASES: Readonly<Record<string, ServiceTarget>> = {
  all: "all",
  clankie: "clankie",
  captain: "clankie",
  "captain-eve": "clankie",
  eve: "clankie",
  "control-plane": "clankie",
  controlplane: "clankie",
  cp: "clankie",
  discord: "discord-bridge",
  activity: "activity",
  watch: "activity",
  viewer: "activity",
  tunnel: "tunnel",
  cloudflared: "tunnel",
  "discord-bridge": "discord-bridge",
  bridge: "discord-bridge",
  "user-session": "discord-user-session",
  "discord-user-session": "discord-user-session",
  lab: "discord-user-session",
};

/**
 * How a package service is spawned, and how to recognize that spawn in the
 * process table.
 *
 * The matcher looks for the launcher's own argv (`--filter <pkg> start`), not
 * for the package name alone. A bare name matches every process that merely
 * mentions it — an agent running `pnpm --filter @clankie/clankie test`, a grep,
 * the shell wrapper around either — and the launcher then reports the service
 * as "running but not launcher-owned" and refuses to start or stop the real
 * one. With a fleet of agents working in this repo that fires constantly.
 */
function pnpmStart(pkg: string): Pick<ManagedService, "spawnArgs" | "commandMatches"> {
  const argv = ["--filter", pkg, "start"];
  const spawnShape = argv.join(" ");
  return { spawnArgs: argv, commandMatches: (command) => command.includes(spawnShape) };
}

export function parseServiceTarget(raw: string | undefined): ServiceTarget {
  if (raw === undefined || raw.length === 0) return "all";
  const target = TARGET_ALIASES[raw.toLowerCase()];
  if (target === undefined) {
    throw new Error(
      `Unknown service "${raw}". Expected one of: all, clankie, discord, user-session, activity, tunnel (aliases: captain, eve, cp, control-plane, bridge, lab, watch, viewer, cloudflared).`,
    );
  }
  return target;
}

export function resolveTargets(target: ServiceTarget): readonly ServiceId[] {
  return target === "all" ? SERVICE_ORDER : [target];
}

/**
 * A service plus the services whose cached state its restart invalidates, in
 * dependency order.
 *
 * Restarting the clankie service alone leaves the still-running Discord bridge
 * holding a live claim — session id, phase, revision — for presence state the
 * service has just rebuilt from its event store. Every reply the bridge then
 * posts comes back `discord_presence_live_claim_stale`; it stays healthy and
 * Clankie simply goes quiet, which is exactly how this was found.
 *
 * Driven by `restartsWith` rather than `dependsOn`, because the two are not the
 * same relationship. Stopping is deliberately untouched: naming one service to
 * stop is an instruction to stop that service.
 */
export function resolveRestartTargets(target: ServiceTarget): readonly ServiceId[] {
  if (target === "all") return SERVICE_ORDER;
  const affected = new Set<ServiceId>([target]);
  // SERVICE_ORDER is dependency-ordered, so one forward pass also closes over a
  // service invalidated by something itself invalidated earlier in the chain.
  for (const id of SERVICE_ORDER) {
    if (managedService(id).restartsWith?.some((dependency) => affected.has(dependency))) affected.add(id);
  }
  return SERVICE_ORDER.filter((id) => affected.has(id));
}

function serviceUrl(env: NodeJS.ProcessEnv): string {
  return env.CLANKIE_CONTROL_PLANE_URL ?? env.CLANKIE_CAPTAIN_URL ?? DEFAULT_CONTROL_PLANE_URL;
}

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
 * Phases the service treats as a live, acting presence. Anything else
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
    const response = await input.fetchImpl(new URL(PRESENCE_STATUS_PATH, serviceUrl(input.env)), {
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
 * The single clankie service. No build step and no generation hash: `pnpm
 * --filter @clankie/clankie start` runs it, and `/health` answering on its
 * port is what "up" means.
 */
const CLANKIE: ManagedService = {
  id: "clankie",
  label: "Clankie",
  dependsOn: [],
  ...pnpmStart("@clankie/clankie"),
  /**
   * The presence runtime module is a repository path, not a preference, so the
   * launcher supplies it rather than making the operator remember an env
   * prefix. Guild and channel allowlists are deliberately absent: settings.json
   * is their source of truth and `@clankie/settings` fills the unset env.
   *
   * The captain token is half of the shared captain secret. Without it the
   * service builds no captain authenticator and answers every dispatch call 401.
   */
  serviceEnv: ({ env, repoRoot, captainToken }) => ({
    ...env,
    CLANKIE_DISCORD_PRESENCE_RUNTIME_MODULE:
      env.CLANKIE_DISCORD_PRESENCE_RUNTIME_MODULE ??
      join(repoRoot, "apps", "discord-bridge", "src", "presence-runtime-module.ts"),
    CLANKIE_DISCORD_USER_PRESENCE_RUNTIME_MODULE:
      env.CLANKIE_DISCORD_USER_PRESENCE_RUNTIME_MODULE ??
      join(repoRoot, "apps", "discord-user-session", "src", "presence-runtime-module.ts"),
    ...(captainToken === undefined ? {} : { CLANKIE_CAPTAIN_TOKEN: captainToken }),
  }),
  probe: async ({ env, fetchImpl }) => {
    try {
      const response = await fetchImpl(new URL("/health", serviceUrl(env)), {
        redirect: "error",
        signal: AbortSignal.timeout(750),
      });
      return response.ok ? { state: "healthy" } : { state: "unhealthy" };
    } catch {
      return { state: "unreachable" };
    }
  },
};

const DISCORD_BRIDGE: ManagedService = {
  id: "discord-bridge",
  label: "Discord bridge",
  dependsOn: ["clankie"],
  ...pnpmStart("@clankie/discord-bridge"),
  enabled: (env) => resolveDiscordActiveBody(env) === "bot",
  // Its live presence claim is only valid against the service instance that
  // issued it, so a clankie restart requires a bridge restart.
  restartsWith: ["clankie"],
  /**
   * Strips the captain bearer rather than passing one.
   *
   * The bridge refuses to start at all if `CLANKIE_CAPTAIN_TOKEN` is present —
   * its identity is brokered separately as `clankie_discord_bridge`, and sharing
   * the captain's would hand a Discord-facing process the captain's authority.
   */
  serviceEnv: ({ env }) => {
    const { CLANKIE_CAPTAIN_TOKEN: _removed, ...withoutCaptainToken } = env;
    return withoutCaptainToken;
  },
  /**
   * The bridge serves no HTTP surface, so process liveness is the only signal it
   * owns. Its *semantic* phase is published to the clankie service: read it when
   * a credential is available, and never downgrade health on its absence.
   */
  probe: async ({ env, fetchImpl, operatorToken, record, matchingPids }) => {
    if (resolveDiscordActiveBody(env) !== "bot") {
      return { state: "healthy", detail: "inactive — lab user body is the mouth" };
    }
    const presence = await readPresenceDetail({ env, fetchImpl, operatorToken });
    if (record !== undefined) {
      return { state: "healthy", ...(presence === undefined ? {} : { detail: presence }) };
    }
    // No launcher record. A bridge started by hand is still a bridge, and
    // calling it "unreachable" would be a lie the operator can see through — so
    // report it, but only once a live process confirms one exists.
    //
    // Presence phase alone cannot carry that: it is durable state written on
    // transition, never on a heartbeat. A bridge that died without publishing
    // `off` leaves `present` standing indefinitely.
    if (matchingPids.length === 0) return { state: "unreachable" };
    return presence === undefined || presence === "no presence session"
      ? { state: "healthy", detail: "started outside the launcher" }
      : { state: "healthy", detail: `${presence} (started outside the launcher)` };
  },
};

/**
 * Personal-lab user-session body (ADR 0048). Off unless the owner enabled it
 * in `/discord` and made it the active body. Only one Discord process is the
 * mouth; the official bot stays down while this one is up.
 */
const DISCORD_USER_SESSION: ManagedService = {
  id: "discord-user-session",
  label: "Discord lab body",
  dependsOn: ["clankie"],
  ...pnpmStart("@clankie/discord-user-session"),
  restartsWith: ["clankie"],
  enabled: (env) =>
    env.DISCORD_USER_SESSION_ENABLED === "true" && resolveDiscordActiveBody(env) === "user_session",
  serviceEnv: ({ env, repoRoot }) => {
    const {
      CLANKIE_CAPTAIN_TOKEN: _captain,
      DISCORD_BOT_TOKEN: _bot,
      DISCORD_USER_TOKEN: _user,
      ...rest
    } = env;
    return {
      ...rest,
      CLANKIE_DISCORD_USER_PRESENCE_RUNTIME_MODULE:
        env.CLANKIE_DISCORD_USER_PRESENCE_RUNTIME_MODULE ??
        join(repoRoot, "apps", "discord-user-session", "src", "presence-runtime-module.ts"),
    };
  },
  probe: async ({ env, fetchImpl, record, matchingPids }) => {
    if (env.DISCORD_USER_SESSION_ENABLED !== "true") {
      return { state: "healthy", detail: "lab body off" };
    }
    if (resolveDiscordActiveBody(env) !== "user_session") {
      return { state: "healthy", detail: "inactive — official bot is the mouth" };
    }
    const port = env.CLANKIE_USER_SESSION_CONTROL_PORT ?? "4312";
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/health`, {
        redirect: "error",
        signal: AbortSignal.timeout(750),
      });
      return response.ok ? { state: "healthy", detail: "user session connected" } : { state: "unhealthy" };
    } catch {
      if (record !== undefined || matchingPids.length > 0) return { state: "unhealthy" };
      return { state: "unreachable" };
    }
  },
};

/**
 * The rendering surface for anything Clankie is playing.
 *
 * It holds no credentials, no gateway, and no authority — it draws
 * frames a producer sends it — so it depends on nothing and nothing depends on
 * it. It is the same app Discord embeds as the activity
 * ([ADR 0047](../../../docs/adr/0047-discord-activity-presence-plane.md)):
 * one thing to start whether you are watching locally or in a voice channel.
 */
const ACTIVITY: ManagedService = {
  id: "activity",
  label: "Activity surface",
  dependsOn: [],
  ...pnpmStart("@clankie/discord-activity"),
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

/** Empty means the operator has configured no tunnel; the launcher runs none. */
function tunnelName(env: NodeJS.ProcessEnv): string {
  return env["CLANKIE_ACTIVITY_TUNNEL_NAME"]?.trim() ?? "";
}

function tunnelHostname(env: NodeJS.ProcessEnv): string {
  return env["CLANKIE_ACTIVITY_TUNNEL_HOSTNAME"]?.trim() ?? "";
}

/** The public URL Discord embeds, when one is configured. */
export function activityTunnelUrl(env: NodeJS.ProcessEnv): string | undefined {
  const hostname = tunnelHostname(env);
  return hostname.length === 0 ? undefined : `https://${hostname}`;
}

/**
 * The hop that makes the activity surface reachable from Discord.
 *
 * In the registry because it is the one part of the stack that used to be
 * started by hand, outlive every `clankie restart`, and fail silently. On
 * 2026-08-01 a six-day-old quick tunnel had a live process, a healthy local
 * server behind it, and an edge connection that had been failing for days; the
 * activity rendered blank in Discord and nothing anywhere said why. Its probe
 * is therefore end-to-end — it asks the public hostname, not the process table,
 * because "a `cloudflared` is running" was true the entire time it was broken.
 *
 * Depends on the activity surface it fronts: publishing a tunnel to a port
 * nobody is serving is how you get a 502 that looks like a Discord problem.
 */
const TUNNEL: ManagedService = {
  id: "tunnel",
  label: "Activity tunnel",
  dependsOn: ["activity"],
  command: "cloudflared",
  spawnArgs: (env) => ["tunnel", "run", tunnelName(env)],
  enabled: (env) => tunnelName(env).length > 0,
  commandMatches: (command) => command.includes("cloudflared") && command.includes("tunnel"),
  probe: async ({ env, fetchImpl, matchingPids }) => {
    if (tunnelName(env).length === 0) {
      return { state: "healthy", detail: "not configured; activity stays local" };
    }
    const url = activityTunnelUrl(env);
    if (url === undefined) {
      return { state: "unhealthy", detail: "tunnel name set with no hostname to probe" };
    }
    try {
      const response = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(4_000) });
      // Any answer at all proves the whole path: DNS, the Cloudflare edge, the
      // tunnel's control stream, and the local server behind it. A 502 means
      // the edge is up and the origin is not, which is a different repair.
      if (response.status >= 500) {
        return { state: "unhealthy", detail: `${url} → ${String(response.status)} (edge up, origin down)` };
      }
      return { state: "healthy", detail: url };
    } catch {
      return {
        state: matchingPids.length === 0 ? "unreachable" : "unhealthy",
        detail: `${url} unreachable${matchingPids.length === 0 ? "" : " despite a live cloudflared"}`,
      };
    }
  },
};

const SERVICES: Readonly<Record<ServiceId, ManagedService>> = {
  clankie: CLANKIE,
  "discord-bridge": DISCORD_BRIDGE,
  "discord-user-session": DISCORD_USER_SESSION,
  activity: ACTIVITY,
  tunnel: TUNNEL,
};

export function managedService(id: ServiceId): ManagedService {
  return SERVICES[id];
}

export type ServiceRegistryOptions = ServiceCommandOptions;

export async function restartOne(id: ServiceId, options: ServiceRegistryOptions): Promise<ServiceStatus> {
  return await restartService(managedService(id), options);
}

export async function startOne(id: ServiceId, options: ServiceRegistryOptions): Promise<ServiceStatus> {
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
 * Restarts in dependency order and stops at the first failure. Continuing past
 * a dead clankie service would only produce a bridge that cannot route a turn,
 * and a wall of downstream errors that hide the one that mattered.
 */
export async function restartTarget(
  target: ServiceTarget,
  options: ServiceRegistryOptions,
): Promise<readonly ServiceOutcome[]> {
  const outcomes: ServiceOutcome[] = [];
  for (const id of resolveRestartTargets(target)) {
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
