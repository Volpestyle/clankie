import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import {
  createDefaultCredentialStore,
  ensureDiscordBridgeCredential,
  ensureDiscordUserBridgeCredential,
  ensureDiscordUserVoiceBridgeCredential,
  ensureDiscordVoiceBridgeCredential,
  ensureOperatorCredential,
  ensureRunnerCredential,
} from "@clankie/credential-broker";
import { compileDoctrine, loadDoctrineFile, projectCaptainCeremony } from "@clankie/doctrine";
import { defaultGbaBodyRootDir, observeBodyHolder } from "@clankie/body-lock";
import { SqliteEventStore } from "@clankie/event-store";
import { createLogger } from "@clankie/observability";
import { MemoryStore } from "@clankie/memory-store";
import { applyDiscordSettingsToEnvironment, SettingsStore } from "@clankie/settings";
import type {
  AttentionDeliveryAdapter,
  LinearAgentRuntimePort,
  WorkspaceTrackerBinding,
} from "@clankie/tracker-connector";
import {
  createBearerAuthenticator,
  createControlPlane,
  createDeterministicWorkerSteerAuthorizer,
} from "./app.ts";
import { loadOrCreateDeviceSessionKey } from "./device-session.ts";
import { createDiscordAttachmentResolver } from "./discord-attachment-fetch.ts";
import type { DiscordPresenceRuntimePort } from "./discord-presence-runtime.ts";
import { EveCaptainChannelTurnPort } from "./eve-captain-turn.ts";
import { createCredentialBackedOperatorAuthenticator } from "./operator-auth.ts";
import { FileWorkerSteeringStore } from "./worker-steering.ts";
import { DEFAULT_RUNNER_LOOPBACK_URL, RunnerLoopback, runnerPorts } from "./runner-loopback.ts";
import { ConfiguredMediaGenerator } from "./media-generation.ts";

const logger = createLogger({ service: "clankie-control-plane", version: "0.1.0" });

/**
 * Fills the Discord environment from settings.json before anything reads it.
 *
 * The control plane, not the bridge, hosts the presence runtime module and so
 * owns the guild and channel allowlists it enforces. That module reads
 * `DISCORD_PRESENCE_*` straight from the environment, and only the bridge and
 * the user-session app were filling those from settings — each for itself. The
 * control plane therefore built its allowlists from an empty environment and
 * denied every channel, so a Discord message was accepted by the bridge,
 * answered by the captain, and then refused at the last step with
 * `discord_bot_channel_not_allowed` while settings.json plainly listed the
 * channel. Clankie simply never replied.
 *
 * Applied before the runtime module import below, since that reads the values at
 * load time. Existing environment entries win, so a deliberate override still
 * overrides.
 */
const settingsFilledDiscordNames = applyDiscordSettingsToEnvironment(
  (await new SettingsStore().load()).discord,
);
// Anchor default store paths to the repo root, not process.cwd(): the TUI mission
// observer resolves the same defaults against the repo root, so a cwd-relative
// default here silently diverges (observer "unable to open database file") whenever
// the control plane is launched from anywhere but the repo root. An explicit
// CLANKIE_EVENT_STORE / CLANKIE_MEMORY_STORE still overrides.
const repoRoot = resolve(import.meta.dirname, "../../..");
const defaultDoctrinePath = join(repoRoot, "doctrine/profiles/self-build-lab.yaml");
const doctrinePath = process.env.CLANKIE_DOCTRINE
  ? resolve(process.env.CLANKIE_DOCTRINE)
  : defaultDoctrinePath;
