import { VoxClientError, type VoxControlEvent } from "@clankie/vox-client";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
  REALTIME_AUDIO_SAMPLE_RATE,
  type RealtimeResponseMeta,
  type RealtimeResponseAttempt,
} from "./realtime-session.ts";
import { PCM_SAMPLE_BYTES } from "./voice-audio.ts";
import {
  MAX_SPOKEN_RESPONSE_MS,
  PLAYBACK_TIMEOUT_MS,
  PLAYBACK_CHUNK_BYTES,
  PLAYBACK_LEAD_MS,
  MAX_INVALID_PLAYBACK_ITEM_IDS,
  type DiscordVoiceSpokenTranscript,
  type PendingVoiceResponse,
  type PlaybackJob,
} from "./voice-session-context.ts";
import { sanitizeFailureCode, voxCommandFailureCode } from "./voice-session-utils.ts";

import type { VoiceSessionContext } from "./voice-session-context.ts";
type VoicePlaybackContext = Pick<
  VoiceSessionContext,
  | "outputMuted"
  | "pendingResponses"
  | "bodyLease"
  | "leaveSafely"
  | "invalidPlaybackItemIds"
  | "clock"
  | "openPlayback"
  | "sessionGeneration"
  | "playbackChain"
  | "conversation"
  | "playingJob"
  | "settleOffer"
  | "options"
  | "guildId"
  | "channelId"
  | "emitSafely"
  | "hasResponseIdentity"
  | "addStayTokens"
  | "queueMembershipResponse"
  | "music"
  | "timers"
  | "floor"
  | "staySpokenCount"
  | "outputStops"
  | "outputControlUncertain"
  | "publishLiveTranscript"
  | "spokenTranscriptListeners"
  | "speakerResponseEpochs"
>;

