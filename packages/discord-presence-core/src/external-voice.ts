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
import { randomUUID } from "node:crypto";
import { VoiceToneText } from "./voice-tone-text.ts";
import {
  MAX_REALTIME_RESPONSE_AUDIO_BYTES,
  MAX_REALTIME_RESPONSE_TEXT_CHARACTERS,
  type RealtimeTranscriptEvent,
} from "./realtime-session.ts";
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
  createImageItem(pngBase64: string, mimeType?: "image/png"): void;
  createResponse(context?: string, shouldStart?: () => boolean): void;
  submitFunctionResult(callId: string, output: string, shouldRespond?: false | (() => boolean)): void;
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
  /** Exact selected v4 transport capability, never inferred from authored text. */
  readonly dialogue?: boolean;
  readonly onTranscript?: (event: RealtimeTranscriptEvent) => void;
}

const globalTimers: RealtimeTimers = {
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

interface SpeechItem {
  projection: VoiceToneText;
  readable: string;
  contextId: string | undefined;
  first: boolean;
  waiting: boolean;
  remainder: string;
  modelDone: boolean;
  audioBytes: number;
  textCharacters: number;
}

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
  private readonly items = new Map<string, SpeechItem>();
  private readonly contexts = new Map<string, string>();
  private readonly openedContexts = new Set<string>();
  private mouthGeneration = 0;
  private readonly dialogue: boolean;
  private readonly onTranscript: ((event: RealtimeTranscriptEvent) => void) | undefined;
  private closed = false;
  private responseActive = false;
  private readonly responseQueue: { start: () => void; shouldStart?: () => boolean }[] = [];

  public constructor(
    input: VoiceConversationOpenInput,
    factories: ExternalVoiceSessionFactories,
    options: ExternalVoiceConversationOptions,
  ) {
    this.input = input;
    this.dialogue = options.dialogue === true;
    this.onTranscript = options.onTranscript;
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
      const tts = await this.factories.openTts(this.ttsHandlers());
      if (this.closed) {
        tts.close();
        throw new Error("External voice conversation closed while opening");
      }
      this.tts = tts;
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

  public createImageItem(pngBase64: string, mimeType?: "image/png"): void {
    this.requireRealtime().createImageItem(pngBase64, mimeType);
  }

  public createResponse(context?: string, shouldStart?: () => boolean): void {
    this.queueResponse(() => this.requireRealtime().createResponse(context), shouldStart);
  }

  public submitFunctionResult(callId: string, output: string, shouldRespond?: false | (() => boolean)): void {
    this.requireRealtime().submitFunctionResult(callId, output, false);
    if (shouldRespond !== false) this.createResponse(undefined, shouldRespond);
  }

  private queueResponse(start: () => void, shouldStart?: () => boolean): void {
    this.requireRealtime();
    this.responseQueue.push({ start, ...(shouldStart === undefined ? {} : { shouldStart }) });
    this.startNextResponse();
  }

  private startNextResponse(): void {
    while (!this.responseActive && !this.closed) {
      const next = this.responseQueue.shift();
      if (next === undefined) return;
      if (next.shouldStart?.() === false) continue;
      this.responseActive = true;
      try {
        next.start();
      } catch (error) {
        this.responseActive = false;
        throw error;
      }
    }
  }

  private finishResponse(meta: RealtimeResponseMeta): void {
    this.input.onResponseDone(meta);
    this.responseActive = false;
    if (this.closed) {
      this.responseQueue.length = 0;
      return;
    }
    this.startNextResponse();
  }

  /**
   * Barge-in. The audio offset is playback wall-clock, meaningful to a human
   * reading the marker but not to the text item — there is no server-side
   * audio to trim, so the repair is stopping synthesis and telling the model
   * what happened.
   */
  public truncate(itemId: string, audioEndMs: number): void {
    const realtime = this.requireRealtime();
    this.closeItemContext(itemId);
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
    this.items.clear();
    this.pendingText.clear();
    this.contexts.clear();
    this.openedContexts.clear();
    this.liveItemIds.clear();
  }

  private handleTextDelta(delta: string, itemId: string): void {
    if (this.closed || this.droppedItemIds.has(itemId)) return;
    let item = this.items.get(itemId);
    if (item?.modelDone) return;
    if (item === undefined) {
      item = {
        projection: new VoiceToneText(this.dialogue),
        readable: "",
        contextId: undefined,
        first: true,
        waiting: false,
        remainder: "",
        modelDone: false,
        audioBytes: 0,
        textCharacters: 0,
      };
      this.items.set(itemId, item);
      this.liveItemIds.add(itemId);
      this.input.onFirstText?.(itemId);
      this.lastTextItemId = itemId;
    }
    item.textCharacters += delta.length;
    if (item.textCharacters > MAX_REALTIME_RESPONSE_TEXT_CHARACTERS) {
      this.input.onError("External voice utterance text exceeded the character limit", itemId);
      this.closeItemContext(itemId);
      this.markSpeechFailure(itemId);
      this.dropItem(itemId, true);
      return;
    }
    const projected = item.projection.append(delta);
    if (projected.readable) {
      item.readable = (item.readable + projected.readable).slice(0, MAX_REALTIME_RESPONSE_TEXT_CHARACTERS);
      this.publishText({ itemId, text: projected.readable, final: false });
    }
    if (item.first && item.contextId === undefined && projected.speech.trim())
      this.openItemContext(itemId, itemId);
    const pending = (this.pendingText.get(itemId) ?? "") + projected.speech;
    let { emit, rest } = splitSpeakableUnits(pending);
    let early = false;
    if (this.dialogue && item.first) {
      const first = firstSpeakableUnit(pending);
      const visible = first.emit.replace(/\[[^\]]*\]/gu, "").trim().length;
      if (visible > 0 && visible < SHORT_FIRST_CLAUSE_CHARACTERS) {
        ({ emit, rest } = first);
        early = true;
      }
    }
    this.pendingText.set(itemId, rest);
    if (!emit) return;
    item.first = false;
    this.appendItemText(itemId, emit);
    if (early) {
      item.waiting = true;
      this.flushItemContext(itemId);
      const more = splitSpeakableUnits(rest);
      this.pendingText.set(itemId, more.rest);
      if (more.emit) this.appendItemText(itemId, more.emit);
    }
  }

  private publishText(event: RealtimeTranscriptEvent): void {
    this.input.onOutputTranscript?.(event, "tts_text");
    this.onTranscript?.(event);
  }

  private openItemContext(itemId: string, contextId: string): void {
    const item = this.items.get(itemId);
    if (item === undefined) return;
    item.contextId = contextId;
    this.contexts.set(contextId, itemId);
    this.queueItemStep(itemId, async () => {
      await this.ensureTts();
      // Reopening is asynchronous: barge-in/close must win before context creation.
      if (this.closed || !this.liveItemIds.has(itemId) || item.contextId !== contextId) return;
      this.requireTts().openContext(contextId);
      this.openedContexts.add(contextId);
    });
  }

  private appendItemText(itemId: string, text: string): void {
    if (!text.trim()) return;
    const item = this.items.get(itemId);
    if (item === undefined) return;
    if (item.waiting) {
      item.remainder += text;
      return;
    }
    if (item.contextId === undefined) this.openItemContext(itemId, `voice_${randomUUID()}`);
    const contextId = item.contextId!;
    this.queueItemStep(itemId, () => this.requireTts().appendText(contextId, text));
  }

  private flushItemContext(itemId: string): void {
    const contextId = this.items.get(itemId)?.contextId;
    if (contextId !== undefined) this.queueItemStep(itemId, () => this.requireTts().flush(contextId));
  }

  /** Whatever the boundary splitter is still holding, so nothing is lost at the end. */
  private drainPendingText(itemId: string): void {
    const rest = this.pendingText.get(itemId);
    this.pendingText.delete(itemId);
    if (rest === undefined || rest.length === 0) return;
    this.appendItemText(itemId, rest);
  }

  private handleResponseDone(meta: RealtimeResponseMeta): void {
    if (this.closed) {
      this.finishResponse(meta);
      return;
    }
    const itemId = this.lastTextItemId;
    // A response that produced no live speech — a pure function-call round
    // trip, a truncated utterance, or a silent model — owes the media owner
    // its done event immediately.
    if (itemId.length === 0 || !this.liveItemIds.has(itemId)) {
      this.finishResponse(meta);
      return;
    }
    this.lastTextItemId = "";
    const item = this.items.get(itemId)!;
    item.modelDone = true;
    if (item.readable) this.publishText({ itemId, text: item.readable, final: true });
    const handle = this.timers.setTimeout(() => {
      this.input.onError("External voice synthesis did not drain in time", itemId);
      // A context that missed the drain window is abandoned, not merely
      // un-held. Left open it keeps its ElevenLabs context slot forever, and
      // the still-live item pins `discardMouth` shut — so the next utterances
      // hit the open-context limit and the room stops hearing him for the
      // rest of the call while the model keeps writing replies.
      this.markSpeechFailure(itemId);
      this.closeItemContext(itemId);
      this.dropItem(itemId, true);
    }, this.drainTimeoutMs);
    this.heldDone.set(itemId, { meta, handle });
    this.drainPendingText(itemId);
    if (!item.waiting) {
      if (item.contextId === undefined) this.completeItem(itemId);
      else this.flushItemContext(itemId);
    }
  }

  private handleRealtimeClose(reason: RealtimeSessionCloseReason): void {
    if (!this.closed) {
      this.closed = true;
      for (const itemId of this.heldDone.keys()) this.releaseHeldDone(itemId);
      this.tts?.close();
      this.items.clear();
      this.pendingText.clear();
      this.contexts.clear();
      this.openedContexts.clear();
      this.liveItemIds.clear();
    }
    this.input.onClose(reason);
  }

  private ttsHandlers(): ExternalVoiceTtsHandlers {
    const generation = ++this.mouthGeneration;
    return {
      onAudio: (pcm, contextId) => {
        const itemId = this.contexts.get(contextId);
        const item = itemId === undefined ? undefined : this.items.get(itemId);
        if (
          this.closed ||
          generation !== this.mouthGeneration ||
          itemId === undefined ||
          item === undefined ||
          !this.liveItemIds.has(itemId) ||
          item.contextId !== contextId
        ) {
          pcm.fill(0);
          return;
        }
        item.audioBytes += pcm.byteLength;
        if (item.audioBytes > MAX_REALTIME_RESPONSE_AUDIO_BYTES) {
          pcm.fill(0);
          this.input.onError("External voice utterance audio exceeded the byte limit", itemId);
          this.closeItemContext(itemId);
          this.markSpeechFailure(itemId);
          this.dropItem(itemId, true);
          return;
        }
        this.input.onAudioDelta(pcm, itemId);
      },
      onContextDone: (contextId) => {
        if (this.closed || generation !== this.mouthGeneration) return;
        const itemId = this.contexts.get(contextId);
        this.contexts.delete(contextId);
        this.openedContexts.delete(contextId);
        if (itemId === undefined || !this.liveItemIds.has(itemId)) return;
        const item = this.items.get(itemId)!;
        item.contextId = undefined;
        if (item.waiting) {
          item.waiting = false;
          const remainder = item.remainder;
          item.remainder = "";
          if (remainder) this.appendItemText(itemId, remainder);
          if (!item.modelDone) return;
          if (item.contextId !== undefined) {
            this.flushItemContext(itemId);
            return;
          }
        }
        this.completeItem(itemId);
      },
      onClose: () => {
        if (this.closed || generation !== this.mouthGeneration) return;
        // Detach the dead mouth before settlement can synchronously admit a
        // new response. Its callbacks and global cleanup must not reach that
        // response, even while the replacement mouth is still opening.
        const interruptedItems = [...this.liveItemIds];
        const interruptedDone = [...this.heldDone.keys()];
        this.mouthGeneration += 1;
        this.tts = undefined;
        this.contexts.clear();
        this.openedContexts.clear();
        for (const itemId of interruptedItems) {
          this.markSpeechFailure(itemId);
          this.dropItem(itemId);
        }
        for (const itemId of interruptedDone) this.releaseHeldDone(itemId);
      },
      onError: (message) => {
        if (this.closed || generation !== this.mouthGeneration) return;
        if (this.liveItemIds.size === 0) this.input.onError(message, null);
        else for (const itemId of this.liveItemIds) this.input.onError(message, itemId);
      },
    };
  }

  /**
   * Stops server-side generation for an utterance the room will not hear.
   * Paid synthesis of abandoned speech is waste; an unclosed context is worse,
   * because the open-context budget is what the next utterance needs.
   */
  private closeItemContext(itemId: string): void {
    if (!this.liveItemIds.has(itemId)) return;
    const contextId = this.items.get(itemId)?.contextId;
    this.queue(() => {
      if (contextId !== undefined && this.openedContexts.delete(contextId) && this.tts?.isOpen === true)
        this.tts.closeContext(contextId);
    });
  }

  /** The item's speech is over — by barge-in, mouth loss, or step failure. */
  private dropItem(itemId: string, discardMouth = false): void {
    this.liveItemIds.delete(itemId);
    this.droppedItemIds.add(itemId);
    this.pendingText.delete(itemId);
    const item = this.items.get(itemId);
    if (item?.contextId !== undefined) this.contexts.delete(item.contextId);
    this.items.delete(itemId);
    // Releasing done may synchronously create the next live item. Decide
    // whether this failed mouth can be discarded before that happens.
    if (discardMouth) this.discardMouth();
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
        if (!this.closed)
          this.input.onError(
            error instanceof Error ? error.message : "External voice synthesis failed",
            itemId,
          );
        this.closeItemContext(itemId);
        this.markSpeechFailure(itemId);
        this.dropItem(itemId, true);
      }
    });
  }

  private completeItem(itemId: string): void {
    this.liveItemIds.delete(itemId);
    this.pendingText.delete(itemId);
    this.items.delete(itemId);
    this.droppedItemIds.add(itemId);
    this.releaseHeldDone(itemId);
  }

  private releaseHeldDone(itemId: string): void {
    const held = this.heldDone.get(itemId);
    if (held === undefined) return;
    this.heldDone.delete(itemId);
    this.timers.clearTimeout(held.handle);
    this.finishResponse(held.meta);
  }

  /**
   * A mouth that just failed a step is not trusted for the next utterance.
   * Without this, one failed open or one rejected frame left `this.tts`
   * in place and every later utterance reused it, so a single bad step could
   * mute him for the rest of the call — the model kept writing replies and
   * the room kept hearing nothing. Dropping it here costs one reconnect and
   * makes the failure last exactly one utterance.
   *
   * Only when nothing else is speaking: closing the session would kill an
   * utterance already in flight on it, and a sibling item's speech is not
   * this one's to end.
   */
  private discardMouth(): void {
    if (this.liveItemIds.size > 0) return;
    const tts = this.tts;
    this.mouthGeneration += 1;
    this.tts = undefined;
    this.contexts.clear();
    this.openedContexts.clear();
    try {
      tts?.close();
    } catch {
      // Already unusable; the next utterance opens a fresh one either way.
    }
  }

  private async ensureTts(): Promise<void> {
    if (this.closed || this.tts?.isOpen === true) return;
    const tts = await this.factories.openTts(this.ttsHandlers());
    if (this.closed) {
      tts.close();
      return;
    }
    this.tts = tts;
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
        if (!this.closed)
          this.input.onError(error instanceof Error ? error.message : "External voice synthesis failed");
      });
  }

  /** Leaves the failed mouth in conversation history, where the next response can account for it. */
  private markSpeechFailure(itemId: string): void {
    if (this.closed || !this.liveItemIds.has(itemId) || this.realtime?.isOpen !== true) return;
    try {
      this.realtime.createTextItem(
        "(Your external voice failed before completing your reply; the room may have heard only a prefix, and the exact cutoff is unknown.)",
      );
    } catch {
      // The realtime boundary owns its own failure; mouth teardown must still settle this utterance.
    }
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
/** Engineering cutoff between the retained 21- and 45-character probe cases.
 * Actual first-audio and cross-segment prosody still require the owner-run probe.
 */
const SHORT_FIRST_CLAUSE_CHARACTERS = 40;

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

/** The first complete unit, retaining punctuation and its following space. */
function firstSpeakableUnit(text: string): { emit: string; rest: string } {
  const match = /[.!?…:;\n](?:\s+|$)/u.exec(text);
  if (match === null) return { emit: "", rest: text };
  const end = match.index + match[0].length;
  return { emit: text.slice(0, end), rest: text.slice(end) };
}
