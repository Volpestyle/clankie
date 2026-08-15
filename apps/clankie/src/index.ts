/**
 * Composition root for the merged Clankie service: the surviving control-plane
 * surface plus the runner's in-process capabilities (play host, browser,
 * activity observation), one process, one port (4310).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { defaultGbaBodyRootDir, observeBodyHolder } from "@clankie/body-lock";
import {
  createDefaultCredentialStore,
  ensureDiscordBridgeCredential,
  ensureDiscordUserBridgeCredential,
  ensureDiscordUserVoiceBridgeCredential,
  ensureDiscordVoiceBridgeCredential,
  ensureOperatorCredential,
  ensureRunnerCredential,
} from "@clankie/credential-broker";
import { createLogger } from "@clankie/observability";
import { applyDiscordSettingsToEnvironment, SettingsStore } from "@clankie/settings";
import { createBearerAuthenticator, createClankieApp, type ClankieApp } from "./app.ts";
import { ActivityObservationProjection } from "./activity-observation.ts";
import { browserEnabled, createBrowserHost, type BrowserHost } from "./browser-host.ts";
import { createCaptain } from "./captain/captain.ts";
import { createEmailPort } from "./email.ts";
import { createLinearPort } from "./linear.ts";
import { createDiscordAttachmentResolver } from "./discord-attachment-fetch.ts";
import { loadOrCreateDeviceSessionKey } from "./device-session.ts";
import type { DiscordPresenceRuntimePort } from "./discord-presence-runtime.ts";
import { ConfiguredMediaGenerator } from "./media-generation.ts";
import { createFileMemory, defaultMemoryDir } from "./memory.ts";
import { createGbaPlayExecution } from "./play-execution.ts";
import { PlayHost, type EmbodimentClientPort, type PlayExecution } from "./play-host.ts";
import { createCredentialBackedOperatorAuthenticator } from "./operator-auth.ts";

export {
  createRunnerEnvironmentLifecycle,
  createRunnerGbaEnvironmentLifecycle,
  createRunnerMinecraftEnvironmentLifecycle,
} from "./environment-lifecycle.ts";

const logger = createLogger({ service: "clankie", version: "0.2.0" });

/**
 * The repository root, and the `.env.local` sitting in it. Absent keys only:
 * anything the launcher or the shell set deliberately wins.
 */
const repoRoot = resolve(import.meta.dirname, "../../..");
function loadRepoEnvFile(): void {
  let contents: string;
  try {
    contents = readFileSync(join(repoRoot, ".env.local"), "utf8");
  } catch {
    return;
  }
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (key.length === 0 || process.env[key] !== undefined) continue;
    const raw = trimmed.slice(separator + 1).trim();
    const unquoted =
      (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
        ? raw.slice(1, -1)
        : raw;
    process.env[key] = unquoted;
  }
}
loadRepoEnvFile();

// Fill the Discord environment from settings.json before anything reads it;
// existing environment entries win, so a deliberate override still overrides.
const settingsFilledDiscordNames = applyDiscordSettingsToEnvironment(
  (await new SettingsStore().load()).discord,
);

const stateRoot = process.env.CLANKIE_STATE?.trim() || join(homedir(), ".clankie");
const runnerStateRoot = process.env.CLANKIE_RUNNER_STATE ?? join(stateRoot, "runner");
const eventLogPath = process.env.CLANKIE_EVENT_LOG?.trim() || join(stateRoot, "events.jsonl");

