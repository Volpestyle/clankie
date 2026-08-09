/**
 * The external-voice conversation port
 * ([ADR 0070](../../../docs/adr/0070-external-voice-via-streaming-tts.md)).
 *
 * When the owner picks an external voice, the engaged tier becomes a pair:
 * a text-modality realtime session (the ears and the brain) and a streaming
 * TTS session (the mouth). This module is the glue that makes that pair look
 * like the one {@link VoiceConversationPort} the media owner already speaks
 * to, so `voice-session.ts` — playback, pendings, receipts, the floor —
 * neither knows nor cares which mouth is wired.
 *
 * Three ordering problems live here and nowhere else:
 *
 * - **Done is delayed.** The media owner treats `onResponseDone` as "the
 *   speech is complete" and drops late audio after it. With an external mouth,
 *   audio necessarily trails the model's `response.done`, so this port holds
 *   the done event until the TTS context reports final — with a drain timeout,
 *   because a wedged synthesizer must not wedge the floor.
 * - **Truncate changes meaning.** `conversation.item.truncate` is an
 *   audio-item repair and the server would reject it for a text item. Barge-in
 *   here closes the TTS context (stopping paid synthesis of speech nobody
 *   will hear) and injects a bounded marker item so the model knows the room
 *   did not hear its whole reply.
 * - **The mouth can die independently.** A dropped TTS socket fails the
 *   current utterance loudly, releases any held done event, and is reopened
 *   on the next utterance rather than tearing down the ears with it.
 */

import type { Buffer } from "node:buffer";
import type {
  RealtimeFunctionCall,
  RealtimeResponseMeta,
  RealtimeSessionCloseReason,
  RealtimeTimers,
} from "./realtime-session.ts";
import type { VoiceConversationOpenInput, VoiceConversationPort } from "./voice-session.ts";

/**
 * How long after the model's `response.done` the TTS context may keep
 * synthesizing before the done event is forced through. Synthesis runs faster
 * than speech, so a healthy context finishes well inside this; hitting it
 * means the mouth is wedged, and holding the done any longer would starve the
 * media owner's pending queue.
 */
export const DEFAULT_TTS_DRAIN_TIMEOUT_MS = 30_000;

/** What this port needs from the text-modality realtime session. */
export interface ExternalVoiceRealtimePort {
  readonly isOpen: boolean;
  appendAudio(pcm: Buffer): void;
  createTextItem(text: string): void;
  createResponse(): void;
  submitFunctionResult(callId: string, output: string): void;
  close(): void;
}

/** What this port needs from the streaming TTS session. */
export interface ExternalVoiceTtsPort {
  readonly isOpen: boolean;
  openContext(contextId: string): void;
  appendText(contextId: string, text: string): void;
  flush(contextId: string): void;
  closeContext(contextId: string): void;
  close(): void;
}

export interface ExternalVoiceRealtimeHandlers {
  readonly onTextDelta: (delta: string, itemId: string) => void;
  readonly onFunctionCall: (call: RealtimeFunctionCall) => void;
  readonly onResponseDone: (meta: RealtimeResponseMeta) => void;
  readonly onClose: (reason: RealtimeSessionCloseReason) => void;
  readonly onError: (message: string) => void;
}

export interface ExternalVoiceTtsHandlers {
  readonly onAudio: (pcm: Buffer, contextId: string) => void;
  readonly onContextDone: (contextId: string) => void;
  readonly onClose: () => void;
  readonly onError: (message: string) => void;
}

/**
 * The two session openers, supplied by the composition layer. The realtime
 * opener must produce a **text-modality** session wired to exactly these
 * handlers; the TTS opener is called at open time and again whenever the
 * mouth needs reopening after a mid-call loss.
 */
export interface ExternalVoiceSessionFactories {
  openRealtime(handlers: ExternalVoiceRealtimeHandlers): Promise<ExternalVoiceRealtimePort>;
  openTts(handlers: ExternalVoiceTtsHandlers): Promise<ExternalVoiceTtsPort>;
}

