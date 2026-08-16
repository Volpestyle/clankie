/**
 * Clankie's floor in a group voice channel.
 *
 * The Realtime API's turn-taking defaults assume one user talking to one
 * assistant; [ADR 0057](../../../docs/adr/0057-realtime-voice-with-captain-handoff.md)
 * rejects them for a room and keeps the floor as a state machine this
 * repository owns. Engagement is not a permission that conversation grants and
 * revokes — it is downstream of one question asked continuously over the
 * transcript stream: *does he have a reason to say something right now?*
 * Being addressed answers it trivially and for free. When nobody addressed
 * him, this machine answers only the mechanical half — *may an unprompted turn
 * be offered at all right now?* — and the realtime Clankie session answers the
 * part that needs a personality. Release is the absence of an answer: the decay
 * window, and only the decay window. No phrase releases the floor, because
 * "thanks, clankie" is someone speaking to him and he gets to answer it.
 *
 * Pure by construction: no I/O, no timers, no Date.now. Time arrives as
 * explicit `atMs` numbers from the caller, which is what makes every decay and
 * rate-cap branch provable under a test's clock and keeps the media owner the
 * only component that knows what time it is. Events are assumed to arrive in
 * `atMs` order; the machine never sleeps, so decay is evaluated lazily on each
 * transcript and on `tick`.
 */

import { voiceAddressesCharacter } from "./voice-address.ts";

export type FloorState = "dormant" | "engaged";

export interface VoiceFloorOptions {
  /** `characterNames(persona)`: displayName + aliases, lowercased. */
  readonly names: readonly string[];
  /** Same setting, same meaning as the text plane: `all` wakes on anything. */
  readonly replyPolicy: "addressed" | "all";
  /** Sets the unprompted-turn rate-cap defaults; ADR 0051 reserved it for exactly this. */
  readonly chattiness: "quiet" | "balanced" | "chatty";
  /** How long an engagement survives without a reason to hold the floor. */
  readonly decayWindowMs?: number;
  /** Owner overrides for the unprompted-turn rate cap; defaults derive from chattiness. */
  readonly volition?: {
    readonly minIntervalMs?: number;
    readonly maxPerHour?: number;
  };
}

export interface VoiceTranscriptEvent {
  /** Discord gateway identity, never inferred from audio (ADR 0057). */
  readonly speakerId: string;
  readonly text: string;
  readonly atMs: number;
}

export type FloorDecision =
  | { readonly action: "wake"; readonly reason: "addressed" | "reply_policy_all" | "volition" }
  /** Engaged: the floor holder continued, or someone re-addressed him (floor moves to that speaker). */
  | { readonly action: "hold" }
  /** The only way the floor is ever given up: nothing gave him a reason to keep it. */
  | { readonly action: "release"; readonly reason: "decay" }
  | { readonly action: "ignore" }
  /** Dormant and unaddressed, and the rate cap permits offering him one unprompted turn now. */
  | { readonly action: "volition_gate_open" };

/**
 * Monotonic counters, per ADR 0057's consequence: unprompted speech lands on
 * humans, so "he talks too much" and "he never speaks up" must both be
 * falsifiable against a number instead of a vibe. `offered` counts gate
 * openings; `taken`/`suppressed` count what the realtime session did with the
 * turn it was offered — spoke, or passed. The machine only accepts an outcome
 * while an offer is outstanding, so `taken + suppressed <= offered` always
 * holds.
 */
export interface VolitionAccounting {
  readonly offered: number;
  readonly taken: number;
  readonly suppressed: number;
}

/**
 * How long he holds the floor with no reason to keep it. Roughly the length of
 * a conversational lull that means "we moved on" rather than "we paused".
 * A deliberate default, not a finding — the owner tunes it from a real call
 * (mission `realtime-voice-0057`, human decision 1).
 */
export const DEFAULT_DECAY_WINDOW_MS = 60_000;

export interface VolitionRateCap {
  /** Minimum quiet time since the last offer before the gate opens again. */
  readonly minIntervalMs: number;
  /** Offers permitted in any sliding hour. Zero disables volition entirely. */
  readonly maxPerHour: number;
}

/**
 * The rate cap is load-bearing, not protective tuning: it is the only thing
 * standing between phonetic tolerance tuned toward false positives and a bot
 * that interjects into human conversation. Numbers err conservative — these
 * cap how often he is *offered* an unprompted turn; he passes on most of them,
 * so actual speech runs well under them.
 */
