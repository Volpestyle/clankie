import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import type { CredentialStore } from "@clankie/credential-broker";
import { BODY_TRANSFER_ROUTES } from "@clankie/protocol/body-transfer";
import { discordAttachmentRoot, type SettingsStore } from "@clankie/settings";
import { createClankieApp, type ClankieApp } from "./app.ts";
import type { ClankieAppDependencies } from "./app/types.ts";
import type { BodyTransfer } from "./body-transfer.ts";
import { createStubCaptain } from "./captain/port.ts";
import { createCoreExtensions, doorwayOf, switchedOn, type CorePorts } from "./extension-host.ts";
import { loadOrCreateDeviceSessionKey } from "./device-session.ts";
import { createCredentialBackedOperatorAuthenticator } from "./operator-auth.ts";
import { relayExtension } from "./relay-extension.ts";

/**
 * What a dormant body admits (ADR 0286, VUH-2583): health, the owner's transfer
 * routes, and what its paired devices need to stay signed in. Everything else
 * answers `503 body_dormant`.
 */
function dormantAdmits(method: string, path: string): boolean {
  if (method === "GET" && path === "/health") return true;
  if (BODY_TRANSFER_ROUTES.some((route) => route.method === method && route.path === path)) return true;
  if (method === "POST" && path === "/v1/devices/self/session/refresh") return true;
  return method === "GET" && path === "/v1/devices/self";
}

/**
 * The same app composition an active body uses, with no captain, and the
 * dormant gate in front. Device authority behaves exactly as it does on an
 * active body. clankie-ops's gateway body-transfer path test builds its
 * destination body with it, so it stays exported.
 *
 * @public
 */
export function createDormantApp(
  options: Omit<ClankieAppDependencies, "captain" | "admit" | "bodyTransfer"> & {
    readonly transfer: BodyTransfer;
    readonly restart: () => void;
  },
): Promise<ClankieApp> {
  const { transfer, restart, ...dependencies } = options;
  return createClankieApp({
    ...dependencies,
    captain: createStubCaptain(),
    admit: dormantAdmits,
    bodyTransfer: { transfer, restart },
  });
}

/**
 * A body that is not Clankie keeps its doorway: its gateway connection and
 * device authority. It builds its outgoing bundle before any of
 * those open, and returns only when the process should exit.
 */
export async function serveDormantBody(options: {
  transfer: BodyTransfer;
  settingsStore: SettingsStore;
  store: CredentialStore;
  /** The service's own broker: the protected operator keychain comes first once it exists. */
  protectedFirst?: boolean;
  stateRoot: string;
  eventLogPath: string;
  env: NodeJS.ProcessEnv;
  port: number;
  relayPort: number;
  logger: CorePorts["logger"];
  onDoorwayChange?: CorePorts["onDoorwayChange"];
}): Promise<number> {
  const { transfer, env, logger } = options;
  await transfer.prepareOutgoing();
  // The doorway is the relay extension (ADR 0328); it connects once the server listens.
  let serviceListening: (() => void) | undefined;
  const listening = new Promise<void>((resolve) => {
    serviceListening = resolve;
  });
  const extensions = createCoreExtensions({
    credentials: options.store,
    env,
    servicePorts: { port: options.port, relayPort: options.relayPort },
    logger,
    capabilityStateRoot: join(options.stateRoot, "runner"),
    attachmentRoot: discordAttachmentRoot(env),
    settings: options.settingsStore,
    stateRoot: options.stateRoot,
    whenListening: (run) => void listening.then(run),
    ...(options.onDoorwayChange === undefined ? {} : { onDoorwayChange: options.onDoorwayChange }),
  });
  const startupSettings = await options.settingsStore.load();
  const publicGateway = startupSettings.publicGateway;
  extensions.add(relayExtension, {
    enabled: switchedOn(startupSettings, "relay", publicGateway.url !== undefined),
    settings: publicGateway,
  });
  await extensions.start();
  const connector = doorwayOf(extensions)?.connector;
  const deviceSessionKeyPath = env.CLANKIE_DEVICE_SESSION_KEY_PATH
    ? resolve(env.CLANKIE_DEVICE_SESSION_KEY_PATH)
    : join(options.stateRoot, "device-session.key");
  const deviceSessionKey = await loadOrCreateDeviceSessionKey(deviceSessionKeyPath);
  let finish: (code: number) => void = () => undefined;
  const finished = new Promise<number>((done) => (finish = done));
  const app = await createDormantApp({
    transfer,
    restart: () => finish(0),
    settings: options.settingsStore,
    ...(deviceSessionKey === undefined ? {} : { deviceSessionKey }),
    eventLogPath: options.eventLogPath,
    authenticateOperator: createCredentialBackedOperatorAuthenticator({
      env,
      store: options.store,
      ...(options.protectedFirst ? { protectedFirst: true } : {}),
      identity: { operatorId: env.CLANKIE_OPERATOR_ID ?? "local-operator", steerSourceLane: "tui" },
    }),
    ...(connector === undefined ? {} : { publicGatewayHostBaseUrl: connector.hostBaseUrl }),
    publicGatewayDoorway: () => connector?.doorway ?? { state: "disabled" },
    extensions,
  });
  const server = serve({ fetch: app.app.fetch, hostname: "127.0.0.1", port: options.port });
  if (server.listening) serviceListening?.();
  else server.once("listening", () => serviceListening?.());
  logger.info({ event: "body.dormant", self: transfer.authority() }, "clankie body is dormant");
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => finish(signal === "SIGINT" ? 130 : 143));
  const code = await finished;
  await extensions.stop();
  app.close();
  await new Promise<void>((done) => server.close(() => done()));
  return code;
}
