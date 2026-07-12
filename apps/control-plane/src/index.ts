import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { compileDoctrine, loadDoctrineFile } from "@clankie/doctrine";
import { SqliteEventStore } from "@clankie/event-store";
import { createLogger } from "@clankie/observability";
import type { LinearAgentRuntimePort } from "@clankie/tracker-connector";
import {
  createBearerAuthenticator,
  createControlPlane,
  createDeterministicWorkerSteerAuthorizer,
} from "./app.ts";
import type { DiscordPresenceRuntimePort } from "./discord-presence-runtime.ts";
import { EveCaptainChannelTurnPort } from "./eve-captain-turn.ts";
import { FileWorkerSteeringStore } from "./worker-steering.ts";

const logger = createLogger({ service: "clankie-control-plane", version: "0.1.0" });
const defaultDoctrinePath = resolve(import.meta.dirname, "../../../doctrine/profiles/self-build-lab.yaml");
const doctrinePath = process.env.CLANKIE_DOCTRINE
  ? resolve(process.env.CLANKIE_DOCTRINE)
  : defaultDoctrinePath;
const doctrine = compileDoctrine([await loadDoctrineFile(doctrinePath)]);
const eventStorePath = resolve(process.env.CLANKIE_EVENT_STORE ?? "artifacts/control-plane/events.db");
const eventStore = new SqliteEventStore(eventStorePath);
const runnerToken = process.env.CLANKIE_RUNNER_TOKEN;
const captainToken = process.env.CLANKIE_CAPTAIN_TOKEN;
const operatorToken = process.env.CLANKIE_OPERATOR_TOKEN;
const runnerId = process.env.CLANKIE_RUNNER_ID ?? "local";
const captainSteerSourceLane = parseCaptainSteerSourceLane(
  process.env.CLANKIE_CAPTAIN_STEER_SOURCE_LANE ?? "api",
);
const linearAgentRuntime = await loadLinearAgentRuntime(process.env.CLANKIE_LINEAR_AGENT_RUNTIME_MODULE);
const discordPresenceRuntime = await loadDiscordPresenceRuntime(
  process.env.CLANKIE_DISCORD_PRESENCE_RUNTIME_MODULE,
);
const app = await createControlPlane({
  doctrine,
  eventStore,
  workerSteeringStore: new FileWorkerSteeringStore(`${eventStorePath}.steering.json`),
  authorizeWorkerSteer: createDeterministicWorkerSteerAuthorizer(),
  ...(linearAgentRuntime === undefined
    ? {}
    : {
        linearAgentRuntime,
        captainChannelTurns: new EveCaptainChannelTurnPort({
          baseUrl: process.env.CLANKIE_CAPTAIN_URL ?? "http://127.0.0.1:4321",
        }),
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
  ...(operatorToken
    ? {
        authenticateOperator: createBearerAuthenticator(operatorToken, {
          operatorId: process.env.CLANKIE_OPERATOR_ID ?? "local-operator",
          steerSourceLane: "tui",
        }),
      }
    : {}),
});
const port = Number(process.env.PORT ?? 4310);
const hostname = "127.0.0.1";
serve({ fetch: app.fetch, port, hostname });
logger.info({ hostname, port, profileHash: doctrine.profileHash, eventStorePath }, "control plane listening");

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
    throw new Error(
      "CLANKIE_DISCORD_PRESENCE_RUNTIME_MODULE must export createDiscordPresenceRuntime()",
    );
  }
  const runtime: unknown = await loaded.createDiscordPresenceRuntime();
  if (!isRecord(runtime) || typeof runtime.execute !== "function") {
    throw new Error("createDiscordPresenceRuntime() returned an invalid runtime port");
  }
  return runtime as unknown as DiscordPresenceRuntimePort;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
