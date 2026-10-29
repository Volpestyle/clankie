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
import { PublicGatewayConnector } from "./public-gateway-connector.ts";

type ConnectorOptions = ConstructorParameters<typeof PublicGatewayConnector>[0];

export interface BodyConnection {
  readonly connector?: PublicGatewayConnector;
  /** Set when the account credential is rejected before a connector can even exist. */
  readonly signInRequiredSince?: string;
}

/** A self-hosted host token, or the signed-in account route, in that order. */
export async function connectBodyToGateway(options: {
  publicGateway: ClankieSettings["publicGateway"];
  store: CredentialStore;
  env: NodeJS.ProcessEnv;
  port: number;
  relayPort: number;
  logger: NonNullable<ConnectorOptions["logger"]>;
  onDoorwayChange?: ConnectorOptions["onDoorwayChange"];
}): Promise<BodyConnection> {
  const { publicGateway, logger, port, relayPort } = options;
  const shared = {
    controlPlaneUrl: `http://127.0.0.1:${String(port)}`,
    relayUrl: `http://127.0.0.1:${String(relayPort)}`,
    logger,
    ...(options.onDoorwayChange === undefined ? {} : { onDoorwayChange: options.onDoorwayChange }),
  };
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
