import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import type { CredentialStore } from "@clankie/credential-broker";
import { BODY_TRANSFER_ROUTES } from "@clankie/protocol/body-transfer";
import { HOSTED_OPERATOR_PATH } from "@clankie/protocol/hosted-operator";
import type { SettingsStore } from "@clankie/settings";
import { createClankieApp, type ClankieApp } from "./app.ts";
import type { ClankieAppDependencies } from "./app/types.ts";
import { connectBodyToGateway, openHostedBody } from "./body-doorway.ts";
import type { BodyTransfer } from "./body-transfer.ts";
import { createStubCaptain } from "./captain/port.ts";
import { loadOrCreateDeviceSessionKey } from "./device-session.ts";
import { readHostedBodyBootstrap } from "./hosted-body.ts";
import { HostedDeviceSecurity } from "./hosted-device-security.ts";
import { createCredentialBackedOperatorAuthenticator } from "./operator-auth.ts";

/**
 * What a dormant body admits (ADR 0286, VUH-2583): health, the owner's transfer
 * routes, and what its paired devices need to stay signed in. Everything else
 * answers `503 body_dormant`, including requests carried inside the hosted
 * operator envelope, which reach this gate again on their own path.
 */
function dormantAdmits(method: string, path: string): boolean {
  if (method === "GET" && path === "/health") return true;
  if (BODY_TRANSFER_ROUTES.some((route) => route.method === method && route.path === path)) return true;
  if (method === "POST" && path === HOSTED_OPERATOR_PATH) return true;
  if (method === "POST" && path === "/v1/devices/self/session/refresh") return true;
  return method === "GET" && path === "/v1/devices/self";
}

/**
 * The same app composition an active body uses, with no captain, and the
 * dormant gate in front. Device authority, hosted security and the hosted
 * operator seam behave exactly as they do on an active body.
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
 * A body that is not Clankie keeps its doorway: its hosted identity, gateway
 * connection and device authority. It builds its outgoing bundle before any of
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
  logger: Parameters<typeof connectBodyToGateway>[0]["logger"];
  onDoorwayChange?: Parameters<typeof connectBodyToGateway>[0]["onDoorwayChange"];
}): Promise<number> {
  const { transfer, env, logger } = options;
  await transfer.prepareOutgoing();
  const { hostedBody, hostedPairing } = await openHostedBody(
    readHostedBodyBootstrap(env),
    options.store,
    options.stateRoot,
  );
  const { connector } = await connectBodyToGateway({
    hostedBody,
    publicGateway: (await options.settingsStore.load()).publicGateway,
    store: options.store,
    env,
    port: options.port,
    relayPort: options.relayPort,
    logger,
    ...(options.onDoorwayChange === undefined ? {} : { onDoorwayChange: options.onDoorwayChange }),
  });
  if (hostedBody !== undefined) hostedBody.onDenied = () => connector?.close();
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
    ...(hostedPairing === undefined ? {} : { hostedPairing }),
    ...(hostedBody === undefined
      ? {}
      : {
          hostedBody,
          hostedDeviceSecurity: new HostedDeviceSecurity(hostedBody, `${deviceSessionKeyPath}.hosted.json`),
        }),
    ...(connector === undefined ? {} : { publicGatewayHostBaseUrl: connector.hostBaseUrl }),
    publicGatewayDoorway: () => connector?.doorway ?? { state: "disabled" },
  });
  const server = serve({ fetch: app.app.fetch, hostname: "127.0.0.1", port: options.port });
  if (connector !== undefined) {
    if (server.listening) connector.start();
    else server.once("listening", () => connector.start());
  }
  logger.info({ event: "body.dormant", self: transfer.authority() }, "clankie body is dormant");
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => finish(signal === "SIGINT" ? 130 : 143));
  const code = await finished;
  connector?.close();
  app.close();
  await new Promise<void>((done) => server.close(() => done()));
  return code;
}
