export interface DiscordVoiceConsentSession {
  readonly guildId: string;
  readonly channelId: string;
  readonly policy: DiscordVoiceConsentPolicy;
  readonly consentedUserIds: ReadonlySet<string>;
}

/**
 * Who counts as having said yes to being heard.
 *
 * - `explicit` (default): consent arrives only through the opt-in command, and
 *   restart, leave, channel move, or revocation removes it. Presence alone is
 *   never consent.
 * - `presence`: being in Clankie's active channel is consent — an owner
 *   decision for a private deployment whose participants know he transcribes
 *   when he is in the room. An explicit opt-out still binds for the rest of
 *   the session: presence implies yes, but saying no always wins.
 */
export type DiscordVoiceConsentPolicy = "explicit" | "presence";

/** Ephemeral, session-bound consent, judged under the configured policy. */
export class DiscordVoiceConsentRegistry {
  private readonly policy: DiscordVoiceConsentPolicy;
  private session:
    | {
        readonly guildId: string;
        readonly channelId: string;
        readonly consentedUserIds: Set<string>;
        readonly refusedUserIds: Set<string>;
      }
    | undefined;

  public constructor(policy: DiscordVoiceConsentPolicy = "explicit") {
    this.policy = policy;
  }

  /**
   * Opens the session for one guild voice channel. `invokingUserId` is the
   * slash invoker who saw the join disclosure in their ephemeral reply and is
   * auto-opted-in; an asked join (ADR 0062) passes nobody, so under the
   * explicit policy every participant — the asker included — consents only
   * through `/clankie voice-consent opt-in`, which carries the residency
   * disclosure.
   */
  public open(guildId: string, channelId: string, invokingUserId?: string): DiscordVoiceConsentSession {
    this.session = {
      guildId,
      channelId,
      consentedUserIds: new Set(invokingUserId === undefined ? [] : [invokingUserId]),
      refusedUserIds: new Set(),
    };
    return this.snapshot();
  }

  public set(
    guildId: string,
    channelId: string,
    userId: string,
    consented: boolean,
  ): DiscordVoiceConsentSession {
    const session = this.requireSession(guildId, channelId);
    if (consented) {
      session.consentedUserIds.add(userId);
      session.refusedUserIds.delete(userId);
    } else {
      session.consentedUserIds.delete(userId);
      // A refusal outlives leaving and rejoining the channel: under the
      // presence policy, rejoining must not silently undo a spoken "no".
      session.refusedUserIds.add(userId);
    }
    return this.snapshot();
  }

  public memberChannelChanged(userId: string, channelId: string | undefined): void {
    if (this.session !== undefined && channelId !== this.session.channelId) {
      this.session.consentedUserIds.delete(userId);
    }
  }

  public permits(guildId: string, channelId: string, userId: string): boolean {
    if (this.session?.guildId !== guildId || this.session.channelId !== channelId) return false;
    if (this.session.refusedUserIds.has(userId)) return false;
    if (this.policy === "presence") {
      // Audio only arrives from participants of the active channel, so a
      // speaking user is by definition present in the room he occupies.
      return true;
    }
    return this.session.consentedUserIds.has(userId);
  }

  public close(): void {
    this.session = undefined;
  }

  public current(): DiscordVoiceConsentSession | undefined {
    return this.session === undefined ? undefined : this.snapshot();
  }

  private requireSession(
    guildId: string,
    channelId: string,
  ): {
    readonly guildId: string;
    readonly channelId: string;
    readonly consentedUserIds: Set<string>;
    readonly refusedUserIds: Set<string>;
  } {
    if (this.session?.guildId !== guildId || this.session.channelId !== channelId) {
      throw new Error("Voice consent is valid only in Clankie's active guild voice channel");
    }
    return this.session;
  }

  private snapshot(): DiscordVoiceConsentSession {
    if (this.session === undefined) throw new Error("Discord voice consent session is not active");
    return {
      guildId: this.session.guildId,
      channelId: this.session.channelId,
      policy: this.policy,
      consentedUserIds: new Set(this.session.consentedUserIds),
    };
  }
}