export function createVoicePlayback(ctx: VoicePlaybackContext) {
  // ------------------------------------------------------------------
  // Playback: streamed deltas, in order, deliberately interruptible.
  // ------------------------------------------------------------------

  function handleAudioDelta(pcm: Buffer, itemId: string): void {
    if (ctx.outputMuted) {
      const pending = ctx.pendingResponses.find((candidate) => !candidate.done);
      if (pending !== undefined) pending.superseded = true;
      pcm.fill(0);
      return;
    }
    if (ctx.bodyLease?.current() === false) {
      pcm.fill(0);
      ctx.leaveSafely("body_lease_lost");
      return;
    }
    if (ctx.invalidPlaybackItemIds.has(itemId)) {
      pcm.fill(0);
      return;
    }
    // Server responses run one at a time, so audio belongs to the oldest
    // decision the server has not finished yet.
    const pending = ctx.pendingResponses.find((candidate) => !candidate.done);
    if (
      pending === undefined ||
      pending.superseded ||
      pending.invalidated ||
      (pending.firstAudioAtMs === undefined && pending.isCurrent?.() === false)
    ) {
      // Audio with no outstanding decision is stale; zero and drop.
      pcm.fill(0);
      return;
    }
    if (pending.audioLimitReached) {
      pcm.fill(0);
      return;
    }
    const maxAudioBytes = REALTIME_AUDIO_SAMPLE_RATE * PCM_SAMPLE_BYTES * (MAX_SPOKEN_RESPONSE_MS / 1_000);
    const acceptedBytes = Math.min(pcm.byteLength, maxAudioBytes - (pending.audioBytes ?? 0));
    pending.audioBytes = (pending.audioBytes ?? 0) + acceptedBytes;
    pending.firstAudioChunkAtMs ??= ctx.clock();
    if (ctx.openPlayback === undefined || ctx.openPlayback.pending !== pending) {
      const job: PlaybackJob = {
        pending,
        itemId,
        playbackId: randomUUID(),
        encodedChunks: [],
        generation: ctx.sessionGeneration,
        providerDone: false,
        stopping: false,
        settle: undefined,
        failureReason: undefined,
      };
      ctx.openPlayback = job;
      // allow-swallowed-rejection -- The existing playback tail recovers for later responses without retrying rejected audio.
      ctx.playbackChain = ctx.playbackChain.then(() => playJob(job)).catch(() => undefined);
    }
    const job = ctx.openPlayback;
    if (!job.stopping && job.outcome === undefined) {
      for (let offset = 0; offset < acceptedBytes; offset += PLAYBACK_CHUNK_BYTES) {
        job.encodedChunks.push(
          pcm.subarray(offset, Math.min(acceptedBytes, offset + PLAYBACK_CHUNK_BYTES)).toString("base64"),
        );
      }
    }
    pcm.fill(0);
    if (pending.audioBytes >= maxAudioBytes) {
      pending.audioLimitReached = true;
      job.providerDone = true;
      try {
        ctx.conversation?.truncate(itemId, MAX_SPOKEN_RESPONSE_MS);
      } catch {
        /* Local audio cap still holds. */
      }
    }
    if (ctx.playingJob === job) pumpPlayback(job);
  }

  function handleResponseAbandoned(attempt: RealtimeResponseAttempt): void {
    const pending = ctx.pendingResponses.find(
      (candidate) => !candidate.done && candidate.requestEventId === attempt.requestEventId,
    );
    if (pending === undefined) return;
    pending.done = true;
    pending.invalidated = true;
    pending.modelResponseEmitted = true;
    if (pending.outputTranscript !== undefined) pending.outputTranscript.failed = true;
    ctx.settleOffer(pending, false);
    const jobs = new Set([ctx.openPlayback, ctx.playingJob]);
    for (const job of jobs) {
      if (job?.pending !== pending) continue;
      ctx.invalidPlaybackItemIds.add(job.itemId);
      job.stopping = true;
      job.encodedChunks.length = 0;
      settlePlayback(job, "stopped");
      if (ctx.openPlayback === job) ctx.openPlayback = undefined;
      try {
        ctx.options.vox.stopTtsPlayback(job.playbackId);
      } catch {
        /* Already retired locally. */
      }
      emitSpokenTranscript(pending, "failed", job);
    }
    emitSpokenTranscript(pending, "failed");
    ctx.pendingResponses = ctx.pendingResponses.filter((candidate) => candidate !== pending);
    const guildId = ctx.guildId,
      channelId = ctx.channelId;
    if (guildId !== undefined && channelId !== undefined)
      void ctx.emitSafely({
        type: "model_response",
        guildId,
        channelId,
        deliveryId: pending.deliveryId,
        ...(pending.speakerId === undefined ? {} : { userId: pending.speakerId }),
        ...(attempt.responseId === undefined ? {} : { responseId: attempt.responseId }),
        phase: "failed",
      });
    // No response.done or usage arrived. Leave token accounting unknown.
  }

  function handleResponseDone(meta?: RealtimeResponseMeta): void {
    if (ctx.hasResponseIdentity && meta?.requestEventId === undefined) return;
    const settled = ctx.pendingResponses.find(
      (candidate) =>
        !candidate.done &&
        (meta?.requestEventId === undefined || candidate.requestEventId === meta.requestEventId),
    );
    if (settled === undefined) return;
    settled.done = true;
    if (meta !== undefined) settled.responseMeta = meta;
    if (meta?.inputTokens !== undefined) settled.inputTokens = meta.inputTokens;
    if (meta?.outputTokens !== undefined) settled.outputTokens = meta.outputTokens;
    const job = ctx.openPlayback?.pending === settled ? ctx.openPlayback : undefined;
    if (job !== undefined) {
      job.providerDone = true;
      if (ctx.playingJob === job && !job.stopping && job.outcome === undefined) {
        pumpPlayback(job);
      }
      ctx.openPlayback = undefined;
    }
    const playbackPending = job !== undefined && settled.firstAudioAtMs === undefined && !settled.superseded;
    if (settled.offer !== undefined && (!playbackPending || settled.toolCalled === true)) {
      ctx.settleOffer(settled, settled.firstAudioAtMs !== undefined || settled.toolCalled === true);
    }
    if (!playbackPending || settled.invalidated === true || settled.superseded)
      emitModelResponseCompletion(settled);
    if (
      settled.invalidated === true ||
      settled.superseded ||
      (job === undefined && settled.firstAudioAtMs === undefined)
    ) {
      emitSpokenTranscript(
        settled,
        settled.invalidated || settled.responseMeta?.status === "failed" ? "failed" : "suppressed",
        job,
      );
      // The response spoke nothing: a function-call round trip (whose
      // follow-up response carries the speech) or a model that chose
      // silence. No audio, nothing to receipt. Tokens still landed.
      ctx.addStayTokens(settled);
      ctx.pendingResponses = ctx.pendingResponses.filter((candidate) => candidate !== settled);
    } else if (job?.outcome !== undefined && (job.outcome !== "drained" || ctx.playingJob !== job)) {
      ctx.addStayTokens(settled);
      ctx.pendingResponses = ctx.pendingResponses.filter((candidate) => candidate !== settled);
    }
    ctx.queueMembershipResponse();
  }

  function emitModelResponseCompletion(
    pending: PendingVoiceResponse,
    missingResponsePhase: "completed" | "failed" = "completed",
  ): void {
    if (pending.modelResponseEmitted === true) return;
    pending.modelResponseEmitted = true;
    const guildId = ctx.guildId;
    const channelId = ctx.channelId;
    if (guildId === undefined || channelId === undefined) return;
    const meta = pending.responseMeta;
    void ctx.emitSafely({
      type: "model_response",
      guildId,
      channelId,
      deliveryId: pending.deliveryId,
      ...(pending.speakerId === undefined ? {} : { userId: pending.speakerId }),
      phase: meta === undefined ? missingResponsePhase : meta.status === "completed" ? "completed" : "failed",
      outcome:
        pending.firstAudioAtMs !== undefined ? "audio" : pending.toolCalled === true ? "tool" : "silent",
      ...(meta?.responseId === undefined ? {} : { responseId: meta.responseId }),
      ...(meta?.audioBytes === undefined ? {} : { audioBytes: meta.audioBytes }),
      ...(meta?.textCharacters === undefined ? {} : { textCharacters: meta.textCharacters }),
    });
  }

  async function playJob(job: PlaybackJob): Promise<void> {
    const guildId = ctx.guildId;
    const channelId = ctx.channelId;
    if (job.generation !== ctx.sessionGeneration || guildId === undefined || channelId === undefined) {
      job.encodedChunks.length = 0;
      emitSpokenTranscript(job.pending, "suppressed", job);
      ctx.pendingResponses = ctx.pendingResponses.filter((candidate) => candidate !== job.pending);
      return;
    }
    if (ctx.outputMuted || job.pending.superseded || job.pending.isCurrent?.() === false) {
      job.encodedChunks.length = 0;
      job.stopping = true;
      settlePlayback(job, "stopped");
      if (job.pending.done) {
        ctx.settleOffer(job.pending, false);
        emitModelResponseCompletion(job.pending);
        if (ctx.pendingResponses.includes(job.pending)) ctx.addStayTokens(job.pending);
        ctx.pendingResponses = ctx.pendingResponses.filter((candidate) => candidate !== job.pending);
      }
      return;
    }
    await ctx.bodyLease?.guard();
    if (ctx.outputMuted || job.generation !== ctx.sessionGeneration || ctx.bodyLease?.current() === false)
      return;
    ctx.playingJob = job;
    ctx.music.duck();
    const result = await new Promise<"drained" | "stopped" | "failed" | "timeout">((resolve) => {
      job.settle = resolve;
      const timeout = ctx.timers.setTimeout(() => {
        if (job.outcome !== undefined) return;
        job.stopping = true;
        invalidatePlayback(job);
        if (job.pending.offer !== undefined && job.pending.firstAudioAtMs === undefined) {
          ctx.settleOffer(job.pending, false);
        }
        if (job.pending.done) emitModelResponseCompletion(job.pending);
        settlePlayback(job, "timeout");
        try {
          ctx.options.vox.stopTtsPlayback(job.playbackId);
        } catch {
          // Timeout already owns the outcome.
        }
      }, PLAYBACK_TIMEOUT_MS);
      const settle = job.settle;
      job.settle = (outcome) => {
        ctx.timers.clearTimeout(timeout);
        settle(outcome);
      };
      pumpPlayback(job);
    });
    const playbackMs = Math.max(0, ctx.clock() - (job.startedAtMs ?? ctx.clock()));
    if (ctx.playingJob === job) ctx.playingJob = undefined;
    if (job.generation === ctx.sessionGeneration) ctx.music.unduck();
    const pending = job.pending;
    const stillTracked = ctx.pendingResponses.includes(pending);
    const audible = result === "drained" && job.startedAtMs !== undefined;
    if (result === "timeout") {
      void ctx.emitSafely({
        type: "failed",
        guildId,
        channelId,
        deliveryId: pending.deliveryId,
        ...(pending.speakerId === undefined ? {} : { userId: pending.speakerId }),
        playbackId: job.playbackId,
        itemId: job.itemId,
        stage: "playback",
        code: "voice_playback_timeout",
      });
    } else if (result === "failed") {
      void ctx.emitSafely({
        type: "failed",
        guildId,
        channelId,
        deliveryId: pending.deliveryId,
        ...(pending.speakerId === undefined ? {} : { userId: pending.speakerId }),
        playbackId: job.playbackId,
        itemId: job.itemId,
        stage: "playback",
        code: sanitizeFailureCode(job.failureReason ?? "voice_playback_failed", "voice_playback_failed"),
      });
    }
    if (result === "drained" && !audible) {
      ctx.settleOffer(pending, false);
      if (pending.done) emitModelResponseCompletion(pending);
    }
    // A length-limited mouth can drain before the provider finishes. Keep
    // that response slot so late PCM cannot become the next speaker's reply.
    if (pending.done) {
      ctx.pendingResponses = ctx.pendingResponses.filter((candidate) => candidate !== pending);
      if (job.generation === ctx.sessionGeneration && stillTracked) ctx.addStayTokens(pending);
    }
    if (audible && job.generation === ctx.sessionGeneration && stillTracked) {
      // His own speech is a reason to hold the floor; playback refreshes decay.
      ctx.floor.noteAssistantSpokeAt(ctx.clock());
      ctx.staySpokenCount += 1;
      await ctx.emitSafely({
        type: "response",
        playbackId: job.playbackId,
        itemId: job.itemId,
        guildId,
        channelId,
        deliveryId: pending.deliveryId,
        ...(pending.speakerId === undefined ? {} : { userId: pending.speakerId }),
        ...(pending.turnId === undefined ? {} : { turnId: pending.turnId }),
        state: pending.state,
        fastPath: pending.fastPath,
        trigger: pending.trigger,
        wake: pending.wake,
        toFirstAudioMs: Math.max(
          0,
          Math.round((pending.firstAudioAtMs ?? pending.decidedAtMs) - pending.decidedAtMs),
        ),
        handoffMs: Math.round(pending.handoffMs),
        playbackMs: Math.round(playbackMs),
        ...responseLatency(pending),
        ...(pending.inputTokens === undefined ? {} : { inputTokens: pending.inputTokens }),
        ...(pending.outputTokens === undefined ? {} : { outputTokens: pending.outputTokens }),
      });
    }
    ctx.queueMembershipResponse();
  }

  function responseLatency(pending: PendingVoiceResponse): Record<string, number> {
    const fields: Record<string, number> = {};
    const elapsed = (key: string, from: number | undefined, to: number | undefined): void => {
      if (from !== undefined && to !== undefined) fields[key] = Math.max(0, Math.round(to - from));
    };
    elapsed("lastAudioToFirstAudioMs", pending.inputTiming?.lastAudioAtMs, pending.firstAudioAtMs);
    elapsed("captureEndToFirstAudioMs", pending.inputTiming?.captureEndedAtMs, pending.firstAudioAtMs);
    elapsed("transcriptToFirstAudioMs", pending.inputTiming?.transcriptFinalAtMs, pending.firstAudioAtMs);
    elapsed("transcriptToRequestMs", pending.inputTiming?.transcriptFinalAtMs, pending.decidedAtMs);
    elapsed("requestToFirstTextMs", pending.decidedAtMs, pending.firstTextAtMs);
    elapsed("requestToFirstAudioChunkMs", pending.decidedAtMs, pending.firstAudioChunkAtMs);
    elapsed("firstAudioChunkToPlaybackMs", pending.firstAudioChunkAtMs, pending.firstAudioAtMs);
    return fields;
  }

  function pumpPlayback(job: PlaybackJob): void {
    if (job.stopping || job.outcome !== undefined || job.generation !== ctx.sessionGeneration) return;
    if (job.pumpTimer !== undefined) return;
    const now = ctx.clock();
    while (job.encodedChunks.length > 0) {
      const encoded = job.encodedChunks[0]!;
      const durationMs =
        (Buffer.byteLength(encoded, "base64") / (REALTIME_AUDIO_SAMPLE_RATE * PCM_SAMPLE_BYTES)) * 1_000;
      const sendAt = Math.max(now, job.sentUntilMs ?? now);
      const delay = sendAt + durationMs - now - PLAYBACK_LEAD_MS;
      if (delay > 0) {
        job.pumpTimer = ctx.timers.setTimeout(() => {
          job.pumpTimer = undefined;
          pumpPlayback(job);
        }, Math.ceil(delay));
        return;
      }
      job.encodedChunks.shift();
      job.sentUntilMs = sendAt + durationMs;
      sendPlaybackAudio(job, encoded);
      if (job.stopping || job.outcome !== undefined) return;
    }
    if (job.providerDone && !job.finishSent) {
      job.finishSent = true;
      finishPlayback(job);
    }
  }

  function sendPlaybackAudio(job: PlaybackJob, pcmBase64: string): void {
    if (
      ctx.outputMuted ||
      job.stopping ||
      job.outcome !== undefined ||
      job.generation !== ctx.sessionGeneration
    )
      return;
    try {
      ctx.options.vox.sendAudio({
        playbackId: job.playbackId,
        pcmBase64,
        sampleRate: REALTIME_AUDIO_SAMPLE_RATE,
      });
    } catch (error) {
      failPlayback(job, error);
    }
  }

  function finishPlayback(job: PlaybackJob): void {
    try {
      ctx.options.vox.finishTtsPlayback(job.playbackId);
    } catch (error) {
      failPlayback(job, error);
    }
  }

  function handlePlaybackState(event: Extract<VoxControlEvent, { type: "tts_playback_state" }>): void {
    const stopped = ctx.outputStops.get(event.playbackId);
    if (
      stopped !== undefined &&
      stopped.generation === ctx.sessionGeneration &&
      (event.status === "stopped" || event.status === "drained")
    ) {
      ctx.outputStops.delete(event.playbackId);
      ctx.outputControlUncertain = ctx.outputStops.size > 0;
      settlePlayback(stopped, "stopped");
      return;
    }
    const job = ctx.playingJob;
    if (job === undefined || event.playbackId !== job.playbackId) return;
    if (event.status === "started") {
      if (job.startedAtMs !== undefined || job.stopping || job.outcome !== undefined) return;
      // Buffered is queued only. Started is the first evidence that playback is audible.
      job.startedAtMs = ctx.clock();
      job.pending.firstAudioAtMs = job.startedAtMs;
      if (job.pending.offer !== undefined) ctx.settleOffer(job.pending, true);
      if (job.pending.done) emitModelResponseCompletion(job.pending);
    } else if (event.status === "drained" && job.finishSent) settlePlayback(job, "drained");
    else if (event.status === "stopped") settlePlayback(job, "stopped");
    else if (event.status === "failed") {
      failPlayback(job, event.reason ?? "voice_playback_failed");
    }
  }

  function failPlayback(job: PlaybackJob, failure: unknown): void {
    if (job.outcome !== undefined) return;
    job.failureReason =
      failure instanceof VoxClientError
        ? failure.code
        : typeof failure === "string"
          ? failure
          : "voice_playback_failed";
    job.stopping = true;
    invalidatePlayback(job);
    if (job.pending.offer !== undefined && job.pending.firstAudioAtMs === undefined) {
      ctx.settleOffer(job.pending, false);
    }
    if (job.pending.done) emitModelResponseCompletion(job.pending);
    settlePlayback(job, "failed");
    try {
      ctx.options.vox.stopTtsPlayback(job.playbackId);
    } catch {
      // Local playback state is already failed and invalidated.
    }
  }

  function invalidatePlayback(job: PlaybackJob): void {
    job.pending.invalidated = true;
    const tracked = ctx.pendingResponses.includes(job.pending);
    if (tracked && job.pending.done) ctx.addStayTokens(job.pending);
    ctx.pendingResponses = ctx.pendingResponses.filter((candidate) => candidate !== job.pending);
    if (ctx.openPlayback === job) ctx.openPlayback = undefined;
    job.encodedChunks.length = 0;
    ctx.invalidPlaybackItemIds.add(job.itemId);
    if (ctx.invalidPlaybackItemIds.size > MAX_INVALID_PLAYBACK_ITEM_IDS) {
      const oldest = ctx.invalidPlaybackItemIds.values().next().value as string | undefined;
      if (oldest !== undefined) ctx.invalidPlaybackItemIds.delete(oldest);
    }
  }

  function emitSpokenTranscript(
    pending: PendingVoiceResponse,
    outcome: DiscordVoiceSpokenTranscript["outcome"],
    job?: PlaybackJob,
  ): void {
    const output = pending.outputTranscript;
    if (output === undefined || output.emitted) return;
    output.emitted = true;
    const text = output.text;
    output.text = "";
    // A reply nobody heard leaves no line; one cut off keeps what he was saying.
    const heard = outcome !== "suppressed" && pending.firstAudioAtMs !== undefined;
    ctx.publishLiveTranscript({
      speaker: "clankie",
      lineId: `clankie-${output.itemId}`,
      text: heard ? text.trim() : "",
      final: true,
    });
    if (text.trim().length === 0 || ctx.spokenTranscriptListeners.size === 0) return;
    const entry: DiscordVoiceSpokenTranscript = {
      occurredAt: new Date().toISOString(),
      guildId: output.guildId,
      channelId: output.channelId,
      ...(output.stayId === undefined ? {} : { stayId: output.stayId }),
      deliveryId: pending.deliveryId,
      role: "assistant",
      speakerId: "clankie",
      displayName: "Clankie",
      itemId: output.itemId,
      ...(job === undefined ? {} : { playbackId: job.playbackId }),
      ...(pending.responseMeta?.responseId ? { responseId: pending.responseMeta.responseId } : {}),
      text,
      textSource: output.textSource,
      textComplete: output.textComplete,
      outcome:
        output.failed || pending.responseMeta?.status === "failed"
          ? "failed"
          : pending.audioLimitReached || pending.responseMeta?.status === "incomplete"
            ? "truncated"
            : outcome,
      audioStarted: pending.firstAudioAtMs !== undefined,
      playbackMs: Math.max(0, Math.round(ctx.clock() - (pending.firstAudioAtMs ?? ctx.clock()))),
    };
    for (const listener of ctx.spokenTranscriptListeners) {
      try {
        listener(entry);
      } catch {
        /* Diagnostics must never disrupt speech. */
      }
    }
  }

  function settlePlayback(job: PlaybackJob, outcome: "drained" | "stopped" | "failed" | "timeout"): void {
    if (job.outcome !== undefined) return;
    job.outcome = outcome;
    job.pending.playbackOutcome = outcome;
    emitSpokenTranscript(
      job.pending,
      outcome === "failed" || outcome === "timeout"
        ? "failed"
        : job.startedAtMs === undefined
          ? "suppressed"
          : outcome === "drained"
            ? "played"
            : "interrupted",
      job,
    );
    if (job.pumpTimer !== undefined) ctx.timers.clearTimeout(job.pumpTimer);
    job.pumpTimer = undefined;
    job.encodedChunks.length = 0;
    const settle = job.settle;
    job.settle = undefined;
    settle?.(outcome);
  }

  /**
   * Stops provider work for a reply the room will not hear. Only the request
   * the provider is generating has an event id and is not done; queued
   * requests are already refused by their start guard.
   */
  function cancelInFlight(pending: PendingVoiceResponse): void {
    if (pending.done || pending.requestEventId === undefined) return;
    try {
      ctx.conversation?.cancelResponse(pending.requestEventId);
    } catch {
      // A closed provider has nothing left to generate.
    }
  }

  function isPlaying(): boolean {
    return (
      ctx.playingJob !== undefined &&
      ctx.playingJob.startedAtMs !== undefined &&
      !ctx.playingJob.stopping &&
      ctx.playingJob.outcome === undefined
    );
  }

  /**
   * Deliberate barge-in (ADR 0057): `interrupt_response` is off, so nothing
   * truncates him automatically. This stops the correlated Vox playback and issues
   * `conversation.item.truncate` at the played offset, so what the room heard
   * and what the conversation context retains agree.
   */
  function truncatePlayback(userId: string): void {
    const job = ctx.playingJob;
    const guildId = ctx.guildId;
    const channelId = ctx.channelId;
    if (job === undefined || guildId === undefined || channelId === undefined) return;
    if (job.stopping || job.outcome !== undefined) return;
    const playedMs = Math.max(0, Math.round(ctx.clock() - (job.startedAtMs ?? ctx.clock())));
    ctx.speakerResponseEpochs.set(userId, (ctx.speakerResponseEpochs.get(userId) ?? 0) + 1);
    let supersededBacklog = false;
    for (const pending of ctx.pendingResponses) {
      if (pending.speakerId === userId) {
        if (pending !== job.pending && !pending.superseded) supersededBacklog = true;
        pending.superseded = true;
      }
    }
    // Truncation may synchronously release a held response.done and start the next request.
    job.stopping = true;
    settlePlayback(job, "stopped");
    // The interrupted reply may still be generating; the rest of it is unwanted.
    // Cancelled before the truncate below, the order the provider documents.
    for (const pending of ctx.pendingResponses) {
      if (pending === job.pending || pending.superseded) cancelInFlight(pending);
    }
    if (supersededBacklog) {
      try {
        ctx.conversation?.createTextItem(
          `System note: pending speech for authenticated speakerId ${JSON.stringify(userId)} was ` +
            "superseded by that speaker's interruption. Do not assume the room heard those queued replies. " +
            "Tool results remain available as context.",
        );
      } catch {
        // A closed conversation must not prevent local playback from stopping.
      }
    }
    try {
      ctx.conversation?.truncate(job.itemId, playedMs);
    } catch {
      // The session may have closed; stopping playback still matters.
    }
    try {
      ctx.options.vox.stopTtsPlayback(job.playbackId);
    } catch (error) {
      void ctx.emitSafely({
        type: "failed",
        guildId,
        channelId,
        deliveryId: job.pending.deliveryId,
        ...(job.pending.speakerId === undefined ? {} : { userId: job.pending.speakerId }),
        playbackId: job.playbackId,
        itemId: job.itemId,
        stage: "playback",
        code: voxCommandFailureCode(error, "voice_playback_stop_failed"),
      });
    }
    void ctx.emitSafely({
      type: "interrupted",
      guildId,
      channelId,
      userId,
      phase: "playing",
      deliveryId: job.pending.deliveryId,
      playbackId: job.playbackId,
      itemId: job.itemId,
    });
  }

  return {
    handleAudioDelta,
    handleResponseAbandoned,
    handleResponseDone,
    emitModelResponseCompletion,
    pumpPlayback,
    handlePlaybackState,
    failPlayback,
    emitSpokenTranscript,
    settlePlayback,
    cancelInFlight,
    isPlaying,
    truncatePlayback,
  };
}
