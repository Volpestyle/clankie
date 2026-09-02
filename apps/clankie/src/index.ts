/**
 * Composition root for the merged Clankie service: the surviving control-plane
 * surface plus its in-process capabilities (play host, browser,
 * activity observation), one process, one port (4310).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { serve, type WebSocketServerLike } from "@hono/node-server";
import {
  MAX_REALTIME_AUDIO_APPEND_BYTES,
  createVoiceRealtimePorts,
  parseVoiceRealtimeEnv,
} from "@clankie/discord-presence-core";
import { defaultGbaPlayJournalDir } from "@clankie/play";
import {
  createDefaultCredentialStore,
  createClankieAccountTokenProvider,
  derivePublicGatewayHostId,
  ensureDiscordBridgeCredential,
  ensureDiscordUserBridgeCredential,
  ensureDiscordUserVoiceBridgeCredential,
  ensureDiscordVoiceBridgeCredential,
  ensureOperatorCredential,
  resolvePublicGatewayCredential,
} from "@clankie/credential-broker";
import { createLogger } from "@clankie/observability";
import {
  applyDiscordSettingsToEnvironment,
  applyRelaySettingsToEnvironment,
  applyVoiceSettingsToEnvironment,
  discordAttachmentRoot,
  parsePositiveInt,
  SettingsStore,
} from "@clankie/settings";
import { WebSocketServer } from "ws";
import { createBearerAuthenticator, createClankieApp, type ClankieApp } from "./app.ts";
import { pinHerdrSessionEnvironment } from "./herdr-session.ts";
import { ActivityObservationProjection } from "./activity-observation.ts";
import { PlaySightProjection } from "./play-sight.ts";
import { HostedWorldSession } from "./world/session.ts";
import { browserEnabled, createBrowserHost, type BrowserHost } from "./browser-host.ts";
import { createTldrawHost, tldrawEnabled, type TldrawHost } from "./tldraw-host.ts";
import { createCaptain } from "./captain/captain.ts";
import { createDiscordMusicClient } from "./discord-music.ts";
import { createDiscordCaptainActionClient } from "./discord-captain-actions.ts";
import { createDiscordVoicePresenceClient } from "./discord-voice-presence.ts";
import { createEmailPort } from "./email.ts";
import { createMcpHost } from "./mcp-host.ts";
import { createDiscordAttachmentResolver } from "./discord-attachment-fetch.ts";
import { loadOrCreateDeviceSessionKey } from "./device-session.ts";
import type { DiscordPresenceRuntimePort } from "./discord-presence-runtime.ts";
import { ConfiguredMediaGenerator } from "./media-generation.ts";
import { createFileMemory, defaultMemoryDir } from "./memory.ts";
import { createWorldPlayExecution } from "./play-execution-world.ts";
import { PlayHost, type EmbodimentClientPort, type PlayExecution } from "./play-host.ts";
import { createCredentialBackedOperatorAuthenticator } from "./operator-auth.ts";
import { applyRepoProviderEnvironment } from "./repo-environment.ts";
import { PublicGatewayConnector } from "./public-gateway-connector.ts";

const logger = createLogger({ service: "clankie", version: "0.2.0" });

/**
 * Provider API-key compatibility fallbacks from the root `.env.local`.
 * Broker-owned credentials and runtime configuration never enter process.env
 * through this file; anything the launcher or shell set deliberately wins.
 */
const repoRoot = resolve(import.meta.dirname, "../../..");
function loadRepoEnvFile(): void {
  let contents: string;
  try {
    contents = readFileSync(join(repoRoot, ".env.local"), "utf8");
  } catch {
    return;
  }
  applyRepoProviderEnvironment(contents, process.env);
}
loadRepoEnvFile();

// Fill the Discord environment from settings.json before anything reads it;
// existing environment entries win, so a deliberate override still overrides.
// Keep the pre-projection environment for captain authorization: those grants
// reload from settings on every turn, and values copied out of the same file at
// boot are not real environment overrides.
const captainDiscordEnvironment = { ...process.env };
const settingsStore = new SettingsStore();
const startupSettings = await settingsStore.load();
const settingsFilledNames = [
  ...applyDiscordSettingsToEnvironment(startupSettings.discord),
  ...applyVoiceSettingsToEnvironment(startupSettings.voice),
  ...applyRelaySettingsToEnvironment(startupSettings.relay),
];

