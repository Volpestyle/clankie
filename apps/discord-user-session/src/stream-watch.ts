import type { ClankieApiClient } from "@clankie/api-client";
import type { DiscordActiveStream, DiscordStreamWatchReport } from "@clankie/protocol";
import type { VoxStreamClient } from "@clankie/vox-client";
import type { DiscordUserGateway } from "./gateway.ts";
import { fetchActivitySnapshot } from "./go-live-source.ts";
import {
  buildDiscordStreamKey,
  createDiscordStreamDiscovery,
  deriveDiscordStreamWatchDaveChannelId,
  type DiscoveredDiscordStream,
} from "./stream-discovery.ts";
import type { VoiceMembershipCoordinator } from "./vox-gateway.ts";

export interface StreamWatchControllerOptions {
  readonly gateway: DiscordUserGateway;
  readonly api: ClankieApiClient;
  readonly allowlisted: (guildId: string, channelId: string) => boolean;
  readonly vox: VoxStreamClient;
  readonly membership: VoiceMembershipCoordinator;
  readonly now?: () => Date;
  readonly fetchActivitySnapshot?: () => Promise<
    { mimeType: "image/png"; data: string; sha256: string } | undefined
  >;
  readonly onWatchEvent?: (
    type: "watch_connected" | "frame",
    data: Record<string, string | number | boolean>,
  ) => void;
  readonly onPublishEvent?: (
    type: "publish_started" | "publish_stopped",
    data: Record<string, string | number | boolean>,
  ) => void;
}

export interface StreamWatchController {
  handleRaw(packet: { t: string; d: Record<string, unknown> }): void;
  publish(): void;
  requestPublish(input: { guildId: string; channelId: string; sourceUrl?: string }): Promise<boolean>;
  playSource(url: string): boolean;
  setPublishPaused(paused: boolean): void;
  stopPublish(): boolean;
  close(): void;
}

const WATCH_RECONNECT_BASE_MS = 250;
const WATCH_RECONNECT_MAX_MS = 4_000;
const WATCH_RECONNECT_MAX_ATTEMPTS = 5;
const PUBLISH_START_TIMEOUT_MS = 10_000;

interface PendingPublish {
  readonly guildId: string;
  readonly channelId: string;
  readonly resolve: (started: boolean) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly sourceUrl?: string;
  opcodeSent: boolean;
  pauseAccepted: boolean;
  settled: boolean;
}

/**
 * Watches Discord screen shares on the user-session body.
 *
 * Leases the target voice channel, sends OP20 STREAM_WATCH, and feeds
 * stream-server credentials to the shared Vox child. Stills are posted to the
 * clankie service while the ordinary voice role remains independently audible.
 */
