import { join } from "node:path";
import {
  CLANKIE_ACCOUNT_PROVIDER_ID,
  ClankieAccountAuthError,
  clankieAccountSignInRequired,
  createClankieAccountTokenProvider,
  derivePublicGatewayHostId,
  resolvePublicGatewayCredential,
  type CredentialStore,
} from "@clankie/credential-broker";
import type { ClankieSettings } from "@clankie/settings";
import { loadGatewayEncryptionKey } from "./gateway-encryption.ts";
import { createHostedBodyClient, HostedBodyDeniedError, type HostedBodyBootstrap } from "./hosted-body.ts";
import { createHostedPairing } from "./hosted-pairing.ts";
import { PublicGatewayConnector } from "./public-gateway-connector.ts";

/**
 * A body's doorway: its hosted identity and its gateway connection. An active
 * body and a dormant one (ADR 0286, VUH-2583) open it the same way, so a frozen
 * or released body stays reachable by its owner's devices.
 */
export async function openHostedBody(
  bootstrap: HostedBodyBootstrap | undefined,
  store: CredentialStore,
  stateRoot: string,
) {
  if (bootstrap === undefined) return {};
  const hostedBody = await createHostedBodyClient(bootstrap, store);
  // Register before any signed fleet request or connector-triggered renewal.
  const hostedPairing = await createHostedPairing(
    hostedBody,
    store,
    join(stateRoot, "hosted-pair-tickets.json"),
  );
  return { hostedBody, hostedPairing };
}

type ConnectorOptions = ConstructorParameters<typeof PublicGatewayConnector>[0];

export interface BodyConnection {
  readonly connector?: PublicGatewayConnector;
  /** The signed-in account route, which the free official Discord bot (VUH-1766) also uses. */
  readonly accountGatewayRoute?: {
    gatewayUrl: string;
    installationId: string;
    resolveAccountToken: () => Promise<{ token: string }>;
  };
  /** Set when the account credential is rejected before a connector can even exist. */
  readonly signInRequiredSince?: string;
}

/** The hosted body's fleet route, a self-hosted host token, or the signed-in account route, in that order. */
export async function connectBodyToGateway(options: {
  hostedBody: Awaited<ReturnType<typeof createHostedBodyClient>> | undefined;
  publicGateway: ClankieSettings["publicGateway"];
  store: CredentialStore;
  env: NodeJS.ProcessEnv;
  port: number;
  relayPort: number;
  logger: NonNullable<ConnectorOptions["logger"]>;
  onDoorwayChange?: ConnectorOptions["onDoorwayChange"];
  gatewayRoutes?: ConnectorOptions["gatewayRoutes"];
  onAuthenticatedRequest?: ConnectorOptions["onAuthenticatedRequest"];
}): Promise<BodyConnection> {
  const { hostedBody, publicGateway, logger, port, relayPort } = options;
  const shared = {
    ...(options.gatewayRoutes === undefined ? {} : { gatewayRoutes: options.gatewayRoutes }),
    controlPlaneUrl: `http://127.0.0.1:${String(port)}`,
    relayUrl: `http://127.0.0.1:${String(relayPort)}`,
    logger,
    ...(options.onDoorwayChange === undefined ? {} : { onDoorwayChange: options.onDoorwayChange }),
  };
  if (hostedBody !== undefined) {
    return {
      connector: new PublicGatewayConnector({
        ...shared,
        encryptionKey: await loadGatewayEncryptionKey(options.store),
        gatewayUrl: hostedBody.bootstrap.gatewayOrigin,
        hostId: hostedBody.hostId,
        ...(options.onAuthenticatedRequest === undefined
          ? {}
          : { onAuthenticatedRequest: options.onAuthenticatedRequest }),
        carriesCalls: false,
        onHostRejected: () => hostedBody.reject(),
        installationId: hostedBody.bootstrap.installationId,
        resolveHostToken: () => hostedBody.resolveHostToken(),
        tokenErrorIsTerminal: (error) => error instanceof HostedBodyDeniedError,
      }),
    };
  }
  if (publicGateway.url !== undefined && publicGateway.hostId !== undefined) {
    try {
      const hostToken = await resolvePublicGatewayCredential({ env: options.env, store: options.store });
      if (hostToken === undefined) {
        logger.warn(
          { hostId: publicGateway.hostId },
          "public gateway is configured but its credential is missing; direct access remains available",
        );
      } else {
        return {
          connector: new PublicGatewayConnector({
            ...shared,
            encryptionKey: await loadGatewayEncryptionKey(options.store),
            gatewayUrl: publicGateway.url,
            hostId: publicGateway.hostId,
            hostToken,
          }),
        };
      }
    } catch (error) {
      logger.warn(
        { hostId: publicGateway.hostId, error: error instanceof Error ? error.name : "UnknownError" },
        "public gateway configuration is unusable; direct access remains available",
      );
    }
  }
  if (publicGateway.url !== undefined && publicGateway.installationId !== undefined) {
    try {
      const resolveAccountToken = createClankieAccountTokenProvider({
        gatewayUrl: publicGateway.url,
        store: options.store,
      });
      // Derive the stable route locally. Network/token resolution belongs to the
      // connector's retry loop, so an offline startup can recover after wake.
      const stored = await options.store.get(CLANKIE_ACCOUNT_PROVIDER_ID);
      if (stored?.type !== "oauth" || stored.accountId === undefined) {
        throw new ClankieAccountAuthError("account_not_invited", "Sign in to your Clankie account first");
      }
      const hostId = derivePublicGatewayHostId(stored.accountId, publicGateway.installationId);
      return {
        accountGatewayRoute: {
          gatewayUrl: publicGateway.url,
          installationId: publicGateway.installationId,
          resolveAccountToken,
        },
        connector: new PublicGatewayConnector({
          ...shared,
          encryptionKey: await loadGatewayEncryptionKey(options.store),
          gatewayUrl: publicGateway.url,
          hostId,
          installationId: publicGateway.installationId,
          resolveHostToken: async () => {
            const credential = await resolveAccountToken();
            return { token: credential.token, expiresAt: credential.expiresAt };
          },
          tokenErrorIsTerminal: clankieAccountSignInRequired,
        }),
      };
    } catch (error) {
      logger.warn(
        {
          error: error instanceof Error ? error.name : "UnknownError",
          ...(typeof (error as { readonly code?: unknown }).code === "string"
            ? { code: (error as { readonly code: string }).code }
            : {}),
        },
        "Clankie account cannot connect to the public gateway; direct access remains available",
      );
      if (clankieAccountSignInRequired(error)) return { signInRequiredSince: new Date().toISOString() };
    }
  }
  return {};
}