// Which herdr session he leads is chosen in settings, never inherited from
// wherever this process was launched (ADR 0149).
const herdrSessionPin = await pinHerdrSessionEnvironment(startupSettings.herdr.session);
if (herdrSessionPin.outcome === "unknown_session") {
  logger.warn(
    { event: "herdr.session.unknown", session: herdrSessionPin.session },
    "configured herdr session not found; herdr commands fall back to the default session",
  );
}

const stateRoot = process.env.CLANKIE_STATE?.trim() || join(homedir(), ".clankie");
// Keep the existing on-disk directory so browser profiles survive the process merge.
const capabilityStateRoot = join(stateRoot, "runner");
const eventLogPath = process.env.CLANKIE_EVENT_LOG?.trim() || join(stateRoot, "events.jsonl");
const port = Number(process.env.PORT ?? 4310);
const relayPort = Number(process.env.CLANKIE_RELAY_PORT ?? 4321);

const operatorCredentialStore = createDefaultCredentialStore();
await ensureOperatorCredential({ env: process.env, store: operatorCredentialStore });
let publicGatewayConnector: PublicGatewayConnector | undefined;
if (startupSettings.publicGateway.url !== undefined && startupSettings.publicGateway.hostId !== undefined) {
  try {
    const hostToken = await resolvePublicGatewayCredential({
      env: process.env,
      store: operatorCredentialStore,
    });
    if (hostToken === undefined) {
      logger.warn(
        { hostId: startupSettings.publicGateway.hostId },
        "public gateway is configured but its credential is missing; direct access remains available",
      );
    } else {
      publicGatewayConnector = new PublicGatewayConnector({
        gatewayUrl: startupSettings.publicGateway.url,
        hostId: startupSettings.publicGateway.hostId,
        hostToken,
        controlPlaneUrl: `http://127.0.0.1:${String(port)}`,
        relayUrl: `http://127.0.0.1:${String(relayPort)}`,
        logger,
      });
    }
  } catch (error) {
    logger.warn(
      {
        hostId: startupSettings.publicGateway.hostId,
        error: error instanceof Error ? error.name : "UnknownError",
      },
      "public gateway configuration is unusable; direct access remains available",
    );
  }
}
if (
  publicGatewayConnector === undefined &&
  startupSettings.publicGateway.url !== undefined &&
  startupSettings.publicGateway.installationId !== undefined
) {
  try {
    const resolveAccountToken = createClankieAccountTokenProvider({
      gatewayUrl: startupSettings.publicGateway.url,
      store: operatorCredentialStore,
    });
    const initial = await resolveAccountToken();
    const hostId = derivePublicGatewayHostId(initial.accountId, startupSettings.publicGateway.installationId);
    publicGatewayConnector = new PublicGatewayConnector({
      gatewayUrl: startupSettings.publicGateway.url,
      hostId,
      installationId: startupSettings.publicGateway.installationId,
      resolveHostToken: async () => {
        const credential = await resolveAccountToken();
        return { token: credential.token, expiresAt: credential.expiresAt };
      },
      controlPlaneUrl: `http://127.0.0.1:${String(port)}`,
      relayUrl: `http://127.0.0.1:${String(relayPort)}`,
      logger,
    });
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.name : "UnknownError" },
      "Clankie account cannot connect to the public gateway; direct access remains available",
    );
  }
}
const localVoiceConfig = parseVoiceRealtimeEnv(process.env);
const localVoiceCredential = await operatorCredentialStore.get(localVoiceConfig.realtimeProvider);
const localVoiceElevenLabsCredential =
  localVoiceConfig.ttsProvider === "elevenlabs" ? await operatorCredentialStore.get("elevenlabs") : undefined;
