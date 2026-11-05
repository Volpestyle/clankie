import { type VoxUserAudioFrame } from "@clankie/vox-client";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
  MAX_REALTIME_AUDIO_APPEND_BYTES,
  REALTIME_AUDIO_SAMPLE_RATE,
  RealtimeSessionRefusedError,
  type RealtimeSessionCloseDetail,
  type RealtimeSessionCloseReason,
  type RealtimeTranscriptEvent,
} from "./realtime-session.ts";
import { voiceAddressesCharacter } from "./voice-address.ts";
import { pcmRms, PCM_SAMPLE_BYTES } from "./voice-audio.ts";
import {
  MIN_UTTERANCE_MS,
  CAPTURE_END_SILENCE_MS,
  CAPTURE_NOISE_RMS,
  CAPTURE_PREROLL_BYTES,
  BARGE_IN_PCM_BYTES,
  BARGE_IN_SPEECH_RMS,
  ONSET_YIELD_PCM_BYTES,
  PROBE_ACCEPTANCE_TIMEOUT_MS,
  SPEAKER_TRANSCRIPTION_IDLE_MS,
  TRANSCRIPT_RING_MAX_LINES,
  TRANSCRIPT_RING_MAX_BYTES,
  UTTERANCE_REORDER_GRACE_MS,
  TURN_GATE_CAPTURE_MAX_MS,
  TURN_GATE_FINAL_WAIT_MS,
  TURN_GATE_MAX_WAIT_MS,
  MAX_PENDING_TRANSCRIPT_TURNS,
  MAX_SPEAKER_TRANSCRIPTION_SESSIONS,
  RECONNECT_BACKOFF_INITIAL_MS,
  RECONNECT_BACKOFF_CAP_MS,
  type DiscordVoiceTranscript,
  type DiscordVoiceLiveTranscript,
  type VoiceTranscriptionPort,
  type RoomTurn,
  type PendingTranscriptTurn,
  type FinalizedUtterance,
  type RoomInputSource,
  type ActiveCapture,
} from "./voice-session-context.ts";
import {
  isSubstantiveInterruption,
  providerCloseEvidence,
  providerDetailEvidence,
} from "./voice-session-utils.ts";

import type { VoiceSessionContext } from "./voice-session-context.ts";
type VoiceInputContext = Pick<
  VoiceSessionContext,
  | "guildId"
  | "channelId"
  | "ending"
  | "voiceReady"
  | "captures"
  | "sessionGeneration"
  | "captureEpochs"
  | "speakerLastActiveAtMs"
  | "clock"
  | "transcriptTurns"
  | "emitSafely"
  | "consent"
  | "options"
  | "timers"
  | "recordingLimitMs"
  | "playingJob"
  | "isPlaying"
  | "floor"
  | "truncatePlayback"
  | "roomResponseEpoch"
  | "quietEpoch"
  | "pendingResponses"
  | "cancelInFlight"
  | "handoffs"
  | "finalizedUtterances"
  | "reorderHandle"
  | "conversation"
  | "lastRoomUserId"
  | "hearIfOpen"
  | "deferredOffer"
  | "applyFloorDecision"
  | "deferredOfferHandle"
  | "queueEngagedResponse"
  | "labeledSpeech"
  | "transcriptRing"
  | "stayId"
  | "transcriptListeners"
  | "transcriptions"
  | "transcriptionOpens"
  | "transcriptionEpochs"
  | "reconnectDelays"
  | "reconnectHandles"
  | "speakerIdleHandles"
  | "liveTranscriptListeners"
  | "liveSpeechLines"
>;