const operatorCredentialStore = createDefaultCredentialStore();
await ensureOperatorCredential({ env: process.env, store: operatorCredentialStore });
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
const discordUserBridgeToken = await ensureDiscordUserBridgeCredential({
  env: process.env,
  store: operatorCredentialStore,
});
const discordUserVoiceBridgeToken = await ensureDiscordUserVoiceBridgeCredential({
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
const captainToken = process.env.CLANKIE_CAPTAIN_TOKEN;
const captainSteerSourceLane = parseCaptainSteerSourceLane(
  process.env.CLANKIE_CAPTAIN_STEER_SOURCE_LANE ?? "api",
);
const authenticateConfiguredCaptain =
  captainToken === undefined
    ? undefined
    : createBearerAuthenticator(captainToken, {
        captainId: "captain-clankie",
        steerSourceLane: captainSteerSourceLane,
      });

const deviceSessionKeyPath = process.env.CLANKIE_DEVICE_SESSION_KEY_PATH
  ? resolve(process.env.CLANKIE_DEVICE_SESSION_KEY_PATH)
  : join(stateRoot, "device-session.key");
const deviceSessionKey = await loadOrCreateDeviceSessionKey(deviceSessionKeyPath);
if (deviceSessionKey === undefined) {
  logger.warn(
    { deviceSessionKeyPath },
    "device session signing key unavailable; device pairing routes will fail closed (503)",
  );
}

const memory = createFileMemory({ dataDir: defaultMemoryDir(process.env) });

// Media he makes lands under the root the Discord attachment resolver already
// serves (ADR 0085). Without that root there is nowhere attachable to put an
// artifact, so the plane stays absent and the routes answer 503.
const attachmentRoot = process.env.CLANKIE_DISCORD_ATTACHMENT_ROOT?.trim();
const mediaGenerator =
  attachmentRoot === undefined || attachmentRoot.length === 0
    ? undefined
    : new ConfiguredMediaGenerator({
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

// Clankie's own browser (ADR 0082). On by default; a missing binary degrades
// to a logged unavailability rather than a boot failure.
let browserHost: BrowserHost | undefined;
if (browserEnabled(process.env.CLANKIE_BROWSER_ENABLED)) {
  try {
    browserHost = await createBrowserHost({
      runnerStateRoot,
      logger,
      environment: process.env,
    });
    logger.info({ event: "browser.capability.enabled" }, "in-process browser host started");
  } catch (error) {
    logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      "browser host failed to start; Clankie has no browser this run",
    );
  }
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

const activityObservations = new ActivityObservationProjection();

// The captain's tools reach the same in-process authorities the routes use.
// The app needs the captain and the captain's deps need the app, so the app
// reference binds late — tools only run inside turns, well after boot.
let clankieRef: ClankieApp | undefined;
const boundApp = (): ClankieApp => {
  if (clankieRef === undefined) throw new Error("clankie service is still booting");
  return clankieRef;
};

const connectionSettings = new SettingsStore();
const linear = createLinearPort({
  credentials: operatorCredentialStore,
  settings: connectionSettings,
});
const email = createEmailPort({
  credentials: operatorCredentialStore,
  settings: connectionSettings,
});

const captain = createCaptain(
  {
    linear,
    email,
    browser: {
      catalog: () =>
        browserHost?.catalog() ??
        Promise.resolve({
          schemaVersion: 1 as const,
          available: false,
          reason: "the browser host is not running",
          tools: [],
        }),
      call: (request) =>
        browserHost?.call(request) ??
        Promise.resolve({
          outcome: "refused" as const,
          tool: request.tool,
          reason: "browser_unavailable" as const,
        }),
    },
    media: {
      generateImage: (request) =>
        mediaGenerator?.generateImage(request) ??
        Promise.resolve({
          outcome: "refused" as const,
          schemaVersion: 1 as const,
          reason: "media_unavailable" as const,
        }),
      generateVideo: (request, room) =>
        mediaGenerator?.generateVideo(request, { room }) ??
        Promise.resolve({
          outcome: "refused" as const,
          schemaVersion: 1 as const,
          reason: "media_unavailable" as const,
        }),
      finishedRenders: (room) => mediaGenerator?.finishedRenders(room) ?? Promise.resolve([]),
    },
    embodiment: {
      submitIntent: (intent) => boundApp().embodiment.submit(intent),
      getSession: (sessionId) => Promise.resolve(boundApp().embodiment.getSession(sessionId)),
      getLiveSession: () => Promise.resolve(boundApp().embodiment.liveSession()),
      getPossession: () => {
        const holder = observeBodyHolder(defaultGbaBodyRootDir(process.env));
        return Promise.resolve(
          holder === null
            ? undefined
            : { schemaVersion: 1 as const, holderId: holder.holderId, acquiredAt: holder.acquiredAt },
        );
      },
    },
    activity: {
      current: async () => {
        const live = boundApp().embodiment.liveSession();
        if (live === undefined) return { schemaVersion: 1 as const, outcome: "not_playing" as const };
        const snapshot = await activityObservations.current();
        return snapshot === undefined
          ? {
              schemaVersion: 1 as const,
              outcome: "pending" as const,
              sessionId: live.sessionId,
              environmentId: live.environmentId,
              state: live.state,
              updatedAt: live.updatedAt,
            }
          : { schemaVersion: 1 as const, outcome: "snapshot" as const, snapshot };
      },
    },
    presence: {
      listSessions: () => Promise.resolve(boundApp().presenceSessions()),
      listVoiceHistory: (limit = 5) => Promise.resolve(boundApp().voiceHistory(limit)),
    },
    memory: {
      appendEpisode: (lane, episode) => {
        memory.recordEpisode({
          schemaVersion: 1,
          episodeId: `ep-${crypto.randomUUID()}`,
          lane,
          targetId: "self",
          summary: episode,
          // What he remembers at the console stays at the console; the
          // shareable/private gate in recall is only real if writes honor it.
          visibility: lane === "operator" ? "operator_private" : "shareable",
          provenance: {
            characterId: "clankie",
            sessionId: "captain",
            selfAuthored: true,
            rawTranscript: false,
          },
          occurredAt: new Date().toISOString(),
        });
        return Promise.resolve();
      },
      recallEpisodes: (lane) => {
        const card = memory.episodeRecallCard({ lane: lane as never });
        return Promise.resolve(card.length === 0 ? [] : [card]);
      },
      recallDiscordPerson: (identity, options) => {
        const card = memory.recallDiscordPersonCard(identity, {
          channelId: options.channelId,
          query: options.query,
        });
        return card.length === 0 ? undefined : card;
      },
    },
    resolveDiscordAttachments: createDiscordAttachmentResolver(),
  },
  { repoRoot, stateDir: join(stateRoot, "captain"), settings: connectionSettings },
);

const clankie = await createClankieApp({
  captain,
  memory,
  ...(mediaGenerator === undefined ? {} : { mediaGenerator }),
  ...(discordPresenceRuntime === undefined ? {} : { discordPresenceRuntime }),
  ...(discordUserPresenceRuntime === undefined ? {} : { discordUserPresenceRuntime }),
  ...(browserHost === undefined ? {} : { browserTools: browserHost }),
  activityObservations: {
    current: (_signal) => Promise.resolve(activityObservations.current()),
  },
  // Read-only view of the shared body lock (VUH-938); observation only.
  bodyPossession: () => {
    const holder = observeBodyHolder(defaultGbaBodyRootDir(process.env));
    return holder === null
      ? null
      : { schemaVersion: 1 as const, holderId: holder.holderId, acquiredAt: holder.acquiredAt };
  },
  ...(deviceSessionKey === undefined ? {} : { deviceSessionKey }),
  ...(runnerToken
    ? { authenticateRunner: createBearerAuthenticator(runnerToken, { runnerId: "local" }) }
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
  eventLogPath,
});
clankieRef = clankie;

// Asked embodiment (ADR 0063): the play host lives in this process now, so its
// "client" is the embodiment manager itself — the loopback died with the split.
const embodimentClient: EmbodimentClientPort = {
  claimEmbodiment: (claim) => clankie.embodiment.claim(claim),
  reportEmbodiment: async (report) => {
    const result = await clankie.embodiment.report(report);
    if (result.outcome === "rejected") throw new Error(`embodiment_${result.error}`);
    return result;
  },
  getLiveEmbodimentSession: () => Promise.resolve(clankie.embodiment.liveSession()),
};
const playHost = new PlayHost({
  client: embodimentClient,
  runnerId: "local",
  environmentIds: ["pokemon-firered", "pokemon-emerald"],
  execute: createConfiguredPlayExecution(),
  logger,
});
const playAbort = new AbortController();
void playHost.runForever(playAbort.signal).catch((error: unknown) => {
  logger.error(
    { err: error instanceof Error ? error.message : String(error) },
    "embodiment play host stopped unexpectedly",
  );
});
logger.info({ environmentIds: ["pokemon-firered", "pokemon-emerald"] }, "embodiment play host started");

const port = Number(process.env.PORT ?? 4310);
const listenHost = "127.0.0.1";
const server = serve({ fetch: clankie.app.fetch, port, hostname: listenHost });
logger.info(
  {
    hostname: listenHost,
    port,
    eventLogPath,
    memoryDir: defaultMemoryDir(process.env),
    settingsFilledDiscordNames,
  },
  "clankie listening",
);

const playShutdownDeadlineMs = parsePositiveInt(process.env.CLANKIE_PLAY_SHUTDOWN_DEADLINE_MS, 15_000);
let shutdownStarted = false;
function requestShutdown(signal: "SIGINT" | "SIGTERM"): void {
  if (shutdownStarted) return;
  shutdownStarted = true;
  const exitCode = signal === "SIGINT" ? 130 : 143;
  process.exitCode = exitCode;
  logger.info({ signal, exitCode, playShutdownDeadlineMs }, "clankie shutdown requested");
  playAbort.abort(signal);
  server.close();
  void (async () => {
    const result = await playHost.stopAndWait({ deadlineMs: playShutdownDeadlineMs, reason: signal });
    await captain.close().catch(() => undefined);
    await browserHost?.close().catch(() => undefined);
    clankie.close();
    if (result.status === "deadline_expired") {
      logger.error(
        { signal, sessionId: result.sessionId, deadlineMs: playShutdownDeadlineMs, exitCode: 1 },
        "clankie shutdown forced after asked-play deadline expired",
      );
      process.exit(1);
    }
    logger.info({ signal, exitCode, playShutdown: result.status }, "clankie shutdown settled");
  })();
}
process.on("SIGINT", () => requestShutdown("SIGINT"));
process.on("SIGTERM", () => requestShutdown("SIGTERM"));

function createConfiguredPlayExecution(): PlayExecution {
  return createGbaPlayExecution({ logger, activityObservations });
}

function parseCaptainSteerSourceLane(value: string): "discord_text" | "discord_voice" | "api" {
  if (value === "discord_text" || value === "discord_voice" || value === "api") return value;
  throw new Error("CLANKIE_CAPTAIN_STEER_SOURCE_LANE must be discord_text, discord_voice, or api");
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Loads a privileged Discord presence executor module (same contract as before the merge). */
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
