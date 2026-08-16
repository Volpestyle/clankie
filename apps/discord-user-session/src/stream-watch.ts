import type { ClankieApiClient } from "@clankie/api-client";
import type { DiscordActiveStream, DiscordStreamWatchReport } from "@clankie/protocol";
import { createVoxClient, type VoxStreamClient } from "@clankie/vox-client";
import type { DiscordUserGateway } from "./gateway.ts";
import { fetchActivitySnapshot } from "./go-live-source.ts";
import {
  createDiscordStreamDiscovery,
  deriveDiscordStreamWatchDaveChannelId,
  type DiscoveredDiscordStream,
} from "./stream-discovery.ts";

export interface StreamWatchControllerOptions {
  readonly gateway: DiscordUserGateway;
  readonly api: ClankieApiClient;
  readonly allowlisted: (guildId: string, channelId: string) => boolean;
  readonly vox?: VoxStreamClient;
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
  /**
   * When this process is the active mouth, join unmuted so he can talk and
   * play music. Watch-only (bot is the mouth) still joins muted and deafened.
   */
  readonly joinMuted?: boolean;
}

/**
 * Watches Discord screen shares on the user-session body.
 *
 * Joins the target voice channel muted and deafened (no second mouth), sends
 * OP20 STREAM_WATCH, and feeds stream-server credentials to ClankVox. Stills
 * are posted to the clankie service; the official bot keeps talking.
 */
