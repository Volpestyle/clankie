import { createHash, randomBytes, randomInt } from "node:crypto";
import { type PairingOfferWire } from "@clankie/protocol";

// Device pairing-offer minting and single-use redemption for the control plane.
// An offer is short-lived display data an operator hands to a device; it is not
// a grant. Redemption (VUH-727) turns a presented offer secret or typed code
// into a durable device identity — see devices.ts and the /v1/pairing/* routes.

/** Wire version of the offer shape. */
export const PAIRING_OFFER_VERSION = 1 as const;

/** Offers are short-lived by contract: single-use display data, not credentials. */
export const DEFAULT_PAIRING_OFFER_TTL_MS = 5 * 60_000;

/** How long a consumed offer's secret/code still reads as "consumed" before it reads as "expired". */
export const DEFAULT_CONSUMED_GRACE_MS = 5 * 60_000;

/** Deep-link base recognized by the Clankie app (reference UX: `clankie://connect`). */
export const PAIRING_DEEP_LINK_BASE = "clankie://connect";

/**
 * Typed-pairing alphabet: unambiguous uppercase (no 0/O, 1/I/L) so a human can
 * read the code off one screen and type it on another.
 */
const PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const PAIRING_CODE_GROUPS = 2;
const PAIRING_CODE_GROUP_LENGTH = 4;

/**
 * One minted offer. `code` and `offerSecret` are secret-bearing display data:
 * they go to the authenticated operator's terminal and never into logs or
 * recorded events — audit trails reference `offerId` only.
 */
export interface StoredPairingOffer {
  /** Non-secret audit handle for logs and semantic events. */
  readonly offerId: string;
  /** Secret short code for typed pairing on camera-less devices. */
  readonly code: string;
  /** Secret high-entropy capability carried by the QR deep link. */
  readonly offerSecret: string;
  readonly mintedBy: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/** Cryptographically random typed-pairing code, e.g. `7F3K-M2QT`. */
function mintPairingCode(): string {
  const groups: string[] = [];
  for (let group = 0; group < PAIRING_CODE_GROUPS; group += 1) {
    let text = "";
    for (let index = 0; index < PAIRING_CODE_GROUP_LENGTH; index += 1) {
      text += PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)];
    }
    groups.push(text);
  }
  return groups.join("-");
}

export interface MintPairingOfferOptions {
  readonly now: Date;
  readonly mintedBy: string;
  readonly ttlMs?: number;
  /** Non-secret id source only; code and offer secret always come from crypto randomness. */
  readonly idFactory?: () => string;
}

/** Mint one single-use offer record. Pure aside from crypto randomness. */
export function mintPairingOffer(options: MintPairingOfferOptions): StoredPairingOffer {
  const idFactory = options.idFactory ?? (() => randomBytes(16).toString("hex"));
  const ttlMs = options.ttlMs ?? DEFAULT_PAIRING_OFFER_TTL_MS;
  return {
    offerId: `pairing-offer-${idFactory().slice(0, 12)}`,
    code: mintPairingCode(),
    offerSecret: randomBytes(16).toString("base64url"),
    mintedBy: options.mintedBy,
    createdAt: options.now.toISOString(),
    expiresAt: new Date(options.now.getTime() + ttlMs).toISOString(),
  };
}

/** Project a stored offer onto the wire shape `clankie pair` expects. */
export function pairingOfferWire(offer: StoredPairingOffer): PairingOfferWire {
  return {
    version: PAIRING_OFFER_VERSION,
    deepLink: `${PAIRING_DEEP_LINK_BASE}?v=${PAIRING_OFFER_VERSION}&offer=${offer.offerSecret}`,
    code: offer.code,
    expiresAt: offer.expiresAt,
  };
}

export type TakePairingOfferResult =
  | { readonly ok: true; readonly offer: StoredPairingOffer }
  | { readonly ok: false; readonly error: "consumed" | "expired" };

/**
 * In-memory registry of outstanding pairing offers with constant-time-equivalent
 * lookup by hashed secret or typed code. Consumption is synchronous so two
 * concurrent redemptions of the same offer cannot both succeed. A consumed
 * offer's secret and code read as `consumed` for a grace window, then as
 * `expired` — identical to an unknown or pruned value, so redemption never
 * becomes an offer-enumeration oracle.
 */
export class PairingOfferStore {
  private readonly offers = new Map<string, StoredPairingOffer>();
  private readonly bySecretHash = new Map<string, string>();
  private readonly byCodeHash = new Map<string, string>();
  private readonly consumed = new Map<string, number>();
  private readonly graceMs: number;

  public constructor(options: { readonly consumedGraceMs?: number } = {}) {
    this.graceMs = options.consumedGraceMs ?? DEFAULT_CONSUMED_GRACE_MS;
  }

  public get size(): number {
    return this.offers.size;
  }

  public add(offer: StoredPairingOffer): void {
    this.offers.set(offer.offerId, offer);
    this.bySecretHash.set(hashSecret(offer.offerSecret), offer.offerId);
    this.byCodeHash.set(hashCode(offer.code), offer.offerId);
  }

  /** Drop expired offers and consumed markers whose grace window has passed. */
  public prune(now: Date): void {
    const nowMs = now.getTime();
    for (const offer of this.offers.values()) {
      if (Date.parse(offer.expiresAt) <= nowMs) this.evict(offer);
    }
    for (const [hash, graceExpiryMs] of this.consumed) {
      if (graceExpiryMs <= nowMs) this.consumed.delete(hash);
    }
  }

  /** Single-use consume. Synchronous by design — no await between check and delete. */
  public take(
    presented: { readonly offerSecret?: string; readonly code?: string },
    now: Date,
  ): TakePairingOfferResult {
    const nowMs = now.getTime();
    const secretHash = presented.offerSecret !== undefined ? hashSecret(presented.offerSecret) : undefined;
    const codeHash = presented.code !== undefined ? hashCode(presented.code) : undefined;
    for (const hash of [secretHash, codeHash]) {
      if (hash === undefined) continue;
      const graceExpiryMs = this.consumed.get(hash);
      if (graceExpiryMs !== undefined && graceExpiryMs > nowMs) return { ok: false, error: "consumed" };
    }
    const offerId =
      (secretHash !== undefined ? this.bySecretHash.get(secretHash) : undefined) ??
      (codeHash !== undefined ? this.byCodeHash.get(codeHash) : undefined);
    const offer = offerId !== undefined ? this.offers.get(offerId) : undefined;
    if (offer === undefined) return { ok: false, error: "expired" };
    if (Date.parse(offer.expiresAt) <= nowMs) {
      this.evict(offer);
      return { ok: false, error: "expired" };
    }
    this.evict(offer);
    const graceExpiryMs = Date.parse(offer.expiresAt) + this.graceMs;
    this.consumed.set(hashSecret(offer.offerSecret), graceExpiryMs);
    this.consumed.set(hashCode(offer.code), graceExpiryMs);
    return { ok: true, offer };
  }

  private evict(offer: StoredPairingOffer): void {
    this.offers.delete(offer.offerId);
    this.bySecretHash.delete(hashSecret(offer.offerSecret));
    this.byCodeHash.delete(hashCode(offer.code));
  }
}

/** Normalize a typed code for hashing: uppercase, strip dashes and whitespace. */
function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "");
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function hashCode(code: string): string {
  return createHash("sha256").update(normalizeCode(code)).digest("hex");
}