export interface ExternalVoiceConversationOptions {
  readonly timers?: RealtimeTimers;
  readonly drainTimeoutMs?: number;
}

const globalTimers: RealtimeTimers = {
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

class ExternalVoiceConversation implements VoiceConversationPort {
  private readonly input: VoiceConversationOpenInput;
  private readonly factories: ExternalVoiceSessionFactories;
  private readonly timers: RealtimeTimers;
  private readonly drainTimeoutMs: number;
  private realtime: ExternalVoiceRealtimePort | undefined;
  private tts: ExternalVoiceTtsPort | undefined;
  /**
   * Serializes every TTS interaction. Callbacks are synchronous but opening
   * the mouth is not; the chain keeps "open, then append, then flush" true
   * even when the open is still in flight when the first delta lands.
   */
  private ops: Promise<void> = Promise.resolve();
  /**
   * Item ids whose speech is still wanted, maintained synchronously: added on
   * the first text delta, removed by barge-in, context completion, or mouth
   * loss. The ops chain mirrors this intent to the socket; decisions never
   * wait on the socket.
   */
  private readonly liveItemIds = new Set<string>();
  private readonly droppedItemIds = new Set<string>();
  private readonly heldDone = new Map<string, { meta: RealtimeResponseMeta; handle: unknown }>();
  /** Per-utterance tail held back until it completes a speakable unit. */
  private readonly pendingText = new Map<string, string>();
  private lastTextItemId = "";
  private closed = false;

  public constructor(
    input: VoiceConversationOpenInput,
    factories: ExternalVoiceSessionFactories,
    options: ExternalVoiceConversationOptions,
  ) {
    this.input = input;
    this.factories = factories;
    this.timers = options.timers ?? globalTimers;
    this.drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_TTS_DRAIN_TIMEOUT_MS;
  }

  public async open(): Promise<void> {
    this.realtime = await this.factories.openRealtime({
      onTextDelta: (delta, itemId) => {
        this.handleTextDelta(delta, itemId);
      },
      onFunctionCall: (call) => {
        this.input.onFunctionCall(call);
      },
      onResponseDone: (meta) => {
        this.handleResponseDone(meta);
      },
      onClose: (reason) => {
        this.handleRealtimeClose(reason);
      },
      onError: this.input.onError,
    });
    try {
      // Eager, so a bad voice id or dead vendor fails the conversation open
      // loudly instead of failing the first thing he tries to say.
      this.tts = await this.factories.openTts(this.ttsHandlers());
    } catch (error) {
      this.realtime.close();
      throw error;
    }
  }

  public get isOpen(): boolean {
    return !this.closed && (this.realtime?.isOpen ?? false);
  }

  public appendAudio(pcm: Buffer): void {
    this.requireRealtime().appendAudio(pcm);
  }

  public createTextItem(text: string): void {
    this.requireRealtime().createTextItem(text);
  }

  public createResponse(): void {
    this.requireRealtime().createResponse();
  }

  public submitFunctionResult(callId: string, output: string): void {
    this.requireRealtime().submitFunctionResult(callId, output);
  }

  /**
   * Barge-in. The audio offset is playback wall-clock, meaningful to a human
   * reading the marker but not to the text item — there is no server-side
   * audio to trim, so the repair is stopping synthesis and telling the model
   * what happened.
   */
  public truncate(itemId: string, audioEndMs: number): void {
    const realtime = this.requireRealtime();
    if (this.liveItemIds.has(itemId)) {
      this.queue(() => {
        if (this.tts?.isOpen === true) this.tts.closeContext(itemId);
      });
    }
    this.dropItem(itemId);
    realtime.createTextItem(
      `(You were interrupted about ${String(Math.max(0, Math.round(audioEndMs)))}ms into your reply; ` +
        "the room did not hear the rest of it.)",
    );
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const itemId of this.heldDone.keys()) this.releaseHeldDone(itemId);
    this.realtime?.close();
    this.tts?.close();
  }

  private handleTextDelta(delta: string, itemId: string): void {
    if (this.closed || this.droppedItemIds.has(itemId)) return;
    if (!this.liveItemIds.has(itemId)) {
      this.liveItemIds.add(itemId);
      this.lastTextItemId = itemId;
      this.queueItemStep(itemId, async () => {
        await this.ensureTts();
        this.requireTts().openContext(itemId);
      });
    }
    const pending = (this.pendingText.get(itemId) ?? "") + delta;
    const { emit, rest } = splitSpeakableUnits(pending);
    this.pendingText.set(itemId, rest);
    if (emit.length === 0) return;
    this.queueItemStep(itemId, () => {
      this.requireTts().appendText(itemId, emit);
    });
  }

  /** Whatever the boundary splitter is still holding, so nothing is lost at the end. */
  private drainPendingText(itemId: string): void {
    const rest = this.pendingText.get(itemId);
    this.pendingText.delete(itemId);
    if (rest === undefined || rest.length === 0) return;
    this.queueItemStep(itemId, () => {
      this.requireTts().appendText(itemId, rest);
    });
  }

  private handleResponseDone(meta: RealtimeResponseMeta): void {
    if (this.closed) {
      this.input.onResponseDone(meta);
      return;
    }
    const itemId = this.lastTextItemId;
    // A response that produced no live speech — a pure function-call round
    // trip, a truncated utterance, or a silent model — owes the media owner
    // its done event immediately.
    if (itemId.length === 0 || !this.liveItemIds.has(itemId)) {
      this.input.onResponseDone(meta);
      return;
    }
    this.lastTextItemId = "";
    const handle = this.timers.setTimeout(() => {
      this.input.onError("External voice synthesis did not drain in time");
      this.releaseHeldDone(itemId);
    }, this.drainTimeoutMs);
    this.heldDone.set(itemId, { meta, handle });
    this.drainPendingText(itemId);
    this.queueItemStep(itemId, () => {
      this.requireTts().flush(itemId);
    });
  }

  private handleRealtimeClose(reason: RealtimeSessionCloseReason): void {
    if (!this.closed) {
      this.closed = true;
      for (const itemId of this.heldDone.keys()) this.releaseHeldDone(itemId);
      this.tts?.close();
    }
    this.input.onClose(reason);
  }

  private ttsHandlers(): ExternalVoiceTtsHandlers {
    return {
      onAudio: (pcm, contextId) => {
        if (this.closed || this.droppedItemIds.has(contextId)) {
          pcm.fill(0);
          return;
        }
        this.input.onAudioDelta(pcm, contextId);
      },
      onContextDone: (contextId) => {
        this.liveItemIds.delete(contextId);
        this.releaseHeldDone(contextId);
      },
      onClose: () => {
        // The mouth died; every in-flight utterance is over. Fail the held
        // done events through rather than letting them wait out the drain
        // timer, and let the next utterance reopen the session.
        for (const itemId of this.liveItemIds) this.dropItem(itemId);
        for (const itemId of this.heldDone.keys()) this.releaseHeldDone(itemId);
      },
      onError: this.input.onError,
    };
  }

  /** The item's speech is over — by barge-in, mouth loss, or step failure. */
  private dropItem(itemId: string): void {
    this.liveItemIds.delete(itemId);
    this.droppedItemIds.add(itemId);
    this.pendingText.delete(itemId);
    this.releaseHeldDone(itemId);
  }

  /**
   * A serialized TTS step scoped to one utterance. A step that throws drops
   * the utterance — its done event must not sit waiting on a mouth that just
   * proved it cannot speak it.
   */
  private queueItemStep(itemId: string, step: () => void | Promise<void>): void {
    this.queue(async () => {
      if (!this.liveItemIds.has(itemId)) return;
      try {
        await step();
      } catch (error) {
        this.dropItem(itemId);
        throw error;
      }
    });
  }

  private releaseHeldDone(itemId: string): void {
    const held = this.heldDone.get(itemId);
    if (held === undefined) return;
    this.heldDone.delete(itemId);
    this.timers.clearTimeout(held.handle);
    this.input.onResponseDone(held.meta);
  }

  private async ensureTts(): Promise<void> {
    if (this.closed || this.tts?.isOpen === true) return;
    this.tts = await this.factories.openTts(this.ttsHandlers());
  }

  private queue(step: () => void | Promise<void>): void {
    this.ops = this.ops
      .then(async () => {
        if (this.closed) return;
        await step();
      })
      .catch((error: unknown) => {
        // Boundary errors are already sanitized one-liners; anything else is
        // reduced to a fixed string so socket detail never escapes here.
        this.input.onError(error instanceof Error ? error.message : "External voice synthesis failed");
      });
  }

  private requireRealtime(): ExternalVoiceRealtimePort {
    if (this.closed || this.realtime === undefined) {
      throw new Error("External voice conversation is closed");
    }
    return this.realtime;
  }

  private requireTts(): ExternalVoiceTtsPort {
    if (this.tts === undefined || !this.tts.isOpen) {
      throw new Error("External voice synthesis session is not open");
    }
    return this.tts;
  }
}

