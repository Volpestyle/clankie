import { createHash, randomBytes, randomInt } from "node:crypto";
import { type DomainEvent, type PairingOfferWire } from "@clankie/protocol";
import { z } from "zod";

// Device pairing-offer minting and single-use redemption for the service.
// An offer is short-lived display data an operator hands to a device; it is not
// a grant. Redemption (VUH-727) turns a presented offer secret or typed code
// into a durable device identity — see devices.ts and the /v1/pairing/* routes.
// A review offer (ADR 0154) is the same single-use offer with a lifetime of
// days; its hashes also go to the durable log so it survives a restart.

/** Wire version of the offer shape. */
const PAIRING_OFFER_VERSION = 1 as const;

/** Offers are short-lived by contract: single-use display data, not credentials. */
const DEFAULT_PAIRING_OFFER_TTL_MS = 5 * 60_000;

/** How long a consumed offer's secret/code still reads as "consumed" before it reads as "expired". */
const DEFAULT_CONSUMED_GRACE_MS = 5 * 60_000;

const DAY_MS = 24 * 60 * 60_000;

/** Deep-link base recognized by the Clankie app (reference UX: `clankie://connect`). */
const PAIRING_DEEP_LINK_BASE = "clankie://connect";

/**
 * Typed-pairing alphabet: unambiguous uppercase (no 0/O, 1/I/L) so a human can
 * read the code off one screen and type it on another.
 */
const PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const PAIRING_CODE_GROUPS = 2;
const PAIRING_CODE_GROUP_LENGTH = 4;

/**
 * What redemption needs once the secrets have left for the operator's screen:
 * the offer keyed by the hashes the gateway also routes on. Secret-free.
 */
export interface PairingOfferRecord {
  /** Non-secret audit handle for logs and semantic events. */
  readonly offerId: string;
  /** sha256 hex of the offer secret — the gateway's `offerHash`. */
  readonly offerHash: string;
  /** sha256 hex of the normalized typed code — the gateway's `codeHash`. */
  readonly codeHash: string;
  readonly mintedBy: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** Long-lived review offer (ADR 0154). */
  readonly review?: true;
}

/**
 * One minted offer. `code` and `offerSecret` are secret-bearing display data:
 * they go to the authenticated operator's terminal and never into logs or
 * recorded events — audit trails reference `offerId` only.
 */
export interface StoredPairingOffer extends PairingOfferRecord {
  /** Secret short code for typed pairing on camera-less devices. */
  readonly code: string;
  /** Secret high-entropy capability carried by the QR deep link. */
  readonly offerSecret: string;
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
  /** Review offer lifetime in days; the route validates the ceiling. */
  readonly review?: { readonly days: number };
  /** Non-secret id source only; code and offer secret always come from crypto randomness. */
  readonly idFactory?: () => string;
}

/** Mint one single-use offer record. Pure aside from crypto randomness. */
export function mintPairingOffer(options: MintPairingOfferOptions): StoredPairingOffer {
  const idFactory = options.idFactory ?? (() => randomBytes(16).toString("hex"));
  const ttlMs =
    options.review !== undefined
      ? options.review.days * DAY_MS
      : (options.ttlMs ?? DEFAULT_PAIRING_OFFER_TTL_MS);
  const code = mintPairingCode();
  const offerSecret = randomBytes(16).toString("base64url");
  return {
    offerId: `pairing-offer-${idFactory().slice(0, 12)}`,
    code,
    offerSecret,
    offerHash: hashPairingSecret(offerSecret),
    codeHash: hashPairingCode(code),
    mintedBy: options.mintedBy,
    createdAt: options.now.toISOString(),
    expiresAt: new Date(options.now.getTime() + ttlMs).toISOString(),
    ...(options.review === undefined ? {} : { review: true as const }),
  };
}

/** The secret-free record of a minted offer: what the store and the log keep. */
export function pairingOfferRecord(offer: StoredPairingOffer): PairingOfferRecord {
  const { code: _code, offerSecret: _offerSecret, ...record } = offer;
  return record;
}

/** Project a stored offer onto the wire shape `clankie pair` expects. */
export function pairingOfferWire(offer: StoredPairingOffer): PairingOfferWire {
  return {
    version: PAIRING_OFFER_VERSION,
    deepLink: `${PAIRING_DEEP_LINK_BASE}?v=${PAIRING_OFFER_VERSION}&offer=${offer.offerSecret}`,
    code: offer.code,
    expiresAt: offer.expiresAt,
    ...(offer.review === undefined ? {} : { review: true as const }),
  };
}

