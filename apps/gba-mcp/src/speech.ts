/**
 * Speaking as Clankie, from a possessor.
 *
 * ## Why this is a port and not an HTTP call
 *
 * The obvious implementation — have the possessor call the control plane's
 * `POST /v1/discord/presence-actions` directly — does not work, and the reason
 * is a deliberate fence rather than an oversight.
 *
 * That endpoint requires a **live presence claim**: the session id, phase, and
 * monotonic revision that the Discord bridge publishes as it holds the gateway
 * ([ADR 0024](../../../docs/adr/0024-discord-dual-plane-presence.md)). Only the
 * bridge can produce one, and that is the point — it fences an action against a
 * session that is live *right now*, so a stale or absent session cannot be
 * spoken through. A possessor holds no gateway and therefore holds no claim.
 *
 * So a possessor never speaks directly. It asks the process that owns the body
 * in Discord to speak for it, which also keeps the ADR 0047 invariant intact:
 * possession changes who is deciding, never which account is present. Clankie
 * remains the bot in the channel.
 *
 * Deny-by-default: with no port wired, speaking is refused with a reason rather
 * than silently dropped.
 */
export interface ClankieSpeechPort {
  /**
   * Say something as Clankie in the channel he is present in.
   *
   * The implementation is expected to route through the bridge's existing
   * policy-gated presence path, so doctrine, rate ledger, and the live-session
   * fence all still apply. It must not accept a channel id from the caller: a
   * possessor drives the character, it does not choose new audiences.
   */
  say(text: string): Promise<void>;
}

export const CLANKIE_SPEECH_MAX = 2_000;

/**
 * The default. Speaking is unavailable until an owner wires a real port, and
 * the refusal explains what is missing instead of failing opaquely.
 */
export const deniedSpeechPort: ClankieSpeechPort = {
  say: () =>
    Promise.reject(
      new Error(
        "clankie_speech_unavailable: no speech port is wired. A possessor cannot speak directly — " +
          "the control plane's presence action requires a live claim only the Discord bridge can mint.",
      ),
    ),
};

/**
 * Hearing: what was said near Clankie recently.
 *
 * Symmetric to {@link ClankieSpeechPort} and blocked by the same fence — a
 * possessor holds no gateway, so it cannot subscribe to voice itself. The
 * process that owns the body in Discord supplies what it already captured
 * under the existing consent rules ([ADR 0045](../../../docs/adr/0045-official-bot-dave-group-voice.md)).
 *
 * Consent is not re-litigated here: a possessor hears exactly what Clankie was
 * already permitted to hear, and nothing that only consented speakers produced
 * becomes available because a possessor asked. Raw audio never crosses this
 * seam — transcripts only, already bounded by the voice plane.
 */
export interface ClankieHearingPort {
  /** Recent transcript lines, oldest first, already consent-filtered. */
  recent(limit: number): Promise<string[]>;
}

export const CLANKIE_HEARING_MAX_LINES = 50;

/** Denied by default, with the same explanation as speech. */
export const deniedHearingPort: ClankieHearingPort = {
  recent: () =>
    Promise.reject(
      new Error(
        "clankie_hearing_unavailable: no hearing port is wired. A possessor cannot subscribe to " +
          "voice directly — only the Discord bridge holds the gateway and the consent registry.",
      ),
    ),
};
