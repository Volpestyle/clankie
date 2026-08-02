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
   * Report what just happened in the body, so Clankie can talk about it in the
   * channel he is present in.
   *
   * Named for what it does rather than what a caller wants, because the
   * difference is load-bearing: this is **not** a script. The bridge seeds the
   * text as a conversation item and the persona composes the words (ADR 0064).
   * A caller that passes a finished sentence gets it treated as an event that
   * happened and replied to — the ADR 0074 defect, which reached production
   * precisely because this method used to be called `say`.
   *
   * The implementation is expected to route through the bridge's existing
   * policy-gated presence path, so doctrine, rate ledger, and the live-session
   * fence all still apply. It must not accept a channel id from the caller: a
   * possessor drives the character, it does not choose new audiences.
   */
  narrate(text: string): Promise<void>;
}

export const CLANKIE_SPEECH_MAX = 2_000;

/**
 * The default. Speaking is unavailable until an owner wires a real port, and
 * the refusal explains what is missing instead of failing opaquely.
 */
export const deniedSpeechPort: ClankieSpeechPort = {
  narrate: () =>
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
  /**
   * Subscribe to utterances as they happen. Returns an unsubscribe.
   *
   * **Push, not pull, and that is a privacy constraint rather than a style
   * choice.** Asking the bridge for "the last N lines" would require it to
   * retain transcripts, and it deliberately retains none — raw and generated
   * PCM are zeroed after use and the bot does not persist channel transcripts.
   * A pull-shaped port would have quietly forced whoever implemented it to
   * break that invariant.
   *
   * Handing each utterance to a live subscriber keeps the bridge's retention at
   * zero. What the possessor then holds is its own, lives only while it holds
   * the lease, and dies with it.
   */
  subscribe(listener: (utterance: string) => void): () => void;
}

export const CLANKIE_HEARING_MAX_LINES = 50;

/** Denied by default, with the same explanation as speech. */
export const deniedHearingPort: ClankieHearingPort = {
  subscribe: () => {
    throw new Error(
      "clankie_hearing_unavailable: no hearing port is wired. A possessor cannot subscribe to " +
        "voice directly — only the Discord bridge holds the gateway and the consent registry.",
    );
  },
};

/**
 * What a possessor heard while holding the body.
 *
 * Retention lives here rather than in the bridge: bounded, in memory, and
 * discarded on release. The possessor is a participant in the conversation for
 * as long as it is driving, and stops being one the moment it is not.
 */
export class PossessorHearing {
  private readonly lines: string[] = [];
  private unsubscribe: (() => void) | null = null;

  private readonly port: ClankieHearingPort;
  private readonly max: number;

  public constructor(port: ClankieHearingPort, max = CLANKIE_HEARING_MAX_LINES) {
    this.port = port;
    this.max = max;
  }

  public start(): void {
    if (this.unsubscribe !== null) return;
    this.unsubscribe = this.port.subscribe((utterance) => {
      this.lines.push(utterance);
      if (this.lines.length > this.max) this.lines.shift();
    });
  }

  /** Called on release: what was heard does not outlive the possession. */
  public stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.lines.length = 0;
  }

  public recent(limit: number): string[] {
    return this.lines.slice(-limit);
  }
}