const ReviewOfferMintedSchema = z.object({
  type: z.literal("pairing.offer.minted"),
  occurredAt: z.string(),
  data: z.object({
    offerId: z.string().min(1),
    operatorId: z.string().min(1),
    expiresAt: z.string().datetime(),
    review: z.literal(true),
    offerHash: z.string().regex(/^[a-f0-9]{64}$/u),
    codeHash: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
});

/**
 * Review offers still open at boot (ADR 0154): every `pairing.offer.minted`
 * that carried hashes, minus the ones a `device.pairing.redeemed` consumed and
 * the ones already past expiry. Ordinary offers record no hashes and die with
 * the process, as before.
 *
 * The hashes in the 0600 event log are the same hashes the gateway holds in
 * memory. The typed code has ~40 bits, so its hash is brute-forceable by
 * whoever can read the log — the operator, who can already mint offers.
 */
export function replayReviewOffers(events: readonly DomainEvent[], now: Date): PairingOfferRecord[] {
  const redeemed = new Set<string>();
  for (const event of events) {
    if (event.type !== "device.pairing.redeemed") continue;
    const offerId = (event.data as { readonly offerId?: unknown }).offerId;
    if (typeof offerId === "string") redeemed.add(offerId);
  }
  const records: PairingOfferRecord[] = [];
  for (const event of events) {
    const parsed = ReviewOfferMintedSchema.safeParse(event);
    if (!parsed.success) continue;
    const { offerId, operatorId, expiresAt, offerHash, codeHash } = parsed.data.data;
    if (redeemed.has(offerId) || Date.parse(expiresAt) <= now.getTime()) continue;
    records.push({
      offerId,
      offerHash,
      codeHash,
      mintedBy: operatorId,
      createdAt: parsed.data.occurredAt,
      expiresAt,
      review: true,
    });
  }
  return records;
}

export type TakePairingOfferResult =
  | { readonly ok: true; readonly offer: PairingOfferRecord }
  | { readonly ok: false; readonly error: "consumed" | "expired" };

/**
 * In-memory registry of outstanding pairing offers with constant-time-equivalent
 * lookup by hashed secret or typed code. Consumption is synchronous so two
 * concurrent redemptions of the same offer cannot both succeed. A consumed
 * offer's secret and code read as `consumed` for a grace window, then as
 * `expired` — identical to an unknown or pruned value, so redemption never
 * becomes an offer-enumeration oracle. Holds hashes only; raw secrets never
 * outlive the mint response.
 */
export class PairingOfferStore {
  private readonly offers = new Map<string, PairingOfferRecord>();
  private readonly bySecretHash = new Map<string, string>();
  private readonly byCodeHash = new Map<string, string>();
  private readonly consumed = new Map<string, number>();
  private readonly graceMs: number;

  public constructor(options: { readonly consumedGraceMs?: number } = {}) {
    this.graceMs = options.consumedGraceMs ?? DEFAULT_CONSUMED_GRACE_MS;
  }

  public add(record: PairingOfferRecord): void {
    this.offers.set(record.offerId, record);
    this.bySecretHash.set(record.offerHash, record.offerId);
    this.byCodeHash.set(record.codeHash, record.offerId);
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
    const secretHash =
      presented.offerSecret !== undefined ? hashPairingSecret(presented.offerSecret) : undefined;
    const codeHash = presented.code !== undefined ? hashPairingCode(presented.code) : undefined;
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
    this.consumed.set(offer.offerHash, graceExpiryMs);
    this.consumed.set(offer.codeHash, graceExpiryMs);
    return { ok: true, offer };
  }

  private evict(offer: PairingOfferRecord): void {
    this.offers.delete(offer.offerId);
    this.bySecretHash.delete(offer.offerHash);
    this.byCodeHash.delete(offer.codeHash);
  }
}

/** Normalize a typed code for hashing: uppercase, strip dashes and whitespace. */
function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "");
}

/** The gateway's `offerHash`: sha256 hex of the raw offer secret. */
export function hashPairingSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** The gateway's `codeHash`: sha256 hex of the normalized typed code. */
export function hashPairingCode(code: string): string {
  return createHash("sha256").update(normalizeCode(code)).digest("hex");
}