const localVoiceRealtime =
  localVoiceCredential?.type === "api" &&
  (localVoiceConfig.ttsProvider !== "elevenlabs" || localVoiceElevenLabsCredential?.type === "api")
    ? createVoiceRealtimePorts({
        apiKey: localVoiceCredential.key,
        ...(localVoiceElevenLabsCredential?.type === "api"
          ? { elevenLabsApiKey: localVoiceElevenLabsCredential.key }
          : {}),
        config: localVoiceConfig,
      })
    : undefined;
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
// serves (ADR 0085). The root is derived, never merely read, so the bridge
// that serves the bytes back resolves the same directory this wrote them to.
const attachmentRoot = discordAttachmentRoot(process.env);
const mediaGenerator = new ConfiguredMediaGenerator({
  credentials: operatorCredentialStore,
  attachmentRoot,
  configCwd: repoRoot,
});

// Clankie's own browser (ADR 0082). On by default; a missing binary degrades
// to a logged unavailability rather than a boot failure.
let browserHost: BrowserHost | undefined;
if (browserEnabled(process.env.CLANKIE_BROWSER_ENABLED)) {
  try {
    browserHost = await createBrowserHost({
      stateRoot: capabilityStateRoot,
      attachmentRoot,
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

// His drawing hand (ADR 0096). The tldraw desktop app is a GUI app on the
// operator's Mac, so "not open" is the normal absent case and stays a refusal
// he says out loud; nothing here reaches the app until he draws something.
let tldrawHost: TldrawHost | undefined;
if (tldrawEnabled(process.env.CLANKIE_TLDRAW_ENABLED)) {
  tldrawHost = await createTldrawHost({
    stateRoot: capabilityStateRoot,
    attachmentRoot,
    logger,
    environment: process.env,
  });
  logger.info({ event: "tldraw.capability.enabled" }, "diagram host ready");
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
const playSight = new PlaySightProjection({ journalRootDir: defaultGbaPlayJournalDir(process.env) });
const hostedWorld = new HostedWorldSession();

// The captain's tools reach the same in-process authorities the routes use.
// The app needs the captain and the captain's deps need the app, so the app
// reference binds late — tools only run inside turns, well after boot.
let clankieRef: ClankieApp | undefined;
const boundApp = (): ClankieApp => {
  if (clankieRef === undefined) throw new Error("clankie service is still booting");
  return clankieRef;
};

// His connected services (ADR 0109). Servers are connected up front so no turn
// pays for a handshake; one that is unreachable costs him that server's tools
// and nothing else.
const mcpHost = createMcpHost({
  credentials: operatorCredentialStore,
  settings: settingsStore,
  logger,
});
await mcpHost.warm();

const email = createEmailPort({
  credentials: operatorCredentialStore,
  settings: settingsStore,
});

const captain = createCaptain(
  {
    mcp: mcpHost,
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
      generateImage: (request) => mediaGenerator.generateImage(request),
      generateVideo: (request, room) => mediaGenerator.generateVideo(request, { room }),
      finishedRenders: (room) => mediaGenerator.finishedRenders(room),
    },
    ...(tldrawHost === undefined ? {} : { diagrams: tldrawHost }),
    embodiment: {
      submitIntent: (intent) => boundApp().embodiment.submit(intent),
      getSession: (sessionId) => Promise.resolve(boundApp().embodiment.getSession(sessionId)),
      getLiveSession: () => Promise.resolve(boundApp().embodiment.liveSession()),
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
    playSight: {
      still: () => Promise.resolve(playSight.still()),
      story: () => Promise.resolve(playSight.story()),
    },
    hostedWorld: {
      inspect: () => hostedWorld.inspect(),
      invoke: (name, input) => hostedWorld.invoke(name, input),
    },
    streamWatch: {
      current: () => Promise.resolve(boundApp().streamWatch()),
    },
    discordMusic: createDiscordMusicClient(),
    discordVoicePresence: createDiscordVoicePresenceClient(),
    discordActions: createDiscordCaptainActionClient(),
    presence: {
      listSessions: () => Promise.resolve(boundApp().presenceSessions()),
      listVoiceHistory: (limit = 5) => Promise.resolve(boundApp().voiceHistory(limit)),
      listRecentVoiceSpeech: (limit = 12) => boundApp().recentVoiceSpeech(limit),
    },
    memory: {
      appendEpisode: (input) => {
        memory.recordEpisode({
          schemaVersion: 1,
          episodeId: `ep-${crypto.randomUUID()}`,
          lane: input.lane,
          targetId: input.targetId,
          summary: input.summary,
          // What he remembers at the console stays at the console; the
          // shareable/private gate in recall is only real if writes honor it.
          visibility: input.visibility ?? (input.lane === "operator" ? "operator_private" : "shareable"),
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
      recallEpisodeCard: (lane) => Promise.resolve(memory.episodeRecallCard({ lane })),
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
  {
    repoRoot,
    ...(startupSettings.captain.workingDirectory === undefined
      ? {}
      : { workingDirectory: startupSettings.captain.workingDirectory }),
    stateDir: join(stateRoot, "captain"),
    settings: settingsStore,
    discordEnvironment: captainDiscordEnvironment,
    // The same trusted module that owns the bot token owns making a channel's
    // room with it; the captain only asks (ADR 0024, ADR 0146).
    ...(discordPresenceRuntime === undefined ? {} : { discordChannels: discordPresenceRuntime }),
  },
);

const clankie = await createClankieApp({
  captain,
  memory,
  settings: settingsStore,
  mediaGenerator,
  ...(localVoiceRealtime === undefined ? {} : { localVoiceRealtime }),
  ...(discordPresenceRuntime === undefined ? {} : { discordPresenceRuntime }),
  ...(discordUserPresenceRuntime === undefined ? {} : { discordUserPresenceRuntime }),
  ...(browserHost === undefined ? {} : { browserTools: browserHost }),
  activityObservations: {
    current: (_signal) => Promise.resolve(activityObservations.current()),
  },
  playSight,
  ...(deviceSessionKey === undefined ? {} : { deviceSessionKey }),
  ...(publicGatewayConnector === undefined
    ? {}
    : {
        pairingOfferPublisher: publicGatewayConnector,
        publicGatewayHostBaseUrl: publicGatewayConnector.hostBaseUrl,
      }),
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
  claimEmbodiment: (environmentIds) => clankie.embodiment.claim(environmentIds),
  reportEmbodiment: async (update) => {
    const result = await clankie.embodiment.report(update);
    if (result.outcome === "rejected") throw new Error(`embodiment_${result.error}`);
    return result;
  },
  getLiveEmbodimentSession: () => Promise.resolve(clankie.embodiment.liveSession()),
};
const playHost = new PlayHost({
  client: embodimentClient,
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

const listenHost = "127.0.0.1";
const webSocketServer = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_REALTIME_AUDIO_APPEND_BYTES,
});
const server = serve({
  fetch: clankie.app.fetch,
  port,
  hostname: listenHost,
  websocket: { server: webSocketServer as unknown as WebSocketServerLike },
});
if (publicGatewayConnector !== undefined) {
  if (server.listening) publicGatewayConnector.start();
  else server.once("listening", () => publicGatewayConnector?.start());
}
logger.info(
  {
    hostname: listenHost,
    port,
    eventLogPath,
    memoryDir: defaultMemoryDir(process.env),
    settingsFilledNames,
    localVoiceAvailable: localVoiceRealtime !== undefined,
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
  publicGatewayConnector?.close();
  for (const client of webSocketServer.clients) client.close(1001, "service_shutdown");
  webSocketServer.close();
  server.close();
  void (async () => {
    const result = await playHost.stopAndWait({ deadlineMs: playShutdownDeadlineMs, reason: signal });
    await captain.close().catch(() => undefined);
    await browserHost?.close().catch(() => undefined);
    await mcpHost.close().catch(() => undefined);
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
  return createWorldPlayExecution({
    logger,
    repoRoot,
    activityObservations,
    playSight,
    hostedWorld,
    gameplay: startupSettings.gameplay,
  });
}

function parseCaptainSteerSourceLane(value: string): "discord_text" | "discord_voice" | "api" {
  if (value === "discord_text" || value === "discord_voice" || value === "api") return value;
  throw new Error("CLANKIE_CAPTAIN_STEER_SOURCE_LANE must be discord_text, discord_voice, or api");
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
