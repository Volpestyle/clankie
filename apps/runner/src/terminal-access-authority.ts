import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { TerminalDeviceScope } from "@clankie/terminal-protocol";

/**
 * Gateway-local runtime authority that mints and verifies short-lived,
 * device-bound terminal access tokens. It uses only an ephemeral in-process
 * secret; it never loads organization-wide or deploy credentials, and tokens
 * are never logged, persisted, or surfaced in errors.
 *
 * The public runtime capability mints observe-only tokens exclusively — there
 * is no production path to issue a control scope from this slice. The token is
 * `base64url(payload).base64url(HMAC-SHA256(secret, payload))`; the payload
 * binds `principalId + deviceId + scopes + expiry`. Verification is timing-safe
 * over the signature and fails closed on malformed ids, scopes, expiry, or
 * tampering without revealing more than a coarse reason code.
 */
export interface TerminalAccessGrant {
  principalId: string;
  deviceId: string;
  scopes: readonly TerminalDeviceScope[];
}

export type TerminalTokenVerification =
  | { ok: true; grant: TerminalAccessGrant }
  | { ok: false; reason: "missing" | "malformed" | "invalid" | "expired" };

/** The gateway depends only on verification; a fake verifier drives adversarial scope tests. */
export interface TerminalTokenVerifier {
  verify(token: string | undefined): TerminalTokenVerification;
}

export interface TerminalAccessAuthorityOptions {
  /** Overrides the ephemeral secret (tests only). Production uses a random per-process secret. */
  secret?: Uint8Array;
  /** Default token lifetime when a mint call does not override it. */
  defaultTtlMs?: number;
  /** Injectable clock for deterministic expiry tests. */
  now?: () => number;
}

export interface MintObserveTokenInput {
  principalId: string;
  deviceId: string;
  ttlMs?: number;
}

interface TokenPayload {
  p: string;
  d: string;
  s: TerminalDeviceScope[];
  exp: number;
  n: string;
}

const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 300_000;
const DEFAULT_TTL_MS = 60_000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 && ID_PATTERN.test(value);
}

export class TerminalAccessAuthority implements TerminalTokenVerifier {
  private secret: Buffer;
  private readonly defaultTtlMs: number;
  private readonly now: () => number;

  public constructor(options: TerminalAccessAuthorityOptions = {}) {
    this.secret = options.secret ? Buffer.from(options.secret) : randomBytes(32);
    if (this.secret.length < 32) throw new Error("terminal access secret must be at least 32 bytes");
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Rotate the signing secret, invalidating every previously minted token
   * server-side. This is the authoritative shutdown invalidation: it does not
   * depend on deleting any credential file.
   */
  public invalidate(): void {
    this.secret.fill(0);
    this.secret = randomBytes(32);
  }

  /**
   * Mint a short-lived observe-only token bound to a principal and device. This
   * is the only public runtime mint; it can never issue a control scope.
   */
  public mintObserveToken(input: MintObserveTokenInput): string {
    if (!isOpaqueId(input.principalId)) throw new Error("principalId must be an opaque id");
    if (!isOpaqueId(input.deviceId)) throw new Error("deviceId must be an opaque id");
    const ttlMs = input.ttlMs ?? this.defaultTtlMs;
    if (!Number.isInteger(ttlMs) || ttlMs < MIN_TTL_MS || ttlMs > MAX_TTL_MS) {
      throw new Error(`token ttl must be an integer within [${MIN_TTL_MS}, ${MAX_TTL_MS}] ms`);
    }
    const payload: TokenPayload = {
      p: input.principalId,
      d: input.deviceId,
      s: ["observe"],
      exp: this.now() + ttlMs,
      n: Buffer.from(randomBytes(12)).toString("base64url"),
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    return `${encodedPayload}.${this.sign(encodedPayload)}`;
  }

  public verify(token: string | undefined): TerminalTokenVerification {
    if (typeof token !== "string" || token.length === 0) return { ok: false, reason: "missing" };
    const separator = token.indexOf(".");
    if (separator <= 0 || separator === token.length - 1) return { ok: false, reason: "malformed" };
    const encodedPayload = token.slice(0, separator);
    const providedSignature = token.slice(separator + 1);
    if (!this.signatureMatches(encodedPayload, providedSignature)) return { ok: false, reason: "invalid" };
    const payload = this.decodePayload(encodedPayload);
    if (!payload) return { ok: false, reason: "malformed" };
    if (payload.exp <= this.now()) return { ok: false, reason: "expired" };
    return { ok: true, grant: { principalId: payload.p, deviceId: payload.d, scopes: payload.s } };
  }

  private sign(encodedPayload: string): string {
    return createHmac("sha256", this.secret).update(encodedPayload).digest("base64url");
  }

  private signatureMatches(encodedPayload: string, providedSignature: string): boolean {
    const expected = Buffer.from(this.sign(encodedPayload), "base64url");
    let provided: Buffer;
    try {
      provided = Buffer.from(providedSignature, "base64url");
    } catch {
      return false;
    }
    if (provided.length !== expected.length) {
      // Keep the timing profile independent of the token when lengths differ.
      timingSafeEqual(expected, expected);
      return false;
    }
    return timingSafeEqual(provided, expected);
  }

  private decodePayload(encodedPayload: string): TokenPayload | null {
    try {
      const parsed: unknown = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
      if (typeof parsed !== "object" || parsed === null) return null;
      const candidate = parsed as Partial<TokenPayload>;
      if (!isOpaqueId(candidate.p) || !isOpaqueId(candidate.d)) return null;
      if (typeof candidate.exp !== "number" || !Number.isFinite(candidate.exp)) return null;
      if (!Array.isArray(candidate.s) || candidate.s.length === 0) return null;
      const scopes = candidate.s;
      if (!scopes.every((scope) => scope === "observe" || scope === "control")) return null;
      if (new Set(scopes).size !== scopes.length) return null;
      return { p: candidate.p, d: candidate.d, s: scopes, exp: candidate.exp, n: String(candidate.n ?? "") };
    } catch {
      return null;
    }
  }
}
