import { existsSync } from "node:fs";
import { join } from "node:path";
import { parsePositiveInt, resolveDiscordActiveBody } from "@clankie/settings";
import {
  ensureCaptainCredential,
  resolveOperatorCredential,
  type CredentialStore,
} from "@clankie/credential-broker";
import {
  pickPresenceSession,
  PRESENCE_STATUS_PATH,
  PresenceStatusSchema,
} from "../src/observation/presence-status.ts";
import { DEFAULT_CONTROL_PLANE_URL } from "./pairing-offer.ts";
import {
  inspectService,
  SERVICE_ORDER,
  startService,
  stopService,
  type ManagedService,
  type ServiceCommandOptions,
  type ServiceId,
  type ServiceStatus,
} from "./service-supervisor.ts";

/**
 * The long-lived processes that make Clankie present:
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
  relay: "relay",
  "app-relay": "relay",
  phone: "relay",
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
function workspaceStart(
  pkg: string,
  installedEntrypoint: string,
): Pick<ManagedService, "spawnArgs" | "resolveProcess" | "commandMatches"> {
  const argv = ["--filter", pkg, "start"];
  const spawnShape = argv.join(" ");
  return {
    spawnArgs: argv,
    resolveProcess: ({ repoRoot }) => {
      const entrypoint = join(repoRoot, installedEntrypoint);
      const node = join(repoRoot, "libexec", "node");
      return existsSync(node) && existsSync(entrypoint)
        ? { command: node, args: [entrypoint] }
        : { command: "pnpm", args: argv };
    },
    commandMatches: (command) =>
      command.includes(spawnShape) ||
      (command.includes("/libexec/node ") && command.includes(`/${installedEntrypoint}`)),
  };
}

function runtimeModule(repoRoot: string, app: "discord-bridge" | "discord-user-session"): string {
  const compiled = join(repoRoot, "apps", app, "src", "presence-runtime-module.js");
  return existsSync(compiled) ? compiled : join(repoRoot, "apps", app, "src", "presence-runtime-module.ts");
}

export function parseServiceTarget(raw: string | undefined): ServiceTarget {
  if (raw === undefined || raw.length === 0) return "all";
  const target = TARGET_ALIASES[raw.toLowerCase()];
  if (target === undefined) {
    throw new Error(
      `Unknown service "${raw}". Expected one of: all, clankie, relay, discord, user-session, activity, tunnel (aliases: captain, eve, cp, control-plane, app-relay, phone, bridge, lab, watch, viewer, cloudflared).`,
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
 * Stopping is deliberately untouched: naming one service to stop is an
 * instruction to stop that service.
 */
export function resolveRestartTargets(target: ServiceTarget): readonly ServiceId[] {
  if (target === "all") return SERVICE_ORDER;
  const affected = new Set<ServiceId>([target]);
  if (target === "discord-bridge" || target === "discord-user-session") {
    affected.add("discord-bridge");
    affected.add("discord-user-session");
  }
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

const DEFAULT_PLAY_SHUTDOWN_DEADLINE_MS = 15_000;
const PLAY_SHUTDOWN_SUPERVISOR_CUSHION_MS = 2_000;

export function clankieStopGraceMs(env: NodeJS.ProcessEnv): number {
  return (
    parsePositiveInt(env.CLANKIE_PLAY_SHUTDOWN_DEADLINE_MS, DEFAULT_PLAY_SHUTDOWN_DEADLINE_MS) +
    PLAY_SHUTDOWN_SUPERVISOR_CUSHION_MS
  );
}

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
    const session = pickPresenceSession(parsed.data);
    if (session === undefined) return "no presence session";
    const voice = session.voiceGuildCount > 0 ? `, voice in ${String(session.voiceGuildCount)}` : "";
    return `session ${session.phase}${voice}`;
  } catch {
    // Presence detail is decoration on top of process health; never fail on it.
    return undefined;
  }
}

/**
 * The single clankie service. A checkout runs it through pnpm; an installed
 * release runs its bundled entrypoint with its bundled Node. `/health`
 * answering on its port is what "up" means.
 */