/**
 * Opens the paired sessions and returns them as one conversation port. If the
 * mouth cannot open, the ears are closed again and the error propagates — a
 * conversation that can hear but never speak is a worse failure than a
 * retried open.
 */
export async function openExternalVoiceConversation(
  input: VoiceConversationOpenInput,
  factories: ExternalVoiceSessionFactories,
  options: ExternalVoiceConversationOptions = {},
): Promise<VoiceConversationPort> {
  const conversation = new ExternalVoiceConversation(input, factories, options);
  await conversation.open();
  return conversation;
}

/**
 * Punctuation that ends something a synthesizer can voice on its own.
 * Deliberately includes the clause enders: a long sentence delivered as two
 * clauses still sounds like speech, while a whole paragraph held back to find
 * a period would stall the reply.
 */
const SPEAKABLE_BOUNDARY = /[.!?…:;\n]/gu;
/**
 * Longest run held back with no boundary in sight before it is emitted at the
 * last word break. A model that writes one long unpunctuated clause must not
 * be able to hold the mouth shut until the response ends.
 */
const MAX_HELD_TEXT_CHARACTERS = 200;

/**
 * Split streamed text into what can be spoken now and what must wait.
 *
 * The mouth runs with `auto_mode`, which disables ElevenLabs' chunk schedule
 * and every buffer: whatever arrives in one frame is synthesized as one unit,
 * with its own prosody and its own boundaries. That is the right mode for a
 * caller sending finished sentences and the wrong one for a caller relaying
 * a model's token deltas — a delta is a word or part of one, so every word
 * became its own utterance and the reply came out as a list of words rather
 * than a sentence. Boundary-splitting here is what makes `auto_mode`'s
 * contract true: complete units in, natural speech out.
 *
 * A boundary must be followed by whitespace or end the buffer, so decimals and
 * abbreviations mid-word are not mistaken for sentence ends while the next
 * delta is still unseen.
 */
export function splitSpeakableUnits(pending: string): { emit: string; rest: string } {
  let cut = -1;
  SPEAKABLE_BOUNDARY.lastIndex = 0;
  for (
    let match = SPEAKABLE_BOUNDARY.exec(pending);
    match !== null;
    match = SPEAKABLE_BOUNDARY.exec(pending)
  ) {
    const after = pending[match.index + 1];
    if (after !== undefined && !/\s/u.test(after)) continue;
    // The whitespace after the boundary belongs to the unit that just ended,
    // so the next one starts on a word rather than a leading space.
    let end = match.index + 1;
    while (end < pending.length && /\s/u.test(pending[end] ?? "")) end += 1;
    cut = end;
  }
  if (cut === -1 && pending.length > MAX_HELD_TEXT_CHARACTERS) {
    // No boundary in a long run: break at the last word break so the split
    // lands between words rather than inside one.
    const lastBreak = pending.lastIndexOf(" ");
    if (lastBreak > 0) cut = lastBreak + 1;
  }
  if (cut === -1) return { emit: "", rest: pending };
  return { emit: pending.slice(0, cut), rest: pending.slice(cut) };
}