const doctrine = compileDoctrine([await loadDoctrineFile(doctrinePath)]);
const eventStorePath = resolve(
  process.env.CLANKIE_EVENT_STORE ?? join(repoRoot, "artifacts/control-plane/events.db"),
);
const eventStore = new SqliteEventStore(eventStorePath);
const memoryStorePath = resolve(
  process.env.CLANKIE_MEMORY_STORE ?? join(repoRoot, "artifacts/control-plane/memory.db"),
);
const memoryStore = new MemoryStore(memoryStorePath, {
  doctrine: doctrine.profile.memory,
});
const captainToken = process.env.CLANKIE_CAPTAIN_TOKEN;
const captainSteerSourceLane = parseCaptainSteerSourceLane(
  process.env.CLANKIE_CAPTAIN_STEER_SOURCE_LANE ?? "api",
);
const operatorCredentialStore = createDefaultCredentialStore();
await ensureOperatorCredential({ env: process.env, store: operatorCredentialStore });
// Env wins when deliberately set (tests, split deployments) — then it must be
// set for the runner too. Otherwise the broker-owned bearer applies, so a
// restart from a token-less shell can never silently lose the runner plane
// again: three separate outages in one evening taught this line its shape.
const runnerToken =
  process.env.CLANKIE_RUNNER_TOKEN ??
  (await ensureRunnerCredential({ env: process.env, store: operatorCredentialStore }));
const discordBridgeToken = await ensureDiscordBridgeCredential({
  env: process.env,
  store: operatorCredentialStore,
});
const discordVoiceBridgeToken = await ensureDiscordVoiceBridgeCredential({
  env: process.env,
  store: operatorCredentialStore,
});
const authenticateDiscordBridge = createBearerAuthenticator(discordBridgeToken, {
  captainId: "discord-bridge",
  steerSourceLane: "discord_text" as const,
  discordTransportKind: "bot" as const,
});
const authenticateDiscordVoiceBridge = createBearerAuthenticator(discordVoiceBridgeToken, {
  captainId: "discord-voice-bridge",
  steerSourceLane: "discord_voice" as const,
  discordTransportKind: "bot" as const,
});
// The user-session plane holds its own bearers so `transportKind` is proven by
// authentication rather than asserted in a request body (ADR 0048).
const discordUserBridgeToken = await ensureDiscordUserBridgeCredential({
  env: process.env,
  store: operatorCredentialStore,
});
const discordUserVoiceBridgeToken = await ensureDiscordUserVoiceBridgeCredential({
  env: process.env,
  store: operatorCredentialStore,
});
const authenticateDiscordUserBridge = createBearerAuthenticator(discordUserBridgeToken, {
  captainId: "discord-user-bridge",
  steerSourceLane: "discord_text" as const,
  discordTransportKind: "user_session" as const,
});
const authenticateDiscordUserVoiceBridge = createBearerAuthenticator(discordUserVoiceBridgeToken, {
  captainId: "discord-user-voice-bridge",
  steerSourceLane: "discord_voice" as const,
  discordTransportKind: "user_session" as const,
});
const authenticateConfiguredCaptain =
  captainToken === undefined
    ? undefined
    : createBearerAuthenticator(captainToken, {
        captainId: "captain-eve",
        steerSourceLane: captainSteerSourceLane,
      });
const deviceSessionKeyPath = process.env.CLANKIE_DEVICE_SESSION_KEY_PATH
  ? resolve(process.env.CLANKIE_DEVICE_SESSION_KEY_PATH)
  : join(dirname(eventStorePath), "device-session.key");
