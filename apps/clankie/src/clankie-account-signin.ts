import { randomUUID } from "node:crypto";
import {
  beginClankieAccountLogin,
  CLANKIE_ACCOUNT_PROVIDER_ID,
  ClankieAccountAuthError,
  completeClankieAccountLogin,
  generatePublicGatewayInstallationId,
  PUBLIC_GATEWAY_CREDENTIAL_PROVIDER_ID,
  type ClankieAccountLoginChallenge,
  type CredentialStore,
  type ProviderCredential,
} from "@clankie/credential-broker";
import {
  gatewayOrigin,
  type ClankieAccountErrorCode,
  type ClankieAccountStartResult,
  type ClankieAccountStatus,
  type PublicGatewayDoorwayState,
} from "@clankie/protocol/public-gateway";
import { PublicGatewaySettingsSchema, type SettingsStore } from "@clankie/settings";

type OauthCredential = Extract<ProviderCredential, { type: "oauth" }>;

const DEFAULT_CLANKIE_ACCOUNT_GATEWAY_URL = "https://api.clankie.bot";
/** An emailed code is short-lived; a pending sign-in never outlives it by much. */
const CHALLENGE_TTL_MS = 10 * 60_000;
/** Wrong codes allowed against one emailed code before the owner must ask for another. */
const CODE_ATTEMPTS = 5;

/**
 * Stores a signed-in Clankie account as this Mac's remote-access credential and
 * points settings at the gateway, keeping the installation id so a re-sign-in
 * keeps its host id. `clankie login` and the app's sign-in both end here.
 */
export async function storeClankieAccountSignIn(input: {
  readonly gatewayUrl: string;
  readonly credential: OauthCredential;
  readonly settings: Pick<SettingsStore, "update">;
  readonly credentials: CredentialStore;
}): Promise<void> {
  await input.credentials.set(CLANKIE_ACCOUNT_PROVIDER_ID, input.credential);
  await input.credentials.delete(PUBLIC_GATEWAY_CREDENTIAL_PROVIDER_ID);
  await input.settings.update((current) => ({
    ...current,
    publicGateway: PublicGatewaySettingsSchema.parse({
      url: input.gatewayUrl,
      installationId: current.publicGateway.installationId ?? generatePublicGatewayInstallationId(),
    }),
  }));
}

/** A refusal the app can act on; it names a code, never a token or a provider message. */
export class ClankieAccountSignInError extends Error {
  public readonly code: ClankieAccountErrorCode;

  public constructor(code: ClankieAccountErrorCode) {
    super(code);
    this.code = code;
    this.name = "ClankieAccountSignInError";
  }
}

interface Pending {
  readonly id: string;
  readonly challenge: ClankieAccountLoginChallenge;
  readonly gatewayUrl: string;
  readonly expiresAt: number;
  attempts: number;
}

/**
 * The owner's own app signs this Mac in (#722). One sign-in is pending at a
 * time and lives only in this process: the account service's session stays
 * here, and the app holds an opaque, single-use challenge id.
 */
export function createClankieAccountSignIn(options: {
  readonly credentials: CredentialStore;
  readonly settings: Pick<SettingsStore, "load" | "update">;
  /** The doorway the running service holds, for status. */
  readonly doorway?: () => PublicGatewayDoorwayState;
  readonly gatewayUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let pending: Pending | undefined;
  let storedSinceStart = false;

  const status = async (): Promise<ClankieAccountStatus> => {
    const publicGateway = (await options.settings.load()).publicGateway;
    const stored = await options.credentials.get(CLANKIE_ACCOUNT_PROVIDER_ID);
    const doorway = options.doorway?.() ?? { state: "disabled" };
    const credential = stored?.type === "oauth" && stored.accountId !== undefined ? stored : undefined;
    if (
      credential !== undefined &&
      publicGateway.url !== undefined &&
      publicGateway.installationId !== undefined &&
      doorway.state !== "sign_in_required"
    ) {
      const email = credential.metadata?.email;
      return {
        state: "signed_in",
        ...(email === undefined ? {} : { email }),
        doorway,
        // The doorway is built at startup, so one stored after it opens on the next start.
        restartRequired: storedSinceStart,
      };
    }
    if (
      publicGateway.installationId !== undefined ||
      stored !== undefined ||
      doorway.state === "sign_in_required"
    )
      return { state: "signed_out" };
    return { state: "never_set_up" };
  };

  const start = async (email: string): Promise<ClankieAccountStartResult> => {
    const gatewayUrl = gatewayOrigin(options.gatewayUrl ?? DEFAULT_CLANKIE_ACCOUNT_GATEWAY_URL);
    const challenge = await beginClankieAccountLogin({
      gatewayUrl,
      email,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    }).catch(refusal);
    // A new request replaces any earlier one; only the latest emailed code can complete.
    pending = { id: randomUUID(), challenge, gatewayUrl, expiresAt: now() + CHALLENGE_TTL_MS, attempts: 0 };
    return { challengeId: pending.id, expiresAt: new Date(pending.expiresAt).toISOString() };
  };

  const complete = async (challengeId: string, code: string): Promise<ClankieAccountStatus> => {
    const current = pending;
    if (current === undefined || current.id !== challengeId)
      throw new ClankieAccountSignInError("challenge_unknown");
    if (now() >= current.expiresAt) {
      pending = undefined;
      throw new ClankieAccountSignInError("code_expired");
    }
    // Counted before the request leaves, so concurrent completes reach the
    // account service at most CODE_ATTEMPTS times for one emailed code.
    if (current.attempts >= CODE_ATTEMPTS) {
      if (pending === current) pending = undefined;
      throw new ClankieAccountSignInError("challenge_unknown");
    }
    current.attempts += 1;
    let credential: OauthCredential;
    try {
      credential = await completeClankieAccountLogin({
        challenge: current.challenge,
        code,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      });
    } catch (error) {
      // A mistyped code may be retried against the same emailed code, a few times.
      const retryable = error instanceof ClankieAccountAuthError && error.code === "code_invalid";
      if (!retryable || current.attempts >= CODE_ATTEMPTS) {
        if (pending === current) pending = undefined;
      }
      return refusal(error);
    }
    if (pending === current) pending = undefined;
    await storeClankieAccountSignIn({
      gatewayUrl: current.gatewayUrl,
      credential: { ...credential, metadata: { ...credential.metadata, email: current.challenge.email } },
      settings: options.settings,
      credentials: options.credentials,
    });
    storedSinceStart = true;
    return await status();
  };

  return { status, start, complete };
}

export type ClankieAccountSignIn = ReturnType<typeof createClankieAccountSignIn>;

function refusal(error: unknown): never {
  if (error instanceof ClankieAccountSignInError) throw error;
  if (error instanceof ClankieAccountAuthError) {
    const code: ClankieAccountErrorCode =
      error.code === "refresh_rejected" ? "unexpected_response" : error.code;
    throw new ClankieAccountSignInError(code);
  }
  throw new ClankieAccountSignInError("service_unavailable");
}
