import {
  DiscordUserSessionOptInSchema,
  type DiscordUserSessionOptIn,
  type DomainEvent,
} from "@clankie/protocol";

/**
 * Durable owner acceptance of user-session transport risk (ADR 0048).
 *
 * Event-sourced like every other authority in the control plane, so the record
 * survives restart, is auditable, and cannot be conjured by configuration. At
 * most one opt-in is live at a time: the capability is "is Clankie allowed to
 * wear a human account right now", which is a single yes/no, not a set.
 */

export const DISCORD_USER_SESSION_OPT_IN_STREAM_ID = "discord-user-session" as const;
export const DISCORD_USER_SESSION_OPT_IN_RECORDED = "discord.user_session.opt_in.recorded" as const;
export const DISCORD_USER_SESSION_OPT_IN_REVOKED = "discord.user_session.opt_in.revoked" as const;

/** Stable stream id; the opt-in is a singleton, so it needs no per-record scope. */
export const DISCORD_USER_SESSION_OPT_IN_MISSION_ID =
  `${DISCORD_USER_SESSION_OPT_IN_STREAM_ID}:opt-in` as const;

export class DiscordUserSessionOptInProjection {
  private current: DiscordUserSessionOptIn | undefined;

  public constructor(events: readonly DomainEvent[] = []) {
    for (const event of events) this.apply(event);
  }

  public apply(event: DomainEvent): void {
    if (event.missionId !== DISCORD_USER_SESSION_OPT_IN_MISSION_ID) return;
    if (event.type === DISCORD_USER_SESSION_OPT_IN_RECORDED) {
      // The record is nested under `optIn` so audit fields (who accepted it)
      // can travel on the same event without a strict-schema parse rejecting
      // them — which would silently drop the opt-in on replay.
      const parsed = DiscordUserSessionOptInSchema.safeParse(event.data.optIn);
      if (parsed.success) this.current = parsed.data;
      return;
    }
    if (event.type === DISCORD_USER_SESSION_OPT_IN_REVOKED) {
      const revokedAt = typeof event.data.revokedAt === "string" ? event.data.revokedAt : event.occurredAt;
      const optInId = typeof event.data.optInId === "string" ? event.data.optInId : undefined;
      if (this.current === undefined || (optInId !== undefined && this.current.optInId !== optInId)) return;
      this.current = { ...this.current, revokedAt };
    }
  }

  /** The live record, or `undefined` when none was ever recorded. */
  public resolve(): DiscordUserSessionOptIn | undefined {
    return this.current === undefined ? undefined : structuredClone(this.current);
  }

  /**
   * The record only if it currently permits the transport under `profileHash`.
   * Callers gating execution should use this rather than `resolve()`, so a
   * revoked or stale-doctrine record can never read as permission.
   */
  public resolveActive(profileHash: string): DiscordUserSessionOptIn | undefined {
    const optIn = this.resolve();
    if (optIn === undefined) return undefined;
    if (optIn.revokedAt !== undefined) return undefined;
    return optIn.profileHash === profileHash ? optIn : undefined;
  }
}
