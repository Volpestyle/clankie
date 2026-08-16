/**
 * Discord Go Live discovery and opcodes for the user-session gateway.
 *
 * Ported from v1 `discordStreamDiscovery.ts`. The lab body owns these opcodes
 * (OP18 create, OP19 delete, OP20 watch, OP22 pause). A bot cannot send them.
 */

export interface DiscordRawPacket {
  readonly t?: string;
  readonly d?: Record<string, unknown> | null;
}

export type DiscordStreamKind = "guild" | "call";

export interface DiscoveredDiscordStream {
  readonly kind: DiscordStreamKind;
  readonly streamKey: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly userId: string;
  readonly endpoint: string | null;
  readonly token: string | null;
  readonly rtcServerId: string | null;
  readonly updatedAt: number;
}

export interface DiscordStreamDiscoveryHooks {
  onStreamCredentials?(stream: DiscoveredDiscordStream): void;
  onStreamDeleted?(stream: DiscoveredDiscordStream): void;
  onStreamListed?(stream: DiscoveredDiscordStream): void;
}

export interface DiscordStreamSender {
  send(payload: { op: number; d: unknown }): boolean;
}

const STREAM_DISCOVERY_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_DISCOVERED_STREAMS = 128;

export function buildDiscordStreamKey(input: { guildId: string; channelId: string; userId: string }): string {
  return `guild:${input.guildId}:${input.channelId}:${input.userId}`;
}

export function buildDiscordCallStreamKey(input: { channelId: string; userId: string }): string {
  return `call:${input.channelId}:${input.userId}`;
}

export function deriveDiscordStreamWatchDaveChannelId(
  rtcServerId: string | null | undefined,
): string | undefined {
  const normalized = stringValue(rtcServerId);
  if (normalized.length === 0) return undefined;
  try {
    const serverId = BigInt(normalized);
    if (serverId <= 0n) return undefined;
    return String(serverId - 1n);
  } catch {
    return undefined;
  }
}

export function createDiscordStreamDiscovery(
  sender: DiscordStreamSender,
  hooks: DiscordStreamDiscoveryHooks = {},
): {
  handle(packet: DiscordRawPacket): void;
  listStreams(): DiscoveredDiscordStream[];
  findStream(target?: string): DiscoveredDiscordStream | undefined;
  requestWatch(streamKey: string): boolean;
  requestPublish(input: { kind?: DiscordStreamKind; guildId: string; channelId: string }): boolean;
  requestPublishStop(streamKey: string): boolean;
  setPublishPaused(streamKey: string, paused: boolean): boolean;
} {
  const streams = new Map<string, DiscoveredDiscordStream>();

  const upsert = (input: DiscoveredDiscordStream): DiscoveredDiscordStream => {
    const existing = streams.get(input.streamKey);
    const stream: DiscoveredDiscordStream = {
      kind: input.kind,
      streamKey: input.streamKey,
      guildId: input.guildId || existing?.guildId || "",
      channelId: input.channelId || existing?.channelId || "",
      userId: input.userId || existing?.userId || "",
      endpoint: input.endpoint ?? existing?.endpoint ?? null,
      token: input.token ?? existing?.token ?? null,
      rtcServerId: input.rtcServerId ?? existing?.rtcServerId ?? null,
      updatedAt: input.updatedAt,
    };
    if (streams.size >= MAX_DISCOVERED_STREAMS && !streams.has(stream.streamKey)) {
      const oldest = [...streams.values()].sort((left, right) => left.updatedAt - right.updatedAt)[0];
      if (oldest !== undefined) streams.delete(oldest.streamKey);
    }
    streams.set(stream.streamKey, stream);
    return stream;
  };

  const expire = (now: number): void => {
    for (const [key, stream] of streams) {
      if (now - stream.updatedAt > STREAM_DISCOVERY_TTL_MS) streams.delete(key);
    }
  };

  return {
    handle(packet) {
      if (packet.d === undefined || packet.d === null) return;
      const now = Date.now();
      expire(now);
      if (packet.t === "GUILD_CREATE") {
        handleGuildCreate(packet.d, upsert, now);
        return;
      }
      if (packet.t === "VOICE_STATE_UPDATE") {
        const result = handleVoiceStateUpdate(packet.d, streams, upsert, now);
        if (result?.deleted !== undefined) hooks.onStreamDeleted?.(result.deleted);
        if (result?.listed !== undefined) hooks.onStreamListed?.(result.listed);
        return;
      }
      if (packet.t === "STREAM_CREATE") {
        const stream = handleStreamCreate(packet.d, upsert, now);
        if (stream === undefined) return;
        if (hasCredentials(stream)) hooks.onStreamCredentials?.(stream);
        else hooks.onStreamListed?.(stream);
        return;
      }
      if (packet.t === "STREAM_SERVER_UPDATE") {
        const stream = handleStreamServerUpdate(packet.d, upsert, now);
        if (stream !== undefined && hasCredentials(stream)) hooks.onStreamCredentials?.(stream);
        return;
      }
      if (packet.t === "STREAM_DELETE") {
        const streamKey = stringValue(packet.d.stream_key) || streamKeyFromParts(packet.d);
        if (streamKey === undefined) return;
        const existing = streams.get(streamKey);
        streams.delete(streamKey);
        if (existing !== undefined) hooks.onStreamDeleted?.(existing);
      }
    },
    listStreams() {
      expire(Date.now());
      return [...streams.values()].sort((left, right) => right.updatedAt - left.updatedAt);
    },
    findStream(target) {
      const listed = [...streams.values()].sort((left, right) => right.updatedAt - left.updatedAt);
      const needle = target?.trim().toLowerCase();
      if (needle === undefined || needle.length === 0) return listed[0];
      return listed.find(
        (stream) =>
          stream.streamKey.toLowerCase().includes(needle) ||
          stream.userId === needle ||
          stream.channelId === needle,
      );
    },
    requestWatch(streamKey) {
      return sender.send({ op: 20, d: { stream_key: streamKey } });
    },
    requestPublish(input) {
      const kind = input.kind ?? "guild";
      const guildId = input.guildId.trim();
      const channelId = input.channelId.trim();
      if (channelId.length === 0 || (kind === "guild" && guildId.length === 0)) return false;
      return sender.send({
        op: 18,
        d:
          kind === "call"
            ? { type: "call", channel_id: channelId, preferred_region: null }
            : { type: "guild", guild_id: guildId, channel_id: channelId, preferred_region: null },
      });
    },
    requestPublishStop(streamKey) {
      const key = streamKey.trim();
      if (key.length === 0) return false;
      return sender.send({ op: 19, d: { stream_key: key } });
    },
    setPublishPaused(streamKey, paused) {
      const key = streamKey.trim();
      if (key.length === 0) return false;
      return sender.send({ op: 22, d: { stream_key: key, paused } });
    },
  };
}