export function startStreamWatch(options: StreamWatchControllerOptions): StreamWatchController {
  const now = options.now ?? (() => new Date());
  const vox = options.vox;
  let watching: DiscoveredDiscordStream | undefined;
  let requestedWatchKey: string | undefined;
  let watchTransportReady = false;
  let watchDaveProtocolVersion: number | undefined;
  let watchReceiptKey: string | undefined;
  let lastFrameAt = 0;
  let watchRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let watchRetryKey: string | undefined;
  let watchRetryAttempts = 0;
  let pendingPublish: PendingPublish | undefined;
  let publishing = false;
  let publishingStream: DiscoveredDiscordStream | undefined;
  let publishPaused = false;
  let publishTransportReady = false;
  let publishDaveProtocolVersion: number | undefined;
  let publishMediaStarted:
    | { readonly connectionGeneration: number; readonly sourceGeneration: number }
    | undefined;
  let publishReceiptSent = false;
  let transportError: string | undefined;
  let publishPump: ReturnType<typeof setInterval> | undefined;
  let lastPublishDigest: string | undefined;
  let closed = false;
  const unsubscribes: (() => void)[] = [];
  const onPublishEvent = options.onPublishEvent;
  const runVox = (action: () => void): void => {
    try {
      action();
    } catch {}
  };

  const report = (frame?: DiscordStreamWatchReport["frame"]): void => {
    if (closed) return;
    const decoder = decoderStatus(vox, transportError);
    const streams = discovery
      .listStreams()
      .filter((stream) =>
        stream.guildId.length === 0 ? true : options.allowlisted(stream.guildId, stream.channelId),
      );
    const hasFrame = lastFrameAt > 0 || frame !== undefined;
    const payload: DiscordStreamWatchReport = {
      schemaVersion: 1,
      source: "user_session",
      streams: streams.map((stream) =>
        toActive(
          stream,
          watching?.streamKey === stream.streamKey,
          hasFrame && watching?.streamKey === stream.streamKey,
        ),
      ),
      decoder,
      ...(decoder === "missing" || decoder === "error"
        ? { decoderDetail: transportError ?? vox.detail }
        : {}),
      ...(frame === undefined ? {} : { frame }),
    };
    void options.api.reportDiscordStreamWatch(payload).catch((error: unknown) => {
      console.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "stream-watch report failed",
      );
    });
  };

  const notifyWatchConnected = (): void => {
    if (
      closed ||
      watching === undefined ||
      !watchTransportReady ||
      watchDaveProtocolVersion === undefined ||
      watchReceiptKey === watching.streamKey
    ) {
      return;
    }
    watchReceiptKey = watching.streamKey;
    options.onWatchEvent?.("watch_connected", {
      userId: watching.userId,
      channelId: watching.channelId,
      decoder: "ready",
      transportReady: true,
      daveReady: true,
      daveProtocolVersion: watchDaveProtocolVersion,
    });
  };

  const notifyPublishStarted = (): void => {
    if (
      closed ||
      !publishing ||
      pendingPublish?.opcodeSent !== true ||
      pendingPublish.pauseAccepted !== true ||
      !publishTransportReady ||
      publishDaveProtocolVersion === undefined ||
      publishMediaStarted === undefined ||
      publishReceiptSent
    ) {
      return;
    }
    publishReceiptSent = true;
    onPublishEvent?.("publish_started", {
      guildId: publishingStream?.guildId ?? "",
      channelId: publishingStream?.channelId ?? "",
      source: pendingPublish?.sourceUrl === undefined ? "activity" : "url",
      transportReady: true,
      daveReady: true,
      daveProtocolVersion: publishDaveProtocolVersion,
      op18Accepted: true,
      op22Accepted: true,
      mediaStarted: true,
      connectionGeneration: publishMediaStarted.connectionGeneration,
      sourceGeneration: publishMediaStarted.sourceGeneration,
    });
  };

  const cancelWatchRetry = (resetAttempts = true): void => {
    if (watchRetryTimer !== undefined) clearTimeout(watchRetryTimer);
    watchRetryTimer = undefined;
    watchRetryKey = undefined;
    if (resetAttempts) watchRetryAttempts = 0;
  };

  const abandonWatchRetry = (stream: DiscoveredDiscordStream): void => {
    cancelWatchRetry();
    if (watching === undefined && requestedWatchKey === undefined) {
      options.membership.release("stream_watch", stream.guildId);
    }
  };

  const scheduleWatchRetry = (stream: DiscoveredDiscordStream): void => {
    if (closed || watchRetryTimer !== undefined) {
      return;
    }
    if (
      watchRetryAttempts >= WATCH_RECONNECT_MAX_ATTEMPTS ||
      !options.allowlisted(stream.guildId, stream.channelId)
    ) {
      abandonWatchRetry(stream);
      return;
    }
    const delay = Math.min(WATCH_RECONNECT_BASE_MS * 2 ** watchRetryAttempts, WATCH_RECONNECT_MAX_MS);
    watchRetryAttempts += 1;
    watchRetryKey = stream.streamKey;
    watchRetryTimer = setTimeout(() => {
      watchRetryTimer = undefined;
      const retry = discovery.listStreams().find((candidate) => candidate.streamKey === stream.streamKey);
      if (closed) return;
      if (retry === undefined || !options.allowlisted(retry.guildId, retry.channelId)) {
        abandonWatchRetry(stream);
        return;
      }
      watchRetryKey = undefined;
      if (!ensureJoined(retry)) {
        scheduleWatchRetry(retry);
        return;
      }
      connectWatch(retry);
      if (watching === undefined && requestedWatchKey === undefined && watchRetryTimer === undefined) {
        abandonWatchRetry(retry);
      }
    }, delay);
    watchRetryTimer.unref();
  };

  const connectWatch = (stream: DiscoveredDiscordStream): void => {
    if (closed || watching !== undefined) return;
    if (requestedWatchKey !== undefined && requestedWatchKey !== stream.streamKey) return;
    if (!options.allowlisted(stream.guildId, stream.channelId)) return;
    if (stream.endpoint === null || stream.token === null || stream.rtcServerId === null) return;
    const sessionId = options.gateway.voiceSessionId;
    const userId = options.gateway.userId;
    const daveChannelId = deriveDiscordStreamWatchDaveChannelId(stream.rtcServerId);
    if (sessionId === undefined || userId === undefined || daveChannelId === undefined) return;
    watching = stream;
    cancelWatchRetry(false);
    requestedWatchKey = undefined;
    watchTransportReady = false;
    watchDaveProtocolVersion = undefined;
    watchReceiptKey = undefined;
    transportError = undefined;
    lastFrameAt = 0;
    try {
      vox.streamWatchConnect({
        endpoint: stream.endpoint,
        token: stream.token,
        serverId: stream.rtcServerId,
        sessionId,
        userId,
        daveChannelId,
      });
      vox.subscribeUserVideo(stream.userId, 1);
    } catch {
      watching = undefined;
      transportError = "stream_watch_connect_failed";
      scheduleWatchRetry(stream);
    }
    report();
  };

  const connectPublish = (stream: DiscoveredDiscordStream): void => {
    if (closed || publishing) return;
    if (
      pendingPublish === undefined ||
      pendingPublish.guildId !== stream.guildId ||
      pendingPublish.channelId !== stream.channelId
    ) {
      return;
    }
    if (stream.endpoint === null || stream.token === null || stream.rtcServerId === null) return;
    const sessionId = options.gateway.voiceSessionId;
    const userId = options.gateway.userId;
    const daveChannelId = deriveDiscordStreamWatchDaveChannelId(stream.rtcServerId);
    if (sessionId === undefined || userId === undefined || daveChannelId === undefined) return;
    try {
      if (!discovery.setPublishPaused(stream.streamKey, false)) {
        failPublish(stream.guildId);
        return;
      }
      pendingPublish.pauseAccepted = true;
      vox.streamPublishConnect({
        endpoint: stream.endpoint,
        token: stream.token,
        serverId: stream.rtcServerId,
        sessionId,
        userId,
        daveChannelId,
      });
      publishing = true;
      publishingStream = stream;
      publishPaused = false;
      publishTransportReady = false;
      publishDaveProtocolVersion = undefined;
      publishMediaStarted = undefined;
      publishReceiptSent = false;
      const url = pendingPublish?.sourceUrl;
      if (url !== undefined) {
        vox.streamPublishPlay(url);
      } else {
        vox.streamPublishBrowserStart("image/png");
        startActivityPump();
      }
      settlePublishStart(true);
    } catch {
      failPublish(stream.guildId);
    }
  };

  const sendPublishOpcode = (): boolean => {
    if (closed) return false;
    if (pendingPublish === undefined || pendingPublish.opcodeSent) return pendingPublish !== undefined;
    if (options.gateway.voiceSessionId === undefined) return true;
    const sent = discovery.requestPublish(pendingPublish);
    if (sent) pendingPublish.opcodeSent = true;
    return sent;
  };

  const startActivityPump = (): void => {
    if (publishPump !== undefined) return;
    const pull = options.fetchActivitySnapshot ?? (() => fetchActivitySnapshot());
    publishPump = setInterval(() => {
      void pull()
        .then((frame) => {
          if (closed || frame === undefined || !publishing || publishPaused) return;
          if (frame.sha256 === lastPublishDigest) return;
          lastPublishDigest = frame.sha256;
          runVox(() =>
            vox.streamPublishBrowserFrame({
              mimeType: frame.mimeType,
              frameBase64: frame.data,
            }),
          );
        })
        .catch(() => undefined);
    }, 100);
    publishPump.unref();
  };

  const settlePublishStart = (started: boolean): void => {
    const pending = pendingPublish;
    if (pending === undefined || pending.settled) return;
    pending.settled = true;
    clearTimeout(pending.timer);
    pending.resolve(started);
  };

  const failPublish = (guildId?: string): void => {
    settlePublishStart(false);
    const pendingGuildId = guildId ?? pendingPublish?.guildId ?? publishingStream?.guildId;
    pendingPublish = undefined;
    stopPublishMedia();
    options.membership.release("stream_publish", pendingGuildId);
  };

  const stopPublishMedia = (): void => {
    if (publishPump !== undefined) {
      clearInterval(publishPump);
      publishPump = undefined;
    }
    if (publishing) {
      const shouldNotify = publishReceiptSent;
      publishing = false;
      publishingStream = undefined;
      publishPaused = false;
      publishTransportReady = false;
      publishDaveProtocolVersion = undefined;
      publishMediaStarted = undefined;
      publishReceiptSent = false;
      lastPublishDigest = undefined;
      runVox(() => vox.streamPublishStop());
      runVox(() => vox.streamPublishDisconnect("operator_stop"));
      if (shouldNotify) onPublishEvent?.("publish_stopped", {});
    }
  };

  const ensureJoined = (stream: DiscoveredDiscordStream): boolean => {
    if (closed) return false;
    if (stream.guildId.length === 0 || stream.channelId.length === 0) return false;
    return options.membership.acquire("stream_watch", stream.guildId, stream.channelId);
  };

  function watchFirstAvailable(): void {
    if (closed || watching !== undefined) return;
    if (requestedWatchKey !== undefined) {
      const requested = discovery
        .listStreams()
        .find((candidate) => candidate.streamKey === requestedWatchKey);
      if (requested === undefined) {
        requestedWatchKey = undefined;
      } else {
        connectWatch(requested);
        return;
      }
    }
    const stream = discovery.listStreams().find((candidate) => {
      if (candidate.userId === options.gateway.userId) return false;
      return options.allowlisted(candidate.guildId, candidate.channelId);
    });
    if (stream === undefined) return;
    if (!ensureJoined(stream)) return;
    if (stream.endpoint !== null && stream.token !== null && stream.rtcServerId !== null) {
      connectWatch(stream);
      return;
    }
    if (discovery.requestWatch(stream.streamKey)) requestedWatchKey = stream.streamKey;
    else options.membership.release("stream_watch", stream.guildId);
  }

  const discovery = createDiscordStreamDiscovery(
    { send: (payload) => options.gateway.sendPayload(payload) },
    {
      onStreamListed(stream) {
        if (closed) return;
        if (!options.allowlisted(stream.guildId, stream.channelId)) return;
        if (stream.userId === options.gateway.userId) return;
        if (watching !== undefined || requestedWatchKey !== undefined) return;
        if (!ensureJoined(stream)) return;
        if (discovery.requestWatch(stream.streamKey)) requestedWatchKey = stream.streamKey;
        else options.membership.release("stream_watch", stream.guildId);
        report();
      },
      onStreamCredentials(stream) {
        if (closed) return;
        if (stream.userId === options.gateway.userId) {
          connectPublish(stream);
          return;
        }
        if (!options.allowlisted(stream.guildId, stream.channelId)) return;
        if (!ensureJoined(stream)) return;
        connectWatch(stream);
      },
      onStreamDeleted(stream) {
        if (closed) return;
        if (stream.userId === options.gateway.userId) {
          failPublish(stream.guildId);
        }
        if (watchRetryKey === stream.streamKey) abandonWatchRetry(stream);
        if (watching?.streamKey === stream.streamKey) {
          watching = undefined;
          watchTransportReady = false;
          watchDaveProtocolVersion = undefined;
          watchReceiptKey = undefined;
          runVox(() => vox.unsubscribeUserVideo(stream.userId));
          runVox(() => vox.streamWatchDisconnect("stream_deleted"));
          options.membership.release("stream_watch", stream.guildId);
        }
        if (requestedWatchKey === stream.streamKey) {
          requestedWatchKey = undefined;
          options.membership.release("stream_watch", stream.guildId);
        }
        watchFirstAvailable();
        report();
      },
    },
  );

  const closeController = (): void => {
    if (closed) return;
    closed = true;
    cancelWatchRetry();
    for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
    stopPublishMedia();
    settlePublishStart(false);
    pendingPublish = undefined;
    options.membership.release("stream_publish");
    const stream = watching;
    watching = undefined;
    requestedWatchKey = undefined;
    watchTransportReady = false;
    watchDaveProtocolVersion = undefined;
    watchReceiptKey = undefined;
    if (stream !== undefined) {
      runVox(() => vox.unsubscribeUserVideo(stream.userId));
      runVox(() => vox.streamWatchDisconnect("shutdown"));
    }
    options.membership.release("stream_watch");
  };

  const statusRegistration = vox.onStatus((status) => {
    if (closed) return;
    if (status === "error" || status === "missing" || status === "closed") {
      closeController();
      return;
    }
    report();
  });
  if (typeof statusRegistration === "function") {
    if (closed) statusRegistration();
    else unsubscribes.push(statusRegistration);
  }

  const eventRegistration = vox.onEvent((event) => {
    if (closed) return;
    if (event.type === "dave_state" && event.role === "stream_watch") {
      watchDaveProtocolVersion =
        event.status === "ready" && (event.protocolVersion ?? 0) > 0 ? event.protocolVersion : undefined;
      notifyWatchConnected();
      return;
    }
    if (event.type === "dave_state" && event.role === "stream_publish") {
      publishDaveProtocolVersion =
        event.status === "ready" && (event.protocolVersion ?? 0) > 0 ? event.protocolVersion : undefined;
      notifyPublishStarted();
      return;
    }
    if (event.type === "stream_publish_media_started" && publishing) {
      if (
        !Number.isSafeInteger(event.connectionGeneration) ||
        event.connectionGeneration <= 0 ||
        !Number.isSafeInteger(event.sourceGeneration) ||
        event.sourceGeneration <= 0
      ) {
        return;
      }
      publishMediaStarted ??= {
        connectionGeneration: event.connectionGeneration,
        sourceGeneration: event.sourceGeneration,
      };
      notifyPublishStarted();
      return;
    }
    if (event.type === "error" && event.role === "stream_watch") {
      const stream = watching;
      if (stream !== undefined) {
        transportError = event.message;
        runVox(() => vox.unsubscribeUserVideo(stream.userId));
        runVox(() => vox.streamWatchDisconnect("transport_retry"));
        watching = undefined;
        requestedWatchKey = undefined;
        watchTransportReady = false;
        watchDaveProtocolVersion = undefined;
        watchReceiptKey = undefined;
        lastFrameAt = 0;
        scheduleWatchRetry(stream);
      }
      report();
      return;
    }
    if (event.type === "error" && event.role === "stream_publish") {
      failPublish();
      return;
    }
    if (event.type !== "transport_state") return;
    if (event.role === "stream_watch") {
      watchTransportReady = event.status === "ready";
      if (event.status === "connecting" || event.status === "ready") transportError = undefined;
      if (event.status === "ready") cancelWatchRetry();
      if (event.status === "failed" || event.status === "disconnected") {
        transportError = typeof event.reason === "string" ? event.reason : "stream_watch_transport_failed";
        const stream = watching;
        if (stream !== undefined) {
          runVox(() => vox.unsubscribeUserVideo(stream.userId));
          runVox(() => vox.streamWatchDisconnect("transport_retry"));
        }
        watching = undefined;
        requestedWatchKey = undefined;
        watchDaveProtocolVersion = undefined;
        watchReceiptKey = undefined;
        lastFrameAt = 0;
        if (stream !== undefined) scheduleWatchRetry(stream);
      }
      notifyWatchConnected();
      report();
      return;
    }
    if (event.role === "stream_publish") {
      publishTransportReady = event.status === "ready" || event.status === "playing";
      if (event.status === "failed" || event.status === "disconnected") {
        failPublish();
      }
      notifyPublishStarted();
    }
  });
  if (typeof eventRegistration === "function") {
    if (closed) eventRegistration();
    else unsubscribes.push(eventRegistration);
  }

  const frameRegistration = vox.onDecodedFrame((frame) => {
    if (closed || frame.role !== "stream_watch") return;
    const stream = watching;
    if (stream === undefined || frame.userId !== stream.userId) return;
    const captured = now();
    const firstStill = lastFrameAt === 0;
    if (captured.getTime() - lastFrameAt < 900 && !firstStill) return;
    lastFrameAt = captured.getTime();
    if (firstStill) {
      options.onWatchEvent?.("frame", {
        userId: frame.userId,
        width: frame.width,
        height: frame.height,
      });
    }
    report({
      schemaVersion: 1,
      streamKey: stream.streamKey,
      userId: frame.userId,
      width: frame.width,
      height: frame.height,
      jpegBase64: frame.jpegBase64,
      capturedAt: captured.toISOString(),
    });
  });
  if (typeof frameRegistration === "function") {
    if (closed) frameRegistration();
    else unsubscribes.push(frameRegistration);
  }

  return {
    handleRaw(packet) {
      if (closed) return;
      discovery.handle(packet);
    },
    publish() {
      if (closed) return;
      if (pendingPublish !== undefined && !sendPublishOpcode()) {
        failPublish(pendingPublish.guildId);
      }
      const own = discovery
        .listStreams()
        .find((stream) => stream.userId === options.gateway.userId && stream.endpoint !== null);
      if (own !== undefined) connectPublish(own);
      watchFirstAvailable();
      report();
    },
    async requestPublish(input) {
      if (closed) return false;
      if (!options.allowlisted(input.guildId, input.channelId)) return false;
      if (pendingPublish !== undefined || publishing) return false;
      if (!options.membership.acquire("stream_publish", input.guildId, input.channelId)) return false;
      let resolve!: (started: boolean) => void;
      const promise = new Promise<boolean>((settle) => {
        resolve = settle;
      });
      const pending: PendingPublish = {
        ...input,
        resolve,
        timer: setTimeout(() => failPublish(input.guildId), PUBLISH_START_TIMEOUT_MS),
        opcodeSent: false,
        pauseAccepted: false,
        settled: false,
      };
      pending.timer.unref();
      pendingPublish = pending;
      const sent = sendPublishOpcode();
      if (!sent) {
        failPublish(input.guildId);
      }
      return promise;
    },
    playSource(url) {
      if (closed) return false;
      const trimmed = url.trim();
      if (trimmed.length === 0) return false;
      if (publishing) {
        vox.streamPublishPlay(trimmed);
        return true;
      }
      if (pendingPublish !== undefined) {
        pendingPublish = { ...pendingPublish, sourceUrl: trimmed };
        if (sendPublishOpcode()) return true;
        const guildId = pendingPublish.guildId;
        pendingPublish = undefined;
        options.membership.release("stream_publish", guildId);
      }
      return false;
    },
    setPublishPaused(paused) {
      if (closed) return;
      const own = discovery.listStreams().find((stream) => stream.userId === options.gateway.userId);
      if (own === undefined) return;
      discovery.setPublishPaused(own.streamKey, paused);
      publishPaused = paused;
      if (paused) vox.streamPublishPause();
      else vox.streamPublishResume();
    },
    stopPublish() {
      if (closed) return false;
      const own = discovery.listStreams().find((stream) => stream.userId === options.gateway.userId);
      const fallbackKey =
        pendingPublish !== undefined && options.gateway.userId !== undefined
          ? buildDiscordStreamKey({
              guildId: pendingPublish.guildId,
              channelId: pendingPublish.channelId,
              userId: options.gateway.userId,
            })
          : undefined;
      const streamKey = own?.streamKey ?? fallbackKey;
      const hadPublish = pendingPublish !== undefined || publishing;
      const opcodeStopped = streamKey === undefined ? !hadPublish : discovery.requestPublishStop(streamKey);
      const guildId = pendingPublish?.guildId ?? publishingStream?.guildId;
      settlePublishStart(false);
      pendingPublish = undefined;
      stopPublishMedia();
      const released = options.membership.release("stream_publish", guildId);
      return opcodeStopped && released;
    },
    close() {
      closeController();
    },
  };
}

function decoderStatus(
  vox: Pick<VoxStreamClient, "available" | "status">,
  transportError?: string,
): DiscordStreamWatchReport["decoder"] {
  if (!vox.available || vox.status === "missing") return "missing";
  if (transportError !== undefined || vox.status === "error") return "error";
  if (vox.status === "ready") return "ready";
  return "idle";
}

function toActive(
  stream: DiscoveredDiscordStream,
  watching: boolean,
  hasFrame: boolean,
): DiscordActiveStream {
  return {
    schemaVersion: 1,
    streamKey: stream.streamKey,
    kind: stream.kind,
    ...(stream.guildId.length === 0 ? {} : { guildId: stream.guildId }),
    channelId: stream.channelId,
    userId: stream.userId,
    watching,
    hasFrame,
    updatedAt: new Date(stream.updatedAt).toISOString(),
  };
}