const deviceSessionKey = await loadOrCreateDeviceSessionKey(deviceSessionKeyPath);
if (deviceSessionKey === undefined) {
  logger.warn(
    { deviceSessionKeyPath },
    "device session signing key unavailable; device pairing routes will fail closed (503)",
  );
}
const runnerId = process.env.CLANKIE_RUNNER_ID ?? "local";
const linearAgentRuntime = await loadLinearAgentRuntime(process.env.CLANKIE_LINEAR_AGENT_RUNTIME_MODULE);
const linearAttentionRuntime = await loadLinearAttentionRuntime(
  process.env.CLANKIE_LINEAR_ATTENTION_RUNTIME_MODULE,
);
if (
  linearAgentRuntime !== undefined &&
  projectCaptainCeremony(doctrine).humanAttention.enabled &&
  linearAttentionRuntime === undefined
) {
  throw new Error(
    "CLANKIE_LINEAR_ATTENTION_RUNTIME_MODULE is required when the Linear agent runtime and human-attention ceremony are enabled",
  );
}
const discordPresenceRuntime = await loadDiscordPresenceRuntime(
  process.env.CLANKIE_DISCORD_PRESENCE_RUNTIME_MODULE,
  "createDiscordPresenceRuntime",
  "CLANKIE_DISCORD_PRESENCE_RUNTIME_MODULE",
);
const discordUserPresenceRuntime = await loadDiscordPresenceRuntime(
  process.env.CLANKIE_DISCORD_USER_PRESENCE_RUNTIME_MODULE,
  "createDiscordUserPresenceRuntime",
  "CLANKIE_DISCORD_USER_PRESENCE_RUNTIME_MODULE",
);
const captainChannelTurns = new EveCaptainChannelTurnPort({
  baseUrl: process.env.CLANKIE_CAPTAIN_URL ?? "http://127.0.0.1:4321",
  ceremonyProjection: projectCaptainCeremony(doctrine),
  ...(captainToken === undefined ? {} : { captainToken }),
  recallDiscordPerson: (identity, options) =>
    memoryStore.recallDiscordPersonCard(identity, {
      ...options,
      now: new Date(),
    }),
  resolveDiscordAttachments: createDiscordAttachmentResolver(),
});
// Media he makes lands under the root the Discord attachment resolver already
// serves (ADR 0085), so a picture is attachable without a second copy or a
// second trust boundary. Without that root configured there is nowhere to put
// an artifact that anything else could read, so the plane stays absent and the
// routes answer 503 rather than writing somewhere unreachable.
const attachmentRoot = process.env.CLANKIE_DISCORD_ATTACHMENT_ROOT?.trim();
const mediaGenerator =
  attachmentRoot === undefined || attachmentRoot.length === 0
    ? undefined
    : new ConfiguredMediaGenerator({
        doctrine,
        credentials: operatorCredentialStore,
        attachmentRoot: resolve(attachmentRoot),
        configCwd: repoRoot,
      });
if (mediaGenerator === undefined) {
  logger.warn(
    { event: "media.unavailable" },
    "CLANKIE_DISCORD_ATTACHMENT_ROOT is unset; image and video generation are unavailable",
  );
}

const app = await createControlPlane({
  doctrine,
  eventStore,
  memoryStore,
  ...(mediaGenerator === undefined ? {} : { mediaGenerator }),
  // Read-only view of the shared body lock (VUH-938): the one authority that
  // sees every suitor for the body, including MCP possessors the embodiment
  // registry never hears about. Observation only — never acquires or releases.
  bodyPossession: () => {
    const holder = observeBodyHolder(defaultGbaBodyRootDir(process.env));
    return holder === null
      ? null
      : { schemaVersion: 1 as const, holderId: holder.holderId, acquiredAt: holder.acquiredAt };
  },
  workerSteeringStore: new FileWorkerSteeringStore(`${eventStorePath}.steering.json`),
  authorizeWorkerSteer: createDeterministicWorkerSteerAuthorizer(),
  ...(deviceSessionKey === undefined ? {} : { deviceSessionKey }),
  ...(linearAgentRuntime === undefined
    ? {}
    : {
        linearAgentRuntime,
      }),
  captainChannelTurns,
  ...(linearAttentionRuntime === undefined
    ? {}
    : {
        workspaceBindingResolver: linearAttentionRuntime.bindingResolver,
        attentionDeliveryAdapter: linearAttentionRuntime.adapter,
      }),
  ...(discordPresenceRuntime === undefined ? {} : { discordPresenceRuntime }),
  ...(discordUserPresenceRuntime === undefined ? {} : { discordUserPresenceRuntime }),
  ...(process.env.CLANKIE_REPO_PATH ? { workspacePath: process.env.CLANKIE_REPO_PATH } : {}),
  ...(runnerToken
    ? {
        authenticateRunner: createBearerAuthenticator(runnerToken, { runnerId }),
        ...runnerPorts(
          new RunnerLoopback({
            baseUrl: process.env.CLANKIE_RUNNER_LOOPBACK_URL ?? DEFAULT_RUNNER_LOOPBACK_URL,
            token: runnerToken,
          }),
        ),
      }
    : {}),
  authenticateCaptain: async (request) =>
    (await authenticateDiscordBridge(request)) ??
    (await authenticateDiscordVoiceBridge(request)) ??
    (await authenticateDiscordUserBridge(request)) ??
    (await authenticateDiscordUserVoiceBridge(request)) ??
    (authenticateConfiguredCaptain === undefined ? undefined : await authenticateConfiguredCaptain(request)),
  authenticateOperator: createCredentialBackedOperatorAuthenticator({
    env: process.env,
    store: operatorCredentialStore,
    identity: {
      operatorId: process.env.CLANKIE_OPERATOR_ID ?? "local-operator",
      steerSourceLane: "tui",
    },
  }),
});
const port = Number(process.env.PORT ?? 4310);
const hostname = "127.0.0.1";
serve({ fetch: app.fetch, port, hostname });
logger.info(
  {
    hostname,
    port,
    profileHash: doctrine.profileHash,
    eventStorePath,
    memoryStorePath,
    // Names only, never values: which allowlists came from settings.json rather
    // than the shell is exactly what was invisible when every channel was denied.
    settingsFilledDiscordNames,
  },
  "control plane listening",
);

