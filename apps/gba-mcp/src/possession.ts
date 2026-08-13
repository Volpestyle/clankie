/**
 * Possession: one mind drives the body at a time.
 *
 * An external harness driving Clankie is not a second concurrent driver — it is
 * a *holder* of a revocable lease. This repo already reaches for that shape for
 * control and environment leases, and "two minds, one body" is exactly what it
 * is for. Letting both an MCP possessor and the free-play loop dispatch would
 * produce a character twitching between two intents.
 *
 * The possessor is a **new principal class**. It is deliberately not the ambient
 * tier and not the voice tier: possessing the body is a different consequence
 * from summoning Clankie into a call or asking him to do something, and
 * [ADR 0050](../../../docs/adr/0050-voice-presence-authority-tier.md) set the
 * precedent that a different consequence gets its own named, deny-by-default
 * binding rather than being folded into an existing one.
 *
 * Deny-by-default is literal: with no holder configured, nothing can acquire,
 * so gameplay is refused and only observation remains.
 */
import { randomUUID } from "node:crypto";

export const POSSESSION_PRINCIPAL_KIND = "mcp_possessor" as const;

export interface PossessionGrant {
  token: string;
  holderId: string;
  expiresAt: number;
}

export interface PossessionEvent {
  type: "acquired" | "released" | "expired" | "stolen" | "refused";
  holderId: string;
  /** Present when one holder took the body from another. */
  previousHolderId?: string;
  reason?: string;
}

export interface PossessionLeaseOptions {
  /**
   * Holder ids permitted to possess. Empty means possession is unavailable —
   * the capability is off until an owner names someone explicitly.
   */
  allowedHolders: Iterable<string>;
  ttlMs?: number;
  now?: () => number;
  /** Every transition is logged; possession is never silent. */
  onEvent?: (event: PossessionEvent) => void;
  /**
   * Called when the body changes hands, so a co-hosted free-play loop can
   * suspend rather than race. Suspension is the point: arbitration after the
   * fact would still have let two intents reach the core.
   */
  onHeldChange?: (held: boolean) => void;
}

const DEFAULT_TTL_MS = 10 * 60_000;

export class PossessionLease {
  private readonly allowed: ReadonlySet<string>;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly onEvent: (event: PossessionEvent) => void;
  private readonly onHeldChange: (held: boolean) => void;
  private grant: PossessionGrant | null = null;

  public constructor(options: PossessionLeaseOptions) {
    this.allowed = new Set(options.allowedHolders);
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? (() => Date.now());
    this.onEvent = options.onEvent ?? (() => undefined);
    this.onHeldChange = options.onHeldChange ?? (() => undefined);
  }

  /** The live holder, after expiry is applied. */
  public current(): PossessionGrant | null {
    if (this.grant === null) return null;
    if (this.grant.expiresAt > this.now()) return this.grant;
    const expired = this.grant;
    this.grant = null;
    this.onEvent({ type: "expired", holderId: expired.holderId });
    this.onHeldChange(false);
    return null;
  }

  /**
   * Take the body. Stealing from a live holder requires `force`, so it is an
   * explicit act rather than the outcome of a race.
   */
  public acquire(holderId: string, options: { force?: boolean } = {}): PossessionGrant {
    if (!this.allowed.has(holderId)) {
      this.onEvent({ type: "refused", holderId, reason: "holder_not_allowed" });
      throw new Error("possession_holder_not_allowed");
    }
    const held = this.current();
    if (held !== null && held.holderId !== holderId && options.force !== true) {
      this.onEvent({ type: "refused", holderId, reason: "already_held" });
      throw new Error("possession_already_held");
    }
    const previousHolderId = held?.holderId;
    this.grant = {
      token: randomUUID(),
      holderId,
      expiresAt: this.now() + this.ttlMs,
    };
    this.onEvent(
      previousHolderId !== undefined && previousHolderId !== holderId
        ? { type: "stolen", holderId, previousHolderId }
        : { type: "acquired", holderId },
    );
    if (held === null) this.onHeldChange(true);
    return this.grant;
  }

  public release(token: string): void {
    const held = this.current();
    if (held === null || held.token !== token) return;
    this.grant = null;
    this.onEvent({ type: "released", holderId: held.holderId });
    this.onHeldChange(false);
  }

  /**
   * Gate for gameplay tools. Observation deliberately does not call this: seeing
   * the game is not driving it, and a harness should be able to look before
   * deciding whether to take the body.
   *
   * Acting slides the expiry: a holder that is driving is alive, so the TTL
   * bounds how long an *idle* possessor keeps the body from the resident loop,
   * not how long a session of play may last.
   */
  public assertMayAct(token: string | undefined): void {
    const held = this.current();
    if (held === null) throw new Error("possession_lease_not_held");
    if (token !== held.token) throw new Error("possession_lease_held_by_another");
    this.grant = { ...held, expiresAt: this.now() + this.ttlMs };
  }
}

/** Parse the deny-by-default holder allowlist. Unset means possession is off. */
export function parsePossessionHolders(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0) ?? []
  );
}
