import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import {
  createBearerAuthenticator,
  type OperatorAuthenticator,
  type TrustedOperatorIdentity,
} from "./app.ts";

export interface CredentialBackedOperatorAuthenticatorOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly identity: TrustedOperatorIdentity;
  readonly store: CredentialStore;
}

/**
 * Resolves the authoritative operator credential for every request. This keeps
 * rotation atomic across the server and local clients without restarting the
 * control plane. Store failures and invalid credentials fail closed.
 */
export function createCredentialBackedOperatorAuthenticator(
  options: CredentialBackedOperatorAuthenticatorOptions,
): OperatorAuthenticator {
  return async (request) => {
    try {
      const credential = await resolveOperatorCredential({
        env: options.env ?? process.env,
        store: options.store,
      });
      if (credential === undefined) return undefined;
      return createBearerAuthenticator(credential.token, options.identity)(request);
    } catch {
      return undefined;
    }
  };
}
