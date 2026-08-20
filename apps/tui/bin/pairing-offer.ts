import { PairingOfferWireSchema, type PairingOfferWire } from "@clankie/protocol";

// Narrow client for the device pairing-offer boundary. `clankie pair`
// requests a short-lived, single-use pairing offer from the clankie service and
// renders it; it never mints grants or embeds long-lived credentials locally.
// The wire shape is the canonical `PairingOfferWireSchema` (VUH-727); a device
// redeems the rendered offer against `/v1/pairing/redeem` separately.

/** Default clankie service origin; the pairing route is expected to live here (loopback dev). */
export const DEFAULT_CONTROL_PLANE_URL = "http://127.0.0.1:4310";

/** Pairing-offer route on the clankie service. */
export const PAIRING_OFFER_PATH = "/v1/pairing/offer";

/**
 * A single-use pairing offer minted by the clankie service. `deepLink` and `code`
 * are secret-bearing display data: render them, never log or persist them.
 */
export const PairingOfferSchema = PairingOfferWireSchema;

export type PairingOffer = PairingOfferWire;

/** Every failure the command must fail closed on (VUH-878 acceptance criteria). */
export type PairingOfferStatus = "unavailable" | "unauthorized" | "expired" | "malformed" | "interrupted";

/**
 * A fail-closed pairing outcome. The message is content-free and actionable —
 * it never carries the offer secret, an operator token, or a raw response body.
 */
export class PairingOfferError extends Error {
  public readonly status: PairingOfferStatus;

  public constructor(status: PairingOfferStatus) {
    super(pairingFailureMessage(status));
    this.name = "PairingOfferError";
    this.status = status;
  }
}

/** Actionable, secret-free guidance for each fail-closed status. */
export function pairingFailureMessage(status: PairingOfferStatus): string {
  switch (status) {
    case "unavailable":
      return "Pairing service unavailable. Start the clankie service and retry.";
    case "unauthorized":
      return "Operator credential unavailable. Start the clankie service once, then retry.";
    case "expired":
      return "Pairing offer expired before it could be shown. Run `clankie pair` again for a fresh offer.";
    case "malformed":
      return "Pairing service returned an unexpected response. Update Clankie or retry.";
    case "interrupted":
      return "Pairing request did not complete in time. Run `clankie pair` again.";
  }
}

export interface RequestPairingOfferOptions {
  readonly controlPlaneUrl?: string;
  readonly operatorToken?: string | undefined;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Request one single-use pairing offer. Throws {@link PairingOfferError} on every
 * failure so the caller can fail closed uniformly. Never surfaces response-body
 * text or secrets in the thrown message.
 */
export async function requestPairingOffer(options: RequestPairingOfferOptions = {}): Promise<PairingOffer> {
  const operatorToken = options.operatorToken?.trim();
  if (operatorToken === undefined || operatorToken.length === 0) {
    throw new PairingOfferError("unauthorized");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL(PAIRING_OFFER_PATH, options.controlPlaneUrl ?? DEFAULT_CONTROL_PLANE_URL);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${operatorToken}`, "content-type": "application/json" },
      body: "{}",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    if (options.signal?.aborted === true || isAbortError(error)) throw new PairingOfferError("interrupted");
    // ECONNREFUSED (service not running) and other transport faults: fail closed.
    throw new PairingOfferError("unavailable");
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new PairingOfferError("unauthorized");
    throw new PairingOfferError("unavailable");
  }

  const payload: unknown = await response.json().catch(() => undefined);
  const parsed = PairingOfferSchema.safeParse(payload);
  if (!parsed.success) throw new PairingOfferError("malformed");
  if (Date.parse(parsed.data.expiresAt) <= Date.now()) throw new PairingOfferError("expired");
  return parsed.data;
}