function handleVoiceStateUpdate(
  data: Record<string, unknown>,
  streams: Map<string, DiscoveredDiscordStream>,
  upsert: (input: DiscoveredDiscordStream) => DiscoveredDiscordStream,
  now: number,
): { deleted?: DiscoveredDiscordStream; listed?: DiscoveredDiscordStream } | undefined {
  const guildId = stringValue(data.guild_id);
  const channelId = stringValue(data.channel_id);
  const userId = stringValue(data.user_id);
  if (guildId.length === 0 || userId.length === 0) return undefined;
  if (data.self_stream === false) {
    const deleted = removeStreamsForUser(streams, { guildId, userId });
    return deleted === undefined ? undefined : { deleted };
  }
  if (data.self_stream !== true || channelId.length === 0) return undefined;
  const listed = upsert({
    kind: "guild",
    streamKey: buildDiscordStreamKey({ guildId, channelId, userId }),
    guildId,
    channelId,
    userId,
    endpoint: null,
    token: null,
    rtcServerId: null,
    updatedAt: now,
  });
  return { listed };
}

function handleStreamCreate(
  data: Record<string, unknown>,
  upsert: (input: DiscoveredDiscordStream) => DiscoveredDiscordStream,
  now: number,
): DiscoveredDiscordStream | undefined {
  const streamKey = stringValue(data.stream_key) || streamKeyFromParts(data);
  const parts = streamKey === undefined ? undefined : parseStreamKey(streamKey);
  if (streamKey === undefined || parts === undefined) return undefined;
  return upsert({
    kind: parts.kind,
    streamKey,
    guildId: parts.guildId ?? "",
    channelId: parts.channelId,
    userId: parts.userId,
    endpoint: stringValue(data.endpoint) || null,
    token: stringValue(data.token) || null,
    rtcServerId: stringValue(data.rtc_server_id) || stringValue(data.rtcServerId) || null,
    updatedAt: now,
  });
}

function handleGuildCreate(
  data: Record<string, unknown>,
  upsert: (input: DiscoveredDiscordStream) => DiscoveredDiscordStream,
  now: number,
): void {
  const guildId = stringValue(data.id);
  if (guildId.length === 0 || !Array.isArray(data.voice_states)) return;
  for (const entry of data.voice_states) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const state = entry as Record<string, unknown>;
    if (state.self_stream !== true) continue;
    const channelId = stringValue(state.channel_id);
    const userId = stringValue(state.user_id);
    if (channelId.length === 0 || userId.length === 0) continue;
    upsert({
      kind: "guild",
      streamKey: buildDiscordStreamKey({ guildId, channelId, userId }),
      guildId,
      channelId,
      userId,
      endpoint: null,
      token: null,
      rtcServerId: null,
      updatedAt: now,
    });
  }
}

function handleStreamServerUpdate(
  data: Record<string, unknown>,
  upsert: (input: DiscoveredDiscordStream) => DiscoveredDiscordStream,
  now: number,
): DiscoveredDiscordStream | undefined {
  return handleStreamCreate(data, upsert, now);
}

function removeStreamsForUser(
  streams: Map<string, DiscoveredDiscordStream>,
  input: { guildId: string; userId: string },
): DiscoveredDiscordStream | undefined {
  let removed: DiscoveredDiscordStream | undefined;
  for (const [key, stream] of streams) {
    if (stream.guildId !== input.guildId || stream.userId !== input.userId) continue;
    streams.delete(key);
    removed = stream;
  }
  return removed;
}

function streamKeyFromParts(data: Record<string, unknown>): string | undefined {
  const guildId = stringValue(data.guild_id);
  const channelId = stringValue(data.channel_id);
  const userId = stringValue(data.user_id);
  if (channelId.length === 0 || userId.length === 0) return undefined;
  if (guildId.length === 0) return buildDiscordCallStreamKey({ channelId, userId });
  return buildDiscordStreamKey({ guildId, channelId, userId });
}

function parseStreamKey(
  streamKey: string,
): { kind: DiscordStreamKind; guildId?: string; channelId: string; userId: string } | undefined {
  const [kind, first, second, third] = streamKey.split(":");
  if (kind === "guild" && first !== undefined && second !== undefined && third !== undefined) {
    return { kind, guildId: first, channelId: second, userId: third };
  }
  if (kind === "call" && first !== undefined && second !== undefined) {
    return { kind, channelId: first, userId: second };
  }
  return undefined;
}

function hasCredentials(stream: DiscoveredDiscordStream): boolean {
  return stream.endpoint !== null && stream.token !== null && stream.rtcServerId !== null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