export function createVoiceInput(ctx: VoiceInputContext) {
  async function capture(userId: string): Promise<void> {
    const guildId = ctx.guildId;
    const channelId = ctx.channelId;
    if (
      ctx.ending ||
      !ctx.voiceReady ||
      guildId === undefined ||
      channelId === undefined ||
      ctx.captures.has(userId)
    ) {
      return;
    }
    const generation = ctx.sessionGeneration;
    const epoch = ctx.captureEpochs.get(userId) ?? 0;
    cancelSpeakerTranscriptionIdle(userId);
    ctx.speakerLastActiveAtMs.set(userId, ctx.clock());
    const turn: PendingTranscriptTurn = {
      userId,
      deliveryId: randomUUID(),
      startedAtMs: ctx.clock(),
      inputTiming: {},
    };
    const capture: ActiveCapture = {
      userId,
      captureId: randomUUID(),
      epoch,
      generation,
      turn,
      audioBytes: 0,
      preroll: Buffer.alloc(0),
      forwarding: false,
    };
    ctx.captures.set(userId, capture);
    const transcriptTurns = ctx.transcriptTurns.get(userId) ?? [];
    transcriptTurns.push(turn);
    if (transcriptTurns.length > MAX_PENDING_TRANSCRIPT_TURNS) {
      transcriptTurns.splice(0, transcriptTurns.length - MAX_PENDING_TRANSCRIPT_TURNS);
    }
    ctx.transcriptTurns.set(userId, transcriptTurns);
    try {
      capture.transcription = await ensureSpeakerTranscription(userId);
    } catch {
      if (ctx.captures.get(userId) === capture) cancelCapture(userId);
      removeTranscriptTurn(turn);
      await ctx.emitSafely({
        type: "failed",
        guildId,
        channelId,
        stage: "transcription_session",
        code: "voice_listener_open_failed",
        userId,
      });
      return;
    }
    if (
      generation !== ctx.sessionGeneration ||
      epoch !== (ctx.captureEpochs.get(userId) ?? 0) ||
      ctx.captures.get(userId) !== capture ||
      ctx.ending ||
      !ctx.voiceReady ||
      !ctx.consent.permits(guildId, channelId, userId)
    ) {
      if (ctx.captures.get(userId) === capture) cancelCapture(userId);
      removeTranscriptTurn(turn);
      return;
    }
    try {
      ctx.options.vox.subscribeUserAudio(userId, capture.captureId, {
        sampleRate: REALTIME_AUDIO_SAMPLE_RATE,
        silenceDurationMs: CAPTURE_END_SILENCE_MS,
      });
      capture.limitTimer = ctx.timers.setTimeout(() => {
        capture.limitTimer = undefined;
        void finishCapture(userId, capture.captureId);
      }, ctx.recordingLimitMs);
    } catch {
      if (ctx.captures.get(userId) === capture) {
        ctx.captures.delete(userId);
        ctx.captureEpochs.set(userId, capture.epoch + 1);
        removeTranscriptTurn(turn);
        flushFinalizedUtterances();
        armSpeakerTranscriptionIdle(userId);
      }
      await ctx.emitSafely({
        type: "failed",
        guildId,
        channelId,
        userId,
        deliveryId: turn.deliveryId,
        stage: "capture",
        code: "voice_capture_subscribe_failed",
      });
    }
  }

  function handleUserAudio(frame: VoxUserAudioFrame): void {
    const capture = ctx.captures.get(frame.userId);
    const guildId = ctx.guildId;
    const channelId = ctx.channelId;
    if (
      capture === undefined ||
      capture.captureId !== frame.captureId ||
      capture.generation !== ctx.sessionGeneration ||
      capture.epoch !== (ctx.captureEpochs.get(frame.userId) ?? 0) ||
      guildId === undefined ||
      channelId === undefined ||
      !ctx.voiceReady ||
      !ctx.consent.permits(guildId, channelId, frame.userId) ||
      capture.transcription === undefined
    ) {
      frame.pcm.fill(0);
      return;
    }
    const remainingBytes = Math.max(
      0,
      Math.floor((ctx.recordingLimitMs * REALTIME_AUDIO_SAMPLE_RATE * PCM_SAMPLE_BYTES) / 1_000) -
        capture.audioBytes,
    );
    const acceptedBytes = Math.floor(Math.min(frame.pcm.byteLength, remainingBytes) / 2) * 2;
    const pcm = Buffer.from(frame.pcm.buffer, frame.pcm.byteOffset, acceptedBytes);
    capture.audioBytes += pcm.byteLength;
    if (capture.turn.inputTiming !== undefined) capture.turn.inputTiming.lastAudioAtMs = ctx.clock();
    const rms = pcmRms(pcm);
    if (rms > (capture.turn.peakRms ?? 0)) capture.turn.peakRms = rms;
    const playback = ctx.playingJob;
    if (playback !== undefined && ctx.isPlaying() && rms >= BARGE_IN_SPEECH_RMS) {
      if (capture.turn.overlapPlaybackId !== playback.playbackId) {
        capture.turn.overlapPlaybackId = playback.playbackId;
      }
      capture.turn.overlapSpeechBytes = (capture.turn.overlapSpeechBytes ?? 0) + pcm.byteLength;
      if (
        capture.turn.overlapSpeechBytes >= ONSET_YIELD_PCM_BYTES &&
        playback.startedAtMs !== undefined &&
        capture.turn.startedAtMs >= playback.startedAtMs &&
        ctx.floor.isEngagedSpeaker(frame.userId, ctx.clock())
      ) {
        // Yield now: someone he is talking with has been talking over him.
        ctx.truncatePlayback(frame.userId);
      }
    }
    if (!capture.forwarding && rms < CAPTURE_NOISE_RMS) {
      const buffered = Buffer.concat([capture.preroll, pcm]);
      capture.preroll.fill(0);
      capture.preroll = Buffer.from(buffered.subarray(Math.max(0, buffered.length - CAPTURE_PREROLL_BYTES)));
      buffered.fill(0);
    } else {
      if (!capture.forwarding) {
        capture.forwarding = true;
        if (capture.preroll.length > 0) forwardAudio(capture.transcription, capture.preroll);
        capture.preroll.fill(0);
        capture.preroll = Buffer.alloc(0);
      }
      forwardAudio(capture.transcription, pcm);
    }
    frame.pcm.fill(0);
    if (acceptedBytes < frame.pcm.byteLength || acceptedBytes >= remainingBytes)
      void finishCapture(frame.userId, frame.captureId);
  }

  async function finishCapture(userId: string, captureId: string): Promise<void> {
    const capture = ctx.captures.get(userId);
    const guildId = ctx.guildId;
    const channelId = ctx.channelId;
    if (capture === undefined || capture.captureId !== captureId) return;
    if (capture.limitTimer !== undefined) ctx.timers.clearTimeout(capture.limitTimer);
    ctx.captures.delete(userId);
    ctx.captureEpochs.set(userId, capture.epoch + 1);
    if (capture.turn.inputTiming !== undefined) capture.turn.inputTiming.captureEndedAtMs = ctx.clock();
    capture.preroll.fill(0);
    armSpeakerTranscriptionIdle(userId);
    try {
      ctx.options.vox.unsubscribeUserAudio(userId);
    } catch {
      if (guildId !== undefined && channelId !== undefined) {
        await ctx.emitSafely({
          type: "failed",
          guildId,
          channelId,
          userId,
          deliveryId: capture.turn.deliveryId,
          stage: "capture",
          code: "voice_capture_unsubscribe_failed",
        });
      }
    }
    if (
      capture.generation !== ctx.sessionGeneration ||
      guildId === undefined ||
      channelId === undefined ||
      !ctx.consent.permits(guildId, channelId, userId)
    ) {
      removeTranscriptTurn(capture.turn);
      flushFinalizedUtterances();
      return;
    }
    if (!capture.forwarding) {
      removeTranscriptTurn(capture.turn);
      flushFinalizedUtterances();
    }
    if (capture.forwarding && capture.audioBytes > 0) {
      try {
        capture.transcription?.commitAudio();
      } catch {
        // A closed listener reports through its close handler; the bounded
        // Discord utterance remains useful evidence even when commit loses.
      }
    }
    const durationMs = Math.round(
      (capture.audioBytes / (REALTIME_AUDIO_SAMPLE_RATE * PCM_SAMPLE_BYTES)) * 1_000,
    );
    if (durationMs < MIN_UTTERANCE_MS) return;
    await ctx.emitSafely({
      type: "utterance",
      guildId,
      channelId,
      userId,
      deliveryId: capture.turn.deliveryId,
      durationMs,
      silenceDurationMs: CAPTURE_END_SILENCE_MS,
      filtered: !capture.forwarding,
      peakRms: Math.round(capture.turn.peakRms ?? 0),
    });
  }

  function cancelCapture(userId: string): void {
    const capture = ctx.captures.get(userId);
    ctx.captureEpochs.set(userId, (ctx.captureEpochs.get(userId) ?? 0) + 1);
    ctx.captures.delete(userId);
    if (capture !== undefined) {
      if (capture.limitTimer !== undefined) ctx.timers.clearTimeout(capture.limitTimer);
      capture.preroll.fill(0);
      removeTranscriptTurn(capture.turn);
    }
    flushFinalizedUtterances();
    try {
      ctx.options.vox.unsubscribeUserAudio(userId);
    } catch {
      const guildId = ctx.guildId;
      const channelId = ctx.channelId;
      if (guildId !== undefined && channelId !== undefined) {
        void ctx.emitSafely({
          type: "failed",
          guildId,
          channelId,
          userId,
          ...(capture === undefined ? {} : { deliveryId: capture.turn.deliveryId }),
          stage: "capture",
          code: "voice_capture_unsubscribe_failed",
        });
      }
    }
  }

  /**
   * Streams one native 24 kHz mono buffer into this speaker's transcription
   * session, sliced to the realtime append cap. The engaged conversation gets
   * attributed transcript items, never an interleaved room-audio buffer.
   */
  function forwardAudio(transcription: VoiceTranscriptionPort, pcm: Buffer): void {
    for (let offset = 0; offset < pcm.byteLength; offset += MAX_REALTIME_AUDIO_APPEND_BYTES) {
      const slice = pcm.subarray(offset, Math.min(offset + MAX_REALTIME_AUDIO_APPEND_BYTES, pcm.byteLength));
      if (transcription.isOpen) {
        try {
          transcription.appendAudio(slice);
        } catch {
          slice.fill(0);
        }
      } else {
        // This speaker's listener was lost mid-capture: dropped, never mixed
        // into somebody else's stream and never buffered for later.
        slice.fill(0);
      }
    }
  }

  // ------------------------------------------------------------------
  // Transcripts: attribution, the ring, and floor decisions.
  // ------------------------------------------------------------------

  function handleTranscript(userId: string, event: RealtimeTranscriptEvent): void {
    if (!event.final) return;
    const guildId = ctx.guildId;
    const channelId = ctx.channelId;
    if (guildId === undefined || channelId === undefined) return;
    const turn = ctx.transcriptTurns.get(userId)?.shift();
    if (turn === undefined) return;
    const text = event.text.trim();
    const finalAtMs = ctx.clock();
    if (turn.inputTiming !== undefined) turn.inputTiming.transcriptFinalAtMs = finalAtMs;
    const addressed = voiceAddressesCharacter(text, ctx.options.floor.names);
    void ctx.emitSafely({
      type: "transcription",
      guildId,
      channelId,
      userId,
      deliveryId: turn.deliveryId,
      outcome: text.length === 0 ? "empty" : "accepted",
      characters: text.length,
      latencyMs: Math.max(0, Math.round(finalAtMs - turn.startedAtMs)),
      ...(turn.inputTiming?.captureEndedAtMs === undefined
        ? {}
        : {
            captureEndToFinalMs: Math.max(0, Math.round(finalAtMs - turn.inputTiming.captureEndedAtMs)),
          }),
      ...(turn.inputTiming?.lastAudioAtMs === undefined
        ? {}
        : {
            lastAudioToFinalMs: Math.max(0, Math.round(finalAtMs - turn.inputTiming.lastAudioAtMs)),
          }),
      addressed,
      ...(turn.peakRms === undefined ? {} : { peakRms: Math.round(turn.peakRms) }),
    });
    if (text.length === 0) {
      flushFinalizedUtterances();
      return;
    }
    // Barge-in (b): being re-addressed while playing truncates immediately —
    // a re-address must not wait for an earlier overlapping capture to finish.
    const confirmedOverlap =
      ctx.floor.isEngagedSpeaker(userId, ctx.clock()) &&
      turn.overlapPlaybackId === ctx.playingJob?.playbackId &&
      (turn.overlapSpeechBytes ?? 0) >= BARGE_IN_PCM_BYTES &&
      isSubstantiveInterruption(text);
    const explicitStop =
      /^(?:(?:hey|please|can you|could you|would you)\s+)*(?:clankie[, ]+)?stop(?:\s+(?:talking|speaking))?[.!?]*$/iu.test(
        text.trim(),
      );
    // A bare "stop" said to a friend must not silence everyone's pending
    // answers; only someone talking with him, or to him, quiets the room.
    if (explicitStop && (addressed || ctx.floor.isEngagedSpeaker(userId, ctx.clock()))) {
      ctx.roomResponseEpoch += 1;
      ctx.quietEpoch += 1;
      for (const pending of ctx.pendingResponses) {
        pending.superseded = true;
        ctx.cancelInFlight(pending);
      }
      for (const handoff of ctx.handoffs.values()) ctx.timers.clearTimeout(handoff.timer);
    }
    if ((ctx.isPlaying() || explicitStop) && (addressed || confirmedOverlap || explicitStop)) {
      ctx.truncatePlayback(userId);
    }
    ctx.finalizedUtterances.push({
      turn,
      text,
      addressed,
      finalizedAtMs: ctx.clock(),
    });
    flushFinalizedUtterances();
  }

  function flushFinalizedUtterances(): void {
    cancelReorderWait();
    ctx.finalizedUtterances.sort((left, right) => left.turn.startedAtMs - right.turn.startedAtMs);
    const now = ctx.clock();
    while (ctx.finalizedUtterances.length > 0) {
      const next = ctx.finalizedUtterances[0];
      if (next === undefined) break;
      const blocked =
        !next.addressed && hasEarlierInflight(next) && now - next.finalizedAtMs < UTTERANCE_REORDER_GRACE_MS;
      if (blocked) {
        armReorderWait(UTTERANCE_REORDER_GRACE_MS - (now - next.finalizedAtMs));
        return;
      }
      ctx.finalizedUtterances.shift();
      applyFinalizedUtterance(next);
    }
    // A capture that ended without a line, or a final that just landed, may be
    // the pause a waiting opportunity was gated on.
    releaseDeferredOffer();
  }

  function hasEarlierInflight(candidate: FinalizedUtterance): boolean {
    for (const [userId, turns] of ctx.transcriptTurns) {
      if (userId === candidate.turn.userId) continue;
      if (turns.some((turn) => turn.startedAtMs < candidate.turn.startedAtMs)) return true;
    }
    return false;
  }

  function armReorderWait(delayMs: number): void {
    const generation = ctx.sessionGeneration;
    ctx.reorderHandle = ctx.timers.setTimeout(
      () => {
        ctx.reorderHandle = undefined;
        if (generation !== ctx.sessionGeneration) return;
        flushFinalizedUtterances();
      },
      Math.max(0, delayMs),
    );
  }

  function cancelReorderWait(): void {
    if (ctx.reorderHandle === undefined) return;
    ctx.timers.clearTimeout(ctx.reorderHandle);
    ctx.reorderHandle = undefined;
  }

  function applyFinalizedUtterance(item: FinalizedUtterance): void {
    applyRoomUtterance(item.turn, item.text, "speech");
  }

  function applyRoomUtterance(turn: RoomTurn, text: string, source: RoomInputSource): void {
    if (ctx.ending) return;
    const guildId = ctx.guildId;
    const channelId = ctx.channelId;
    if (guildId === undefined || channelId === undefined) return;
    ctx.roomResponseEpoch += 1;
    // Hearing is lossless, but speech that has not reached the room is replaceable.
    // Keep active provider slots until done so late PCM retains its attribution.
    let unheardReply = false;
    for (const pending of ctx.pendingResponses) {
      if (pending.firstAudioAtMs === undefined && !pending.superseded) {
        pending.superseded = true;
        unheardReply = true;
        ctx.cancelInFlight(pending);
      }
    }
    if (unheardReply) {
      try {
        ctx.conversation?.createTextItem(
          "The conversation moved on before pending speech was audible. Do not assume the room heard those replies. Their results remain context for the latest conversation.",
        );
      } catch {
        /* A closed provider cannot prevent local absorption. */
      }
    }
    if (ctx.playingJob?.pending.superseded && ctx.playingJob.startedAtMs === undefined) {
      // PCM accepted by Vox but not yet audible is still a stale queued reply.
      ctx.truncatePlayback(turn.userId);
    }
    ctx.lastRoomUserId = turn.userId;
    rememberRoomLine(turn, text, source);
    ctx.hearIfOpen(turn, text, source);
    const decision = ctx.floor.observeTranscript({
      speakerId: turn.userId,
      text,
      source,
      atMs: ctx.clock(),
    });
    void ctx.emitSafely({
      type: "floor_decision",
      guildId,
      channelId,
      userId: turn.userId,
      deliveryId: turn.deliveryId,
      action: decision.action,
      ...("reason" in decision ? { reason: decision.reason } : {}),
      state: ctx.floor.state,
    });
    const previous = ctx.deferredOffer;
    dropDeferredOffer();
    if (
      source === "speech" &&
      decision.action === "offer" &&
      decision.reason !== "mentioned" &&
      turnGateWaitMs(turn.userId) !== undefined
    ) {
      ctx.deferredOffer = {
        turn: { ...turn, sourceText: text },
        guildId,
        channelId,
        offer: "engaged",
        roomEpoch: ctx.roomResponseEpoch,
        generation: ctx.sessionGeneration,
        firstDeferredAtMs: previous?.firstDeferredAtMs ?? ctx.clock(),
      };
      releaseDeferredOffer();
      return;
    }
    ctx.applyFloorDecision(decision, { ...turn, sourceText: text }, guildId, channelId);
  }

  /**
   * How long another participant's speech may still hold an unaddressed
   * opportunity back, or undefined when the room has paused. Their capture is
   * live speech (past the noise floor), or their final transcript is due.
   */
  function turnGateWaitMs(speakerId: string): number | undefined {
    const now = ctx.clock();
    let wait: number | undefined;
    const hold = (remainingMs: number): void => {
      if (remainingMs > 0) wait = Math.min(wait ?? remainingMs, remainingMs);
    };
    for (const capture of ctx.captures.values()) {
      if (capture.userId === speakerId || !capture.forwarding) continue;
      hold(capture.turn.startedAtMs + TURN_GATE_CAPTURE_MAX_MS - now);
    }
    for (const [userId, turns] of ctx.transcriptTurns) {
      if (userId === speakerId) continue;
      for (const turn of turns) {
        const endedAtMs = turn.inputTiming?.captureEndedAtMs;
        if (endedAtMs !== undefined) hold(endedAtMs + TURN_GATE_FINAL_WAIT_MS - now);
      }
    }
    return wait;
  }

  /** Requests the waiting opportunity once the room pauses or its bound expires. */
  function releaseDeferredOffer(): void {
    const deferred = ctx.deferredOffer;
    if (deferred === undefined) return;
    cancelDeferredOfferTimer();
    if (deferred.generation !== ctx.sessionGeneration || deferred.roomEpoch !== ctx.roomResponseEpoch) {
      ctx.deferredOffer = undefined;
      return;
    }
    const capWaitMs = deferred.firstDeferredAtMs + TURN_GATE_MAX_WAIT_MS - ctx.clock();
    const busyWaitMs = turnGateWaitMs(deferred.turn.userId);
    if (busyWaitMs !== undefined && capWaitMs > 0) {
      const generation = ctx.sessionGeneration;
      ctx.deferredOfferHandle = ctx.timers.setTimeout(
        () => {
          ctx.deferredOfferHandle = undefined;
          if (generation === ctx.sessionGeneration) releaseDeferredOffer();
        },
        Math.ceil(Math.min(busyWaitMs, capWaitMs)),
      );
      return;
    }
    ctx.deferredOffer = undefined;
    ctx.queueEngagedResponse(deferred.turn, deferred.guildId, deferred.channelId, deferred.offer);
  }

  function dropDeferredOffer(): void {
    ctx.deferredOffer = undefined;
    cancelDeferredOfferTimer();
  }

  function cancelDeferredOfferTimer(): void {
    if (ctx.deferredOfferHandle === undefined) return;
    ctx.timers.clearTimeout(ctx.deferredOfferHandle);
    ctx.deferredOfferHandle = undefined;
  }

  function rememberRoomLine(turn: RoomTurn, text: string, source: RoomInputSource): void {
    const guildId = ctx.guildId;
    const channelId = ctx.channelId;
    if (guildId === undefined || channelId === undefined) return;
    const labeled = ctx.labeledSpeech(turn.userId, text, turn.displayName);
    const line = JSON.stringify({ ...labeled, source });
    // A Discord nickname is untrusted the same way message text is —
    // interpolating it would let a nick impersonate another participant.
    ctx.transcriptRing.push(Buffer.from(line, "utf8"));
    // Voice transcript subscribers are deliberately speech-only. Typed text
    // already has Discord's durable source, and publishing it here would send
    // the existing play text delivery twice.
    if (source === "speech") {
      const transcript: DiscordVoiceTranscript = {
        // Wall clock, not `this.clock()` — that seam is monotonic milliseconds
        // for durations, and reading it as an epoch stamped every transcript
        // line somewhere in 1970, which broke the join to receipts by time.
        occurredAt: new Date().toISOString(),
        guildId,
        channelId,
        ...(ctx.stayId === undefined ? {} : { stayId: ctx.stayId }),
        deliveryId: turn.deliveryId,
        ...labeled,
      };
      for (const listener of ctx.transcriptListeners) {
        try {
          listener(line, transcript);
        } catch {
          // A play listener that throws on hearing must not break the room.
        }
      }
    }
    let totalBytes = 0;
    for (const line of ctx.transcriptRing) totalBytes += line.byteLength;
    while (
      ctx.transcriptRing.length > TRANSCRIPT_RING_MAX_LINES ||
      (totalBytes > TRANSCRIPT_RING_MAX_BYTES && ctx.transcriptRing.length > 1)
    ) {
      const evicted = ctx.transcriptRing.shift();
      if (evicted === undefined) break;
      totalBytes -= evicted.byteLength;
      evicted.fill(0);
    }
  }

  function ringText(): string {
    return ctx.transcriptRing.map((line) => line.toString("utf8")).join("\n");
  }

  // ------------------------------------------------------------------
  // Speaker-bound dormant listeners: open, reconnect, never cross identities.
  // ------------------------------------------------------------------

  async function probeTranscription(guildId: string, channelId: string): Promise<void> {
    const port = await ctx.options.realtime.openTranscription({
      onTranscript: () => undefined,
      onClose: () => undefined,
      onError: () => undefined,
    });
    try {
      // An open socket is not an account that can transcribe: a provider with
      // no credit opens, then refuses every session (VUH-2728). Join only
      // after it confirms, so a refusal or silence fails the join instead of sitting deaf.
      if (port.accepted !== undefined) await awaitAcceptance(port.accepted);
    } catch (error) {
      if (error instanceof RealtimeSessionRefusedError) {
        await ctx.emitSafely({
          type: "failed",
          guildId,
          channelId,
          stage: "transcription_session",
          code: error.unconfirmed ? "voice_provider_unconfirmed" : "voice_provider_refused",
          ...providerDetailEvidence(error.detail),
        });
      }
      throw error;
    } finally {
      port.close();
    }
  }

  function awaitAcceptance(accepted: Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const handle = ctx.timers.setTimeout(() => {
        reject(new RealtimeSessionRefusedError({}, { unconfirmed: true }));
      }, PROBE_ACCEPTANCE_TIMEOUT_MS);
      accepted.then(
        () => {
          ctx.timers.clearTimeout(handle);
          resolve();
        },
        (error: unknown) => {
          ctx.timers.clearTimeout(handle);
          reject(error instanceof Error ? error : new Error("Realtime provider refused the session"));
        },
      );
    });
  }

  function ensureSpeakerTranscription(userId: string): Promise<VoiceTranscriptionPort> {
    const current = ctx.transcriptions.get(userId);
    if (current?.isOpen === true) return Promise.resolve(current);
    const opening = ctx.transcriptionOpens.get(userId);
    if (opening !== undefined) return opening;
    if (!makeSpeakerTranscriptionCapacity(userId)) {
      return Promise.reject(new Error("Discord voice speaker listener capacity reached"));
    }
    const next = openSpeakerTranscriptionNow(userId).finally(() => {
      if (ctx.transcriptionOpens.get(userId) === next) ctx.transcriptionOpens.delete(userId);
    });
    ctx.transcriptionOpens.set(userId, next);
    return next;
  }

  async function openSpeakerTranscriptionNow(userId: string): Promise<VoiceTranscriptionPort> {
    const generation = ctx.sessionGeneration;
    const epoch = ctx.transcriptionEpochs.get(userId) ?? 0;
    const guildId = ctx.guildId;
    const channelId = ctx.channelId;
    if (guildId === undefined || channelId === undefined) {
      throw new Error("Discord voice session is not joined");
    }
    const port = await ctx.options.realtime.openTranscription({
      onTranscript: (event) => {
        if (generation !== ctx.sessionGeneration) return;
        publishLiveSpeech(event);
        handleTranscript(userId, event);
      },
      onClose: (reason, detail) => {
        handleTranscriptionClose(userId, port, reason, generation, guildId, channelId, detail);
      },
      onError: () => undefined,
    });
    if (
      generation !== ctx.sessionGeneration ||
      epoch !== (ctx.transcriptionEpochs.get(userId) ?? 0) ||
      !ctx.consent.permits(guildId, channelId, userId)
    ) {
      try {
        port.close();
      } catch {
        // The stale session is gone either way.
      }
      throw new Error("Discord voice session ended while its listener was opening");
    }
    ctx.transcriptions.set(userId, port);
    ctx.reconnectDelays.set(userId, RECONNECT_BACKOFF_INITIAL_MS);
    if (!ctx.captures.has(userId)) armSpeakerTranscriptionIdle(userId);
    return port;
  }

  function handleTranscriptionClose(
    userId: string,
    port: VoiceTranscriptionPort,
    reason: RealtimeSessionCloseReason,
    generation: number,
    guildId: string,
    channelId: string,
    detail?: RealtimeSessionCloseDetail,
  ): void {
    if (generation !== ctx.sessionGeneration) return;
    if (ctx.transcriptions.get(userId) !== port) return;
    ctx.transcriptions.delete(userId);
    ctx.transcriptTurns.delete(userId);
    cancelSpeakerTranscriptionIdle(userId);
    // "closed" is a local close — leave() shutting his ears on purpose.
    if (reason === "closed") return;
    void ctx.emitSafely({
      type: "failed",
      guildId,
      channelId,
      stage: "transcription_session",
      code: "voice_listener_lost",
      userId,
      ...providerCloseEvidence(reason, detail),
    });
    scheduleListenerReconnect(userId);
  }

  function scheduleListenerReconnect(userId: string): void {
    if (ctx.reconnectHandles.has(userId)) return;
    const generation = ctx.sessionGeneration;
    const delayMs = ctx.reconnectDelays.get(userId) ?? RECONNECT_BACKOFF_INITIAL_MS;
    ctx.reconnectDelays.set(userId, Math.min(delayMs * 2, RECONNECT_BACKOFF_CAP_MS));
    const handle = ctx.timers.setTimeout(() => {
      ctx.reconnectHandles.delete(userId);
      if (generation !== ctx.sessionGeneration || !ctx.voiceReady) return;
      const guildId = ctx.guildId;
      const channelId = ctx.channelId;
      if (guildId === undefined || channelId === undefined) return;
      if (!ctx.consent.permits(guildId, channelId, userId)) return;
      void ensureSpeakerTranscription(userId).catch(() => {
        scheduleListenerReconnect(userId);
      });
    }, delayMs);
    ctx.reconnectHandles.set(userId, handle);
  }

  function releaseSpeakerTranscription(userId: string): void {
    ctx.transcriptionEpochs.set(userId, (ctx.transcriptionEpochs.get(userId) ?? 0) + 1);
    ctx.transcriptionOpens.delete(userId);
    const reconnect = ctx.reconnectHandles.get(userId);
    if (reconnect !== undefined) ctx.timers.clearTimeout(reconnect);
    ctx.reconnectHandles.delete(userId);
    ctx.reconnectDelays.delete(userId);
    cancelSpeakerTranscriptionIdle(userId);
    ctx.speakerLastActiveAtMs.delete(userId);
    const transcription = ctx.transcriptions.get(userId);
    ctx.transcriptions.delete(userId);
    ctx.transcriptTurns.delete(userId);
    try {
      transcription?.close();
    } catch {
      // Already closed.
    }
  }

  function armSpeakerTranscriptionIdle(userId: string): void {
    cancelSpeakerTranscriptionIdle(userId);
    if (ctx.captures.has(userId) || ctx.transcriptions.get(userId)?.isOpen !== true) return;
    const generation = ctx.sessionGeneration;
    const handle = ctx.timers.setTimeout(() => {
      ctx.speakerIdleHandles.delete(userId);
      if (generation !== ctx.sessionGeneration || ctx.captures.has(userId)) return;
      releaseSpeakerTranscription(userId);
    }, SPEAKER_TRANSCRIPTION_IDLE_MS);
    ctx.speakerIdleHandles.set(userId, handle);
  }

  function cancelSpeakerTranscriptionIdle(userId: string): void {
    const handle = ctx.speakerIdleHandles.get(userId);
    if (handle !== undefined) ctx.timers.clearTimeout(handle);
    ctx.speakerIdleHandles.delete(userId);
  }

  function makeSpeakerTranscriptionCapacity(userId: string): boolean {
    const occupied = ctx.transcriptions.size + ctx.transcriptionOpens.size;
    if (occupied < MAX_SPEAKER_TRANSCRIPTION_SESSIONS) return true;
    let candidate: string | undefined;
    let candidateActiveAt = Number.POSITIVE_INFINITY;
    for (const existingUserId of ctx.transcriptions.keys()) {
      if (
        existingUserId === userId ||
        ctx.captures.has(existingUserId) ||
        (ctx.transcriptTurns.get(existingUserId)?.length ?? 0) > 0
      ) {
        continue;
      }
      const activeAt = ctx.speakerLastActiveAtMs.get(existingUserId) ?? Number.NEGATIVE_INFINITY;
      if (activeAt < candidateActiveAt) {
        candidate = existingUserId;
        candidateActiveAt = activeAt;
      }
    }
    if (candidate === undefined) return false;
    releaseSpeakerTranscription(candidate);
    return true;
  }

  function removeTranscriptTurn(turn: PendingTranscriptTurn): void {
    const turns = ctx.transcriptTurns.get(turn.userId);
    if (turns === undefined) return;
    ctx.transcriptTurns.set(
      turn.userId,
      turns.filter((candidate) => candidate !== turn),
    );
  }

  function publishLiveTranscript(line: DiscordVoiceLiveTranscript): void {
    for (const listener of ctx.liveTranscriptListeners) {
      try {
        listener(line);
      } catch {
        /* A live view must never disrupt the call. */
      }
    }
  }

  /** The owner's line so far: OpenAI streams deltas, xAI the whole line each time. */
  function publishLiveSpeech(event: RealtimeTranscriptEvent): void {
    if (ctx.liveTranscriptListeners.size === 0) return;
    const text =
      event.final || event.cumulative === true
        ? event.text
        : (ctx.liveSpeechLines.get(event.itemId) ?? "") + event.text;
    if (event.final) ctx.liveSpeechLines.delete(event.itemId);
    else ctx.liveSpeechLines.set(event.itemId, text);
    publishLiveTranscript({
      speaker: "owner",
      lineId: `owner-${event.itemId}`,
      text: event.final ? text.trim() : text,
      final: event.final,
    });
  }

  return {
    capture,
    handleUserAudio,
    finishCapture,
    cancelCapture,
    cancelReorderWait,
    applyRoomUtterance,
    dropDeferredOffer,
    ringText,
    probeTranscription,
    releaseSpeakerTranscription,
    publishLiveTranscript,
  };
}
