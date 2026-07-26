export interface DiscordVoiceConsentSession {
  readonly guildId: string;
  readonly channelId: string;
  readonly consentedUserIds: ReadonlySet<string>;
}

/**
 * Ephemeral, session-bound consent. Restart, leave, channel move, or explicit
 * revocation removes consent; it is never inferred from presence alone.
 */
export class DiscordVoiceConsentRegistry {
  private session:
    | { readonly guildId: string; readonly channelId: string; readonly consentedUserIds: Set<string> }
    | undefined;

  /**
   * Opens the session for one guild voice channel. `invokingUserId` is the
   * slash invoker who saw the join disclosure in their ephemeral reply and is
   * auto-opted-in; an asked join (ADR 0062) passes nobody, so every
   * participant — the asker included — consents only through
   * `/clankie voice-consent opt-in`, which carries the residency disclosure.
   */
  public open(guildId: string, channelId: string, invokingUserId?: string): DiscordVoiceConsentSession {
    this.session = {
      guildId,
      channelId,
      consentedUserIds: new Set(invokingUserId === undefined ? [] : [invokingUserId]),
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
    if (consented) session.consentedUserIds.add(userId);
    else session.consentedUserIds.delete(userId);
    return this.snapshot();
  }

  public memberChannelChanged(userId: string, channelId: string | undefined): void {
    if (this.session !== undefined && channelId !== this.session.channelId) {
      this.session.consentedUserIds.delete(userId);
    }
  }

  public permits(guildId: string, channelId: string, userId: string): boolean {
    return (
      this.session?.guildId === guildId &&
      this.session.channelId === channelId &&
      this.session.consentedUserIds.has(userId)
    );
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
  ): { readonly guildId: string; readonly channelId: string; readonly consentedUserIds: Set<string> } {
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
      consentedUserIds: new Set(this.session.consentedUserIds),
    };
  }
}