export const VOLITION_DEFAULTS: Readonly<Record<VoiceFloorOptions["chattiness"], VolitionRateCap>> = {
  quiet: { minIntervalMs: 600_000, maxPerHour: 2 },
  balanced: { minIntervalMs: 240_000, maxPerHour: 6 },
  chatty: { minIntervalMs: 90_000, maxPerHour: 15 },
};

const HOUR_MS = 3_600_000;

interface PendingOffer {
  /** Whose remark opened the gate; if the offer is taken, they hold the floor. */
  readonly speakerId: string;
  readonly atMs: number;
}

/**
 * The dormant ↔ engaged floor machine from ADR 0057.
 *
 * Decision precedence encodes the mission's failure asymmetry — a missed wake
 * reads as broken, a stray reply does not:
 *
 * - Being addressed always wins. It wakes from dormant, holds (and moves the
 *   floor) while engaged, and even revives a stale engagement as a fresh wake,
 *   because a person who spoke to him must never be eaten by a decay check.
 *   Nothing outranks it — "thanks, clankie" is an address like any other, and
 *   he answers it rather than being cut off mid-goodbye by a word list.
 * - Decay is evaluated before anything else touches an engaged floor: an event
 *   arriving after the window belongs to whatever conversation comes next, so
 *   it is judged under dormant rules and, if it wakes nothing, surfaces the
 *   overdue `release(decay)`.
 * - The volition gate opens only from dormant, only on new transcript — never
 *   a timer, so an empty room costs nothing and silence stays free.
 */
export class VoiceFloor {
  private readonly names: readonly string[];
  private readonly replyPolicy: VoiceFloorOptions["replyPolicy"];
  private readonly decayWindowMs: number;
  private readonly minIntervalMs: number;
  private readonly maxPerHour: number;

  private floorState: FloorState = "dormant";
  private holderId: string | undefined;
  private lastRelevantAtMs: number | undefined;

  private offerTimesMs: number[] = [];
  private lastOfferAtMs: number | undefined;
  private pendingOffer: PendingOffer | undefined;
  private offered = 0;
  private takenCount = 0;
  private suppressedCount = 0;

  public constructor(options: VoiceFloorOptions) {
    this.names = options.names;
    this.replyPolicy = options.replyPolicy;
    this.decayWindowMs = options.decayWindowMs ?? DEFAULT_DECAY_WINDOW_MS;
    const caps = VOLITION_DEFAULTS[options.chattiness];
    this.minIntervalMs = options.volition?.minIntervalMs ?? caps.minIntervalMs;
    this.maxPerHour = options.volition?.maxPerHour ?? caps.maxPerHour;
    if (!Number.isFinite(this.decayWindowMs) || this.decayWindowMs <= 0) {
      throw new Error("Voice floor decayWindowMs must be a positive number of milliseconds");
    }
    if (!Number.isFinite(this.minIntervalMs) || this.minIntervalMs < 0) {
      throw new Error("Voice floor volition minIntervalMs must be a non-negative number");
    }
    if (!Number.isInteger(this.maxPerHour) || this.maxPerHour < 0) {
      throw new Error("Voice floor volition maxPerHour must be a non-negative integer");
    }
  }

  public get state(): FloorState {
    return this.floorState;
  }

  /**
   * Undefined while dormant. While engaged it is whoever most recently
   * addressed him — or, after a taken volition offer, whoever's remark
   * provoked it, so the natural nameless reply to his interjection reads as
   * conversation rather than crosstalk.
   */
  public get floorHolderId(): string | undefined {
    return this.holderId;
  }

  public observeTranscript(event: VoiceTranscriptEvent): FloorDecision {
    if (this.floorState === "engaged") {
      if (!this.decayed(event.atMs)) return this.observeEngaged(event);
      // The engagement already ended before this event arrived; the event
      // belongs to whatever comes next. If it wakes him the release is
      // subsumed — the wake tells the caller to re-seed anyway. If it does
      // not, the overdue release is the decision, and the volition gate waits
      // for the next transcript rather than piggybacking on this one.
      this.drop();
      return this.wakeFor(event) ?? { action: "release", reason: "decay" };
    }
    const wake = this.wakeFor(event);
    if (wake !== undefined) return wake;
    return this.volitionGate(event);
  }

  /** His own speech is a reason to hold the floor; playback refreshes decay. */
  public noteAssistantSpokeAt(atMs: number): void {
    if (this.floorState === "engaged") this.lastRelevantAtMs = atMs;
  }

