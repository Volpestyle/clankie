import { createDefaultCredentialStore, type CredentialStore } from "./credential-store.ts";

/** Operator-provisioned bearer that authenticates this Mac to the public gateway. */
export const PUBLIC_GATEWAY_CREDENTIAL_PROVIDER_ID = "clankie-public-gateway";
export const PUBLIC_GATEWAY_FORBIDDEN_ENV = "CLANKIE_PUBLIC_GATEWAY_TOKEN" as const;

export interface PublicGatewayCredentialOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly store?: CredentialStore;
}

export async function resolvePublicGatewayCredential(
  options: PublicGatewayCredentialOptions = {},
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  if (env[PUBLIC_GATEWAY_FORBIDDEN_ENV]) {
    throw new Error(
      `${PUBLIC_GATEWAY_FORBIDDEN_ENV} must not be set; the public gateway bearer lives in the credential broker`,
    );
  }
  const store = options.store ?? createDefaultCredentialStore({ env });
  const credential = await store.get(PUBLIC_GATEWAY_CREDENTIAL_PROVIDER_ID);
  if (credential === undefined) return undefined;
  if (credential.type !== "api" || credential.key.length < 32 || credential.key.length > 512) {
    throw new Error("The stored public gateway credential is invalid; refusing to use it");
  }
  return credential.key;
}