const CLANKIE: ManagedService = {
  id: "clankie",
  label: "Clankie",
  ...workspaceStart("@clankie/clankie", "apps/clankie/src/index.js"),
  // Match the service's listen port, not a potentially remote probe URL.
  conflictingPids: ({ env, matchingPids, listPortOwners }) =>
    listPortOwners(Number(env.PORT ?? "4310")) ?? matchingPids,
  stopGraceMs: clankieStopGraceMs,
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
      env.CLANKIE_DISCORD_PRESENCE_RUNTIME_MODULE ?? runtimeModule(repoRoot, "discord-bridge"),
    CLANKIE_DISCORD_USER_PRESENCE_RUNTIME_MODULE:
      env.CLANKIE_DISCORD_USER_PRESENCE_RUNTIME_MODULE ?? runtimeModule(repoRoot, "discord-user-session"),
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

/** 4320 belongs to the activity surface; the relay's canonical port is 4321. */
function relayPort(env: NodeJS.ProcessEnv): string {
  return env["CLANKIE_RELAY_PORT"]?.trim() || "4321";
}

/**
 * The HTTP boundary remote Apple clients speak (ADR 0135/0138). In the
 * registry because it was the last hand-run member of the stack: a phone
 * would pair against a healthy control plane and then find nobody listening
 * on the relay side. It authorizes each device request against the clankie
 * service and uses the brokered captain bearer for the upstream hop, so it
 * restarts with the service.
 */
const RELAY: ManagedService = {
  id: "relay",
  label: "App relay",
  ...workspaceStart("@clankie/relay", "apps/relay/src/index.js"),
  conflictingPids: ({ env, matchingPids, listPortOwners }) =>
    listPortOwners(Number(relayPort(env))) ?? matchingPids,
  restartsWith: ["clankie"],
  serviceEnv: ({ env, captainToken }) => ({
    ...env,
    CLANKIE_RELAY_PORT: relayPort(env),
    ...(captainToken === undefined ? {} : { CLANKIE_CAPTAIN_TOKEN: captainToken }),
  }),
  probe: async ({ env, fetchImpl }) => {
    const port = relayPort(env);
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/health`, {
        redirect: "error",
        signal: AbortSignal.timeout(750),
      });
      return response.ok
        ? { state: "healthy", detail: `devices on 127.0.0.1:${port}` }
        : { state: "unhealthy" };
    } catch {
      return { state: "unreachable" };
    }
  },
};

const DISCORD_BRIDGE: ManagedService = {
  id: "discord-bridge",
  label: "Discord bridge",
  ...workspaceStart("@clankie/discord-bridge", "apps/discord-bridge/src/index.js"),
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
  ...workspaceStart("@clankie/discord-user-session", "apps/discord-user-session/src/index.js"),
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
        env.CLANKIE_DISCORD_USER_PRESENCE_RUNTIME_MODULE ?? runtimeModule(repoRoot, "discord-user-session"),
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
  ...workspaceStart("@clankie/discord-activity", "apps/discord-activity/src/index.js"),
  conflictingPids: ({ env, matchingPids, listPortOwners }) => [
    ...(listPortOwners(Number(env.CLANKIE_ACTIVITY_PORT ?? "4320")) ?? matchingPids),
    ...(listPortOwners(Number(env.CLANKIE_ACTIVITY_PRODUCER_PORT ?? "4322")) ?? matchingPids),
  ],
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
function activityTunnelUrl(env: NodeJS.ProcessEnv): string | undefined {
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
  command: "cloudflared",
  spawnArgs: (env) => ["tunnel", "run", tunnelName(env)],
  enabled: (env) => tunnelName(env).length > 0,
  commandMatches: (command) => command.includes("cloudflared") && command.includes("tunnel"),
  conflictingPids: ({ env, matchingPids, readProcessCommand }) => {
    const name = tunnelName(env);
    if (name.length === 0) return [];
    return matchingPids.filter((pid) => {
      const command = readProcessCommand(pid);
      const named = /\btunnel\b.*?\brun\s+(\S+)\s*$/u.exec(command)?.[1];
      // Unknown/manual invocation shapes stay conservative. The registry's
      // named form lets an unrelated tunnel coexist with this one.
      return named === undefined || named.startsWith("-") || /\s/u.test(name) || named === name;
    });
  },
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
  relay: RELAY,
  "discord-bridge": DISCORD_BRIDGE,
  "discord-user-session": DISCORD_USER_SESSION,
  activity: ACTIVITY,
  tunnel: TUNNEL,
};

export function managedService(id: ServiceId): ManagedService {
  return SERVICES[id];
}

export type ServiceRegistryOptions = ServiceCommandOptions;

type Writable = { write(chunk: string): unknown };

export interface CreateServiceOptionsInput {
  readonly repoRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly operatorCredentialStore?: CredentialStore;
  readonly captainCredentialStore?: CredentialStore;
  readonly listProcessCommandsImpl?: ServiceRegistryOptions["listProcessCommandsImpl"];
  readonly spawnImpl?: ServiceRegistryOptions["spawnImpl"];
  readonly killImpl?: ServiceRegistryOptions["killImpl"];
  readonly processIsAliveImpl?: ServiceRegistryOptions["processIsAliveImpl"];
  readonly readProcessCommandImpl?: ServiceRegistryOptions["readProcessCommandImpl"];
  readonly stderr?: Writable;
}

/** Shared credential and process seams for every launcher service command. */
export async function createServiceOptions(
  input: CreateServiceOptionsInput,
): Promise<ServiceRegistryOptions> {
  const env = input.env ?? process.env;
  let operatorToken: string | undefined;
  try {
    const credential = await resolveOperatorCredential({
      env,
      ...(input.operatorCredentialStore === undefined ? {} : { store: input.operatorCredentialStore }),
    });
    operatorToken = credential?.token;
  } catch {
    operatorToken = undefined;
  }
  let captainToken: string | undefined;
  try {
    const credential = await ensureCaptainCredential({
      env,
      ...(input.captainCredentialStore === undefined ? {} : { store: input.captainCredentialStore }),
    });
    captainToken = credential.token;
  } catch {
    captainToken = undefined;
  }
  const stderr = input.stderr ?? process.stderr;
  return {
    repoRoot: input.repoRoot,
    env,
    fetchImpl: input.fetchImpl ?? fetch,
    operatorToken,
    captainToken,
    ...(input.listProcessCommandsImpl === undefined
      ? {}
      : { listProcessCommandsImpl: input.listProcessCommandsImpl }),
    ...(input.spawnImpl === undefined ? {} : { spawnImpl: input.spawnImpl }),
    ...(input.killImpl === undefined ? {} : { killImpl: input.killImpl }),
    ...(input.processIsAliveImpl === undefined ? {} : { processIsAliveImpl: input.processIsAliveImpl }),
    ...(input.readProcessCommandImpl === undefined
      ? {}
      : { readProcessCommandImpl: input.readProcessCommandImpl }),
    onStatus: (status: string) => stderr.write(`${status}\n`),
  };
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
 * Stops the whole restart set in reverse order before starting it forwards.
 * The two Discord bodies are one mutually-exclusive slot: both are stopped,
 * then only the body selected by the current environment is started.
 */
export async function restartTarget(
  target: ServiceTarget,
  options: ServiceRegistryOptions,
): Promise<readonly ServiceOutcome[]> {
  const ids = resolveRestartTargets(target);
  const stopFailures: ServiceOutcome[] = [];
  for (const id of [...ids].reverse()) {
    try {
      await stopService(managedService(id), options);
    } catch (error) {
      stopFailures.push(failureFrom(id, error));
    }
  }
  if (stopFailures.length > 0) return stopFailures;

  const outcomes: ServiceOutcome[] = [];
  const env = options.env ?? process.env;
  for (const id of ids) {
    const service = managedService(id);
    if (service.enabled?.(env) === false) continue;
    try {
      outcomes.push(outcomeFrom(await startService(service, options)));
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
