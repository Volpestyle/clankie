import { z } from "zod";

/**
 * Opaque reference to an OAuth installation held by the credential broker.
 * It is safe to pass through trusted configuration because it is not a token,
 * authorization code, client identifier, or client secret.
 */
export const LinearOAuthCredentialRefSchema = z.object({
  workspaceId: z.string().min(1),
  credentialId: z.string().min(1),
});
export type LinearOAuthCredentialRef = z.infer<typeof LinearOAuthCredentialRefSchema>;

/** Secret-free installation state returned after exchange or refresh. */
export const LinearOAuthCredentialStatusSchema = z.object({
  workspaceId: z.string().min(1),
  appUserId: z.string().min(1),
  expiresAt: z.string().datetime(),
  scopes: z.array(z.string().min(1)),
});
export type LinearOAuthCredentialStatus = z.infer<typeof LinearOAuthCredentialStatusSchema>;

export const LinearOAuthExchangeRequestSchema = z.object({
  credential: LinearOAuthCredentialRefSchema,
  /** Opaque broker handle for the one-time code received by the trusted callback. */
  authorizationCodeHandle: z.string().min(1),
  redirectUri: z.string().url(),
});
export type LinearOAuthExchangeRequest = z.infer<typeof LinearOAuthExchangeRequestSchema>;

export const LinearOAuthRefreshRequestSchema = z.object({
  credential: LinearOAuthCredentialRefSchema,
});
export type LinearOAuthRefreshRequest = z.infer<typeof LinearOAuthRefreshRequestSchema>;

export const LinearGraphqlRequestSchema = z.object({
  operationName: z.string().min(1),
  document: z.string().min(1),
  variables: z.record(z.string(), z.unknown()),
});
export type LinearGraphqlRequest = z.infer<typeof LinearGraphqlRequestSchema>;

/**
 * Trusted credential-broker-backed OAuth boundary.
 *
 * Implementations load client credentials and OAuth token pairs from the
 * credential broker, rotate refresh tokens atomically, reject GraphQL errors,
 * and return only the operation's `data` object. Raw secrets never cross this
 * interface. Authorization callbacks first deposit the one-time code in the
 * broker and pass only its opaque handle here.
 */
export interface LinearOAuthCredentialBroker {
  exchangeAuthorizationCode(input: LinearOAuthExchangeRequest): Promise<LinearOAuthCredentialStatus>;
  refresh(input: LinearOAuthRefreshRequest): Promise<LinearOAuthCredentialStatus>;
  executeGraphql(input: {
    credential: LinearOAuthCredentialRef;
    request: LinearGraphqlRequest;
  }): Promise<unknown>;
}