  /**
   * What the realtime session did with the turn it was offered. `offered` was
   * counted when the gate opened; this records whether he actually spoke. A
   * taken offer engages the floor from dormant — the ADR's "he had something
   * to say" transition — and returns the `wake(volition)` decision so the
   * caller learns it from the same union every other transition uses. If an
   * addressed wake beat the outcome to it, the accounting still lands but the
   * floor is left alone. Without an outstanding offer this is a no-op, which is
   * what keeps `taken + suppressed <= offered` an invariant rather than a hope.
   */
  public noteVolitionOutcome(taken: boolean): FloorDecision {
    if (this.pendingOffer === undefined) return { action: "ignore" };
    const pending = this.pendingOffer;
    this.pendingOffer = undefined;
    if (!taken) {
      this.suppressedCount += 1;
      return { action: "ignore" };
    }
    this.takenCount += 1;
    if (this.floorState === "engaged") return { action: "ignore" };
    this.engage(pending.speakerId, pending.atMs);
    return { action: "wake", reason: "volition" };
  }

  /**
   * Lazy decay check for silence: transcripts stop arriving when the room goes
   * quiet, so the caller must be able to ask "is the floor stale?" without a
   * phrase. Never opens the volition gate — that runs on new transcript only.
   */
  public tick(atMs: number): FloorDecision {
    if (this.floorState === "engaged" && this.decayed(atMs)) {
      this.drop();
      return { action: "release", reason: "decay" };
    }
    return { action: "ignore" };
  }

  public accounting(): VolitionAccounting {
    return { offered: this.offered, taken: this.takenCount, suppressed: this.suppressedCount };
  }

  private observeEngaged(event: VoiceTranscriptEvent): FloorDecision {
    if (!hasSpeech(event.text)) return { action: "ignore" };
    if (voiceAddressesCharacter(event.text, this.names)) {
      this.holderId = event.speakerId;
      this.lastRelevantAtMs = event.atMs;
      return { action: "hold" };
    }
    if (event.speakerId === this.holderId) {
      this.lastRelevantAtMs = event.atMs;
      return { action: "hold" };
    }
    // Crosstalk between other people. Deliberately does not refresh decay:
    // a lively room talking among itself is evidence the floor should lapse,
    // not that it should be held.
    return { action: "ignore" };
  }

  /** Dormant judgment of one transcript; mutates into engaged on a wake. */
  private wakeFor(event: VoiceTranscriptEvent): FloorDecision | undefined {
    if (!hasSpeech(event.text)) return undefined;
    if (voiceAddressesCharacter(event.text, this.names)) {
      this.engage(event.speakerId, event.atMs);
      return { action: "wake", reason: "addressed" };
    }
    if (this.replyPolicy === "all") {
      this.engage(event.speakerId, event.atMs);
      return { action: "wake", reason: "reply_policy_all" };
    }
    return undefined;
  }

  private volitionGate(event: VoiceTranscriptEvent): FloorDecision {
    if (!hasSpeech(event.text)) return { action: "ignore" };
    if (this.maxPerHour === 0) return { action: "ignore" };
    this.offerTimesMs = this.offerTimesMs.filter((offerAt) => offerAt > event.atMs - HOUR_MS);
    if (this.lastOfferAtMs !== undefined && event.atMs - this.lastOfferAtMs < this.minIntervalMs) {
      return { action: "ignore" };
    }
    if (this.offerTimesMs.length >= this.maxPerHour) return { action: "ignore" };
    this.offered += 1;
    this.offerTimesMs.push(event.atMs);
    this.lastOfferAtMs = event.atMs;
    this.pendingOffer = { speakerId: event.speakerId, atMs: event.atMs };
    return { action: "volition_gate_open" };
  }

  private engage(speakerId: string, atMs: number): void {
    this.floorState = "engaged";
    this.holderId = speakerId;
    this.lastRelevantAtMs = atMs;
  }

  private drop(): void {
    this.floorState = "dormant";
    this.holderId = undefined;
    this.lastRelevantAtMs = undefined;
  }

  private decayed(atMs: number): boolean {
    return this.lastRelevantAtMs !== undefined && atMs - this.lastRelevantAtMs > this.decayWindowMs;
  }
}

/**
 * A transcript with no letters or digits — VAD artifacts, stray punctuation —
 * is not speech: it must not wake him under `all`, refresh a held floor, or
 * spend a volition offer.
 */
function hasSpeech(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}