export function startStreamWatch(options: StreamWatchControllerOptions): {
  handleRaw(packet: { t: string; d: Record<string, unknown> }): void;
  publish(): void;
  requestPublish(input: { guildId: string; channelId: string; sourceUrl?: string }): boolean;
  playSource(url: string): boolean;
  setPublishPaused(paused: boolean): void;
  stopPublish(): void;
  close(): void;
} {
  const now = options.now ?? (() => new Date());
  const vox =
    options.vox ??
    createVoxClient({
      onError: (message) => {
        console.warn({ message }, "Vox sidecar");
      },
      onLog: (message) => {
        console.warn({ message }, "Vox sidecar");
      },
    });
  let watching: DiscoveredDiscordStream | undefined;
  let requestedWatchKey: string | undefined;
  let watchTransportReady = false;
  let watchReceiptKey: string | undefined;
  let joinedForWatch: { guildId: string; channelId: string } | undefined;
  let lastFrameAt = 0;
  let pendingPublish:
    | { guildId: string; channelId: string; sourceUrl?: string; opcodeSent: boolean }
    | undefined;
  let publishing = false;
  let publishingStream: DiscoveredDiscordStream | undefined;
  let publishPaused = false;
  let publishTransportReady = false;
  let publishReceiptSent = false;
  let transportError: string | undefined;
  let publishPump: ReturnType<typeof setInterval> | undefined;
  let lastPublishDigest: string | undefined;
  const onPublishEvent = options.onPublishEvent;
  const joinMuted = options.joinMuted !== false;

  const report = (frame?: DiscordStreamWatchReport["frame"]): void => {
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
    if (watching === undefined || !watchTransportReady || watchReceiptKey === watching.streamKey) return;
    watchReceiptKey = watching.streamKey;
    options.onWatchEvent?.("watch_connected", {
      userId: watching.userId,
      channelId: watching.channelId,
      decoder: "ready",
    });
  };

  const notifyPublishStarted = (): void => {
    if (!publishing || !publishTransportReady || publishReceiptSent) return;
    publishReceiptSent = true;
    onPublishEvent?.("publish_started", {
      guildId: publishingStream?.guildId ?? "",
      channelId: publishingStream?.channelId ?? "",
      source: pendingPublish?.sourceUrl === undefined ? "activity" : "url",
    });
  };

  const connectWatch = (stream: DiscoveredDiscordStream): void => {
    if (watching !== undefined) return;
    if (requestedWatchKey !== undefined && requestedWatchKey !== stream.streamKey) return;
    if (!options.allowlisted(stream.guildId, stream.channelId)) return;
    if (stream.endpoint === null || stream.token === null || stream.rtcServerId === null) return;
    const sessionId = options.gateway.voiceSessionId;
    const userId = options.gateway.userId;
    const daveChannelId = deriveDiscordStreamWatchDaveChannelId(stream.rtcServerId);
    if (sessionId === undefined || userId === undefined || daveChannelId === undefined) return;
    watching = stream;
    requestedWatchKey = undefined;
    watchTransportReady = false;
    watchReceiptKey = undefined;
    transportError = undefined;
    lastFrameAt = 0;
    vox.streamWatchConnect({
      endpoint: stream.endpoint,
      token: stream.token,
      serverId: stream.rtcServerId,
      sessionId,
      userId,
      daveChannelId,
    });
    vox.subscribeUserVideo(stream.userId, 1);
    report();
  };

  const connectPublish = (stream: DiscoveredDiscordStream): void => {
    if (publishing) return;
    if (stream.endpoint === null || stream.token === null || stream.rtcServerId === null) return;
    const sessionId = options.gateway.voiceSessionId;
    const userId = options.gateway.userId;
    const daveChannelId = deriveDiscordStreamWatchDaveChannelId(stream.rtcServerId);
    if (sessionId === undefined || userId === undefined || daveChannelId === undefined) return;
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
    publishReceiptSent = false;
    const url = pendingPublish?.sourceUrl;
    if (url !== undefined) {
      vox.streamPublishPlay(url);
    } else {
      vox.streamPublishBrowserStart("image/png");
      startActivityPump();
    }
    discovery.setPublishPaused(stream.streamKey, false);
  };

  const sendPublishOpcode = (): boolean => {
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
      void pull().then((frame) => {
        if (frame === undefined || !publishing || publishPaused) return;
        if (frame.sha256 === lastPublishDigest) return;
        lastPublishDigest = frame.sha256;
        vox.streamPublishBrowserFrame({
          mimeType: frame.mimeType,
          frameBase64: frame.data,
        });
      });
    }, 100);
    publishPump.unref();
  };

  const stopPublishMedia = (): void => {
    if (publishPump !== undefined) {
      clearInterval(publishPump);
      publishPump = undefined;
    }
    if (publishing) {
      vox.streamPublishStop();
      vox.streamPublishDisconnect("operator_stop");
      publishing = false;
      publishingStream = undefined;
      publishPaused = false;
      publishTransportReady = false;
      publishReceiptSent = false;
      lastPublishDigest = undefined;
      onPublishEvent?.("publish_stopped", {});
    }
  };

  const ensureJoined = (stream: DiscoveredDiscordStream): void => {
    if (stream.guildId.length === 0 || stream.channelId.length === 0) return;
    options.gateway.sendVoiceStateUpdate({
      guildId: stream.guildId,
      channelId: stream.channelId,
      selfMute: joinMuted,
      selfDeaf: joinMuted,
    });
    joinedForWatch = { guildId: stream.guildId, channelId: stream.channelId };
  };

  function watchFirstAvailable(): void {
    if (watching !== undefined) return;
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
    ensureJoined(stream);
    if (stream.endpoint !== null && stream.token !== null && stream.rtcServerId !== null) {
      connectWatch(stream);
      return;
    }
    if (discovery.requestWatch(stream.streamKey)) requestedWatchKey = stream.streamKey;
  }

  const discovery = createDiscordStreamDiscovery(
    { send: (payload) => options.gateway.sendPayload(payload) },
    {
      onStreamListed(stream) {
        if (!options.allowlisted(stream.guildId, stream.channelId)) return;
        if (stream.userId === options.gateway.userId) return;
        if (watching !== undefined || requestedWatchKey !== undefined) return;
        ensureJoined(stream);
        if (discovery.requestWatch(stream.streamKey)) requestedWatchKey = stream.streamKey;
        report();
      },
      onStreamCredentials(stream) {
        if (stream.userId === options.gateway.userId) {
          connectPublish(stream);
          return;
        }
        if (!options.allowlisted(stream.guildId, stream.channelId)) return;
        ensureJoined(stream);
        connectWatch(stream);
      },
      onStreamDeleted(stream) {
        if (stream.userId === options.gateway.userId) {
          pendingPublish = undefined;
          stopPublishMedia();
        }
        if (watching?.streamKey === stream.streamKey) {
          vox.unsubscribeUserVideo(stream.userId);
          vox.streamWatchDisconnect("stream_deleted");
          watching = undefined;
          watchTransportReady = false;
          watchReceiptKey = undefined;
          if (joinedForWatch !== undefined && pendingPublish === undefined) {
            options.gateway.sendVoiceStateUpdate({
              guildId: joinedForWatch.guildId,
              channelId: null,
              selfMute: true,
              selfDeaf: true,
            });
            joinedForWatch = undefined;
          }
        }
        if (requestedWatchKey === stream.streamKey) requestedWatchKey = undefined;
        watchFirstAvailable();
        report();
      },
    },
  );

  vox.onStatus(() => {
    report();
  });

  vox.onEvent((event) => {
    if (
      event.type !== "transport_state" ||
      typeof event.role !== "string" ||
      typeof event.status !== "string"
    ) {
      return;
    }
    if (event.role === "stream_watch") {
      watchTransportReady = event.status === "ready";
      if (event.status === "connecting" || event.status === "ready") transportError = undefined;
      if (event.status === "failed") {
        transportError = typeof event.reason === "string" ? event.reason : "stream_watch_transport_failed";
      }
      notifyWatchConnected();
      report();
      return;
    }
    if (event.role === "stream_publish") {
      publishTransportReady = event.status === "ready" || event.status === "playing";
      notifyPublishStarted();
    }
  });

  vox.onDecodedFrame((frame) => {
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

  return {
    handleRaw(packet) {
      discovery.handle(packet);
    },
    publish() {
      sendPublishOpcode();
      const own = discovery
        .listStreams()
        .find((stream) => stream.userId === options.gateway.userId && stream.endpoint !== null);
      if (own !== undefined) connectPublish(own);
      watchFirstAvailable();
      report();
    },
    requestPublish(input) {
      pendingPublish = { ...input, opcodeSent: false };
      options.gateway.sendVoiceStateUpdate({
        guildId: input.guildId,
        channelId: input.channelId,
        selfMute: joinMuted,
        selfDeaf: joinMuted,
      });
      joinedForWatch = { guildId: input.guildId, channelId: input.channelId };
      return sendPublishOpcode();
    },
    playSource(url) {
      const trimmed = url.trim();
      if (trimmed.length === 0) return false;
      if (publishing) {
        vox.streamPublishPlay(trimmed);
        return true;
      }
      if (pendingPublish !== undefined) {
        pendingPublish = { ...pendingPublish, sourceUrl: trimmed };
        return sendPublishOpcode();
      }
      return false;
    },
    setPublishPaused(paused) {
      const own = discovery.listStreams().find((stream) => stream.userId === options.gateway.userId);
      if (own === undefined) return;
      discovery.setPublishPaused(own.streamKey, paused);
      publishPaused = paused;
      if (paused) vox.streamPublishPause();
      else vox.streamPublishResume();
    },
    stopPublish() {
      const own = discovery.listStreams().find((stream) => stream.userId === options.gateway.userId);
      if (own !== undefined) discovery.requestPublishStop(own.streamKey);
      pendingPublish = undefined;
      stopPublishMedia();
    },
    close() {
      stopPublishMedia();
      if (watching !== undefined) {
        vox.unsubscribeUserVideo(watching.userId);
        vox.streamWatchDisconnect("shutdown");
      }
      vox.close();
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