function parseCaptainSteerSourceLane(value: string): "discord_text" | "discord_voice" | "api" {
  if (value === "discord_text" || value === "discord_voice" || value === "api") return value;
  throw new Error("CLANKIE_CAPTAIN_STEER_SOURCE_LANE must be discord_text, discord_voice, or api");
}

async function loadLinearAgentRuntime(
  modulePath: string | undefined,
): Promise<LinearAgentRuntimePort | undefined> {
  if (modulePath === undefined) return undefined;
  const loaded: unknown = await import(pathToFileURL(resolve(modulePath)).href);
  if (!isRecord(loaded) || typeof loaded.createLinearAgentRuntime !== "function") {
    throw new Error("CLANKIE_LINEAR_AGENT_RUNTIME_MODULE must export createLinearAgentRuntime()");
  }
  const runtime: unknown = await loaded.createLinearAgentRuntime();
  if (
    !isRecord(runtime) ||
    typeof runtime.readThread !== "function" ||
    typeof runtime.writeNarrative !== "function"
  ) {
    throw new Error("createLinearAgentRuntime() returned an invalid runtime port");
  }
  return runtime as unknown as LinearAgentRuntimePort;
}

/**
 * Loads a privileged Discord presence executor. Both transports use the same
 * module contract and differ only in factory name and environment variable, so
 * the user-session plane inherits the bot plane's isolation properties.
 */
async function loadDiscordPresenceRuntime(
  modulePath: string | undefined,
  factoryName: string,
  environmentVariable: string,
): Promise<DiscordPresenceRuntimePort | undefined> {
  if (modulePath === undefined) return undefined;
  const loaded: unknown = await import(pathToFileURL(resolve(modulePath)).href);
  if (!isRecord(loaded) || typeof loaded[factoryName] !== "function") {
    throw new Error(`${environmentVariable} must export ${factoryName}()`);
  }
  const runtime: unknown = await (loaded[factoryName] as () => unknown)();
  if (!isRecord(runtime) || typeof runtime.execute !== "function") {
    throw new Error(`${factoryName}() returned an invalid runtime port`);
  }
  return runtime as unknown as DiscordPresenceRuntimePort;
}

interface LinearAttentionRuntimeModule {
  readonly bindingResolver: { resolve(workspaceId: string): WorkspaceTrackerBinding | undefined };
  readonly adapter: AttentionDeliveryAdapter;
}

async function loadLinearAttentionRuntime(
  modulePath: string | undefined,
): Promise<LinearAttentionRuntimeModule | undefined> {
  if (modulePath === undefined) return undefined;
  const loaded: unknown = await import(pathToFileURL(resolve(modulePath)).href);
  if (!isRecord(loaded) || typeof loaded.createLinearAttentionRuntime !== "function") {
    throw new Error("CLANKIE_LINEAR_ATTENTION_RUNTIME_MODULE must export createLinearAttentionRuntime()");
  }
  const runtime: unknown = await loaded.createLinearAttentionRuntime();
  if (
    !isRecord(runtime) ||
    !isRecord(runtime.bindingResolver) ||
    typeof runtime.bindingResolver.resolve !== "function" ||
    !isRecord(runtime.adapter) ||
    typeof runtime.adapter.attempt !== "function"
  ) {
    throw new Error("createLinearAttentionRuntime() returned an invalid runtime port");
  }
  return runtime as unknown as LinearAttentionRuntimeModule;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
