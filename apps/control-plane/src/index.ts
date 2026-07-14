import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { createDefaultCredentialStore, ensureOperatorCredential } from "@clankie/credential-broker";
import { compileDoctrine, loadDoctrineFile, projectCaptainCeremony } from "@clankie/doctrine";
import { SqliteEventStore } from "@clankie/event-store";
import { createLogger } from "@clankie/observability";
import { MemoryStore } from "@clankie/memory-store";
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
import type { DiscordPresenceRuntimePort } from "./discord-presence-runtime.ts";
import { EveCaptainChannelTurnPort } from "./eve-captain-turn.ts";
import { createCredentialBackedOperatorAuthenticator } from "./operator-auth.ts";
import { FileWorkerSteeringStore } from "./worker-steering.ts";

const logger = createLogger({ service: "clankie-control-plane", version: "0.1.0" });
const defaultDoctrinePath = resolve(import.meta.dirname, "../../../doctrine/profiles/self-build-lab.yaml");
const doctrinePath = process.env.CLANKIE_DOCTRINE
  ? resolve(process.env.CLANKIE_DOCTRINE)
  : defaultDoctrinePath;
const doctrine = compileDoctrine([await loadDoctrineFile(doctrinePath)]);
const eventStorePath = resolve(process.env.CLANKIE_EVENT_STORE ?? "artifacts/control-plane/events.db");
const eventStore = new SqliteEventStore(eventStorePath);
const memoryStorePath = resolve(process.env.CLANKIE_MEMORY_STORE ?? "artifacts/control-plane/memory.db");
const memoryStore = new MemoryStore(memoryStorePath, {
  doctrine: doctrine.profile.memory,
});
const runnerToken = process.env.CLANKIE_RUNNER_TOKEN;
const captainToken = process.env.CLANKIE_CAPTAIN_TOKEN;
const operatorCredentialStore = createDefaultCredentialStore();
await ensureOperatorCredential({ env: process.env, store: operatorCredentialStore });
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
const captainSteerSourceLane = parseCaptainSteerSourceLane(
  process.env.CLANKIE_CAPTAIN_STEER_SOURCE_LANE ?? "api",
);
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
);
const captainChannelTurns = new EveCaptainChannelTurnPort({
  baseUrl: process.env.CLANKIE_CAPTAIN_URL ?? "http://127.0.0.1:4321",
  ceremonyProjection: projectCaptainCeremony(doctrine),
  ...(captainToken === undefined ? {} : { captainToken }),
});
const app = await createControlPlane({
  doctrine,
  eventStore,
  memoryStore,
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
  ...(process.env.CLANKIE_REPO_PATH ? { workspacePath: process.env.CLANKIE_REPO_PATH } : {}),
  ...(runnerToken
    ? {
        authenticateRunner: createBearerAuthenticator(runnerToken, { runnerId }),
      }
    : {}),
  ...(captainToken
    ? {
        authenticateCaptain: createBearerAuthenticator(captainToken, {
          captainId: "captain-eve",
          steerSourceLane: captainSteerSourceLane,
        }),
      }
    : {}),
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
  { hostname, port, profileHash: doctrine.profileHash, eventStorePath, memoryStorePath },
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

async function loadDiscordPresenceRuntime(
  modulePath: string | undefined,
): Promise<DiscordPresenceRuntimePort | undefined> {
  if (modulePath === undefined) return undefined;
  const loaded: unknown = await import(pathToFileURL(resolve(modulePath)).href);
  if (!isRecord(loaded) || typeof loaded.createDiscordPresenceRuntime !== "function") {
    throw new Error("CLANKIE_DISCORD_PRESENCE_RUNTIME_MODULE must export createDiscordPresenceRuntime()");
  }
  const runtime: unknown = await loaded.createDiscordPresenceRuntime();
  if (!isRecord(runtime) || typeof runtime.execute !== "function") {
    throw new Error("createDiscordPresenceRuntime() returned an invalid runtime port");
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
