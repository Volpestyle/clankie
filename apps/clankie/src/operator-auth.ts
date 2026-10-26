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
  /** The service's own broker: the protected keychain comes first once it exists (VUH-2592). */
  readonly protectedFirst?: boolean;
}

/**
 * Resolves the process-cached authoritative credential, invalidated by broker changes. This keeps
 * rotation atomic across the server and local clients without restarting the
 * service. Store failures and invalid credentials fail closed.
 */
export function createCredentialBackedOperatorAuthenticator(
  options: CredentialBackedOperatorAuthenticatorOptions,
): OperatorAuthenticator {
  return async (request) => {
    try {
      const credential = await resolveOperatorCredential({
        env: options.env ?? process.env,
        store: options.store,
        ...(options.protectedFirst ? { protectedFirst: true } : {}),
      });
      if (credential === undefined) return undefined;
      return createBearerAuthenticator(credential.token, options.identity)(request);
    } catch {
      return undefined;
    }
  };
}
