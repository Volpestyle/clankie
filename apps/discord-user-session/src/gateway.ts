import { WebSocket, type RawData } from "ws";

/**
 * Minimal Discord gateway client for a *normal user* credential (ADR 0048).
 *
 * `discord.js` deliberately refuses user tokens, and this plane needs only a
 * narrow slice of the protocol: identify, heartbeat, resume, the handful of
 * dispatches ingress and voice consume, and outbound voice-state updates so the
 * maintained media stack can attach. Implementing that slice keeps the surface
 * auditable rather than pulling in a general-purpose selfbot library.
 *
 * The token is held in one private field, never logged, and never placed on an
 * emitted event.
 */

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

const OP = {
  dispatch: 0,
  heartbeat: 1,
  identify: 2,
  voiceStateUpdate: 4,
  resume: 6,
  reconnect: 7,
  invalidSession: 9,
  hello: 10,
  heartbeatAck: 11,
} as const;

/** Bounded reconnect ladder; a wedged gateway must not become a hot loop. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
const RECONNECT_MAX_ATTEMPTS = 10;

export interface DiscordGatewayMessage {
  readonly id: string;
  readonly guildId?: string;
  readonly channelId: string;
  readonly authorId: string;
  readonly authorIsBot: boolean;
  readonly mentionsSelf: boolean;
  readonly content: string;
}

export interface DiscordGatewayVoiceState {
  readonly guildId?: string;
  readonly channelId?: string;
  readonly userId: string;
  readonly sessionId?: string;
  /**
   * Untouched dispatch payload. The voice adapter must hand the media stack the
   * real Discord object rather than a reconstruction — the connection reads
   * fields beyond the few this app cares about, and inventing defaults for them
   * would be a subtle protocol lie.
   */
  readonly raw: Record<string, unknown>;
}

export interface DiscordGatewayVoiceServer {
  readonly guildId: string;
  readonly token: string;
  readonly endpoint: string | null;
}

export interface DiscordGatewayEvents {
  ready: (identity: { readonly userId: string; readonly username: string }) => void;
  resumed: () => void;
  reconnecting: () => void;
  disconnected: () => void;
  /** Terminal: the credential was rejected or the reconnect budget is spent. */
  failed: (reason: string) => void;
  messageCreate: (message: DiscordGatewayMessage) => void;
  voiceStateUpdate: (state: DiscordGatewayVoiceState) => void;
  voiceServerUpdate: (server: DiscordGatewayVoiceServer) => void;
}

type Listener<E extends keyof DiscordGatewayEvents> = DiscordGatewayEvents[E];

export interface DiscordUserGatewayOptions {
  /** Normal-user credential. Sent bare — a user token carries no `Bot ` prefix. */
  readonly token: string;
  /** Injectable for tests; defaults to a real websocket to Discord. */
  readonly connect?: (url: string) => WebSocket;
  readonly url?: string;
}

export class DiscordUserGateway {
  private readonly token: string;
  private readonly connect: (url: string) => WebSocket;
  private readonly url: string;
  private readonly listeners = new Map<keyof DiscordGatewayEvents, Set<(...args: never[]) => void>>();
  private socket: WebSocket | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private sequence: number | undefined;
  private sessionId: string | undefined;
  private resumeUrl: string | undefined;
  private selfUserId: string | undefined;
  private reconnectAttempts = 0;
  private acked = true;
  private closed = false;

  public constructor(options: DiscordUserGatewayOptions) {
    if (options.token.trim().length === 0) throw new Error("discord_user_session_token_required");
    this.token = options.token;
    this.connect = options.connect ?? ((url) => new WebSocket(url));
    this.url = options.url ?? GATEWAY_URL;
  }

  public get userId(): string | undefined {
    return this.selfUserId;
  }

  public on<E extends keyof DiscordGatewayEvents>(event: E, listener: Listener<E>): void {
    const existing = this.listeners.get(event) ?? new Set();
    existing.add(listener as (...args: never[]) => void);
    this.listeners.set(event, existing);
  }

  public open(): void {
    this.closed = false;
    this.openSocket(this.url);
  }

  /** Op 4. Also the join/leave primitive the voice adapter drives. */
  public sendVoiceStateUpdate(payload: {
    readonly guildId: string;
    readonly channelId: string | null;
    readonly selfMute: boolean;
    readonly selfDeaf: boolean;
  }): boolean {
    return this.send({
      op: OP.voiceStateUpdate,
      d: {
        guild_id: payload.guildId,
        channel_id: payload.channelId,
        self_mute: payload.selfMute,
        self_deaf: payload.selfDeaf,
      },
    });
  }

  /** Raw passthrough used by the voice adapter, which builds its own op 4 frames. */
  public sendPayload(payload: unknown): boolean {
    return this.send(payload);
  }

  public close(): void {
    this.closed = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1_000, "clankie user session shutdown");
  }

  private openSocket(url: string): void {
    const socket = this.connect(url);
    this.socket = socket;
    this.acked = true;
    socket.on("message", (data: RawData) => this.receive(data));
    socket.on("error", () => this.emit("disconnected"));
    socket.on("close", (code: number) => this.handleClose(code));
  }

  private receive(data: RawData): void {
    let frame: { op?: number; d?: unknown; s?: number | null; t?: string | null };
    try {
      frame = JSON.parse(data.toString()) as typeof frame;
    } catch {
      return;
    }
    if (typeof frame.s === "number") this.sequence = frame.s;
    switch (frame.op) {
      case OP.hello: {
        const interval = record(frame.d)?.heartbeat_interval;
        if (typeof interval === "number") this.startHeartbeat(interval);
        if (this.sessionId !== undefined && this.sequence !== undefined) this.resume();
        else this.identify();
        return;
      }
      case OP.heartbeatAck:
        this.acked = true;
        return;
      case OP.heartbeat:
        this.sendHeartbeat();
        return;
      case OP.reconnect:
        this.reconnect();
        return;
      case OP.invalidSession: {
        // `d: true` means the session is resumable; anything else forces a fresh
        // identify, and a fresh identify that also fails is a credential problem.
        const resumable = frame.d === true;
        if (!resumable) {
          this.sessionId = undefined;
          this.sequence = undefined;
        }
        this.reconnect();
        return;
      }
      case OP.dispatch:
        this.dispatch(frame.t ?? "", frame.d);
        return;
      default:
        return;
    }
  }

  private dispatch(type: string, data: unknown): void {
    const payload = record(data);
    if (payload === undefined) return;
    switch (type) {
      case "READY": {
        this.reconnectAttempts = 0;
        const user = record(payload.user);
        this.sessionId = typeof payload.session_id === "string" ? payload.session_id : undefined;
        this.resumeUrl =
          typeof payload.resume_gateway_url === "string"
            ? `${payload.resume_gateway_url}?v=10&encoding=json`
            : undefined;
        this.selfUserId = typeof user?.id === "string" ? user.id : undefined;
        this.emit("ready", {
          userId: this.selfUserId ?? "unknown",
          username: typeof user?.username === "string" ? user.username : "unknown",
        });
        return;
      }
      case "RESUMED":
        this.reconnectAttempts = 0;
        this.emit("resumed");
        return;
      case "MESSAGE_CREATE": {
        const author = record(payload.author);
        if (typeof payload.id !== "string" || typeof payload.channel_id !== "string") return;
        if (typeof author?.id !== "string") return;
        const mentions = Array.isArray(payload.mentions) ? payload.mentions : [];
        this.emit("messageCreate", {
          id: payload.id,
          ...(typeof payload.guild_id === "string" ? { guildId: payload.guild_id } : {}),
          channelId: payload.channel_id,
          authorId: author.id,
          authorIsBot: author.bot === true,
          mentionsSelf: mentions.some(
            (mention) => record(mention)?.id === this.selfUserId && this.selfUserId !== undefined,
          ),
          content: typeof payload.content === "string" ? payload.content : "",
        });
        return;
      }
      case "VOICE_STATE_UPDATE": {
        if (typeof payload.user_id !== "string") return;
        this.emit("voiceStateUpdate", {
          ...(typeof payload.guild_id === "string" ? { guildId: payload.guild_id } : {}),
          ...(typeof payload.channel_id === "string" ? { channelId: payload.channel_id } : {}),
          userId: payload.user_id,
          ...(typeof payload.session_id === "string" ? { sessionId: payload.session_id } : {}),
          raw: payload,
        });
        return;
      }
      case "VOICE_SERVER_UPDATE": {
        if (typeof payload.guild_id !== "string" || typeof payload.token !== "string") return;
        this.emit("voiceServerUpdate", {
          guildId: payload.guild_id,
          token: payload.token,
          endpoint: typeof payload.endpoint === "string" ? payload.endpoint : null,
        });
        return;
      }
      default:
        return;
    }
  }

  private identify(): void {
    this.send({
      op: OP.identify,
      d: {
        token: this.token,
        // User accounts negotiate events through `capabilities`, not the bot
        // `intents` bitfield; 0 keeps us on the default dispatch set.
        capabilities: 0,
        properties: { os: "linux", browser: "Chrome", device: "" },
        compress: false,
        presence: { status: "online", since: 0, activities: [], afk: false },
      },
    });
  }

  private resume(): void {
    this.send({
      op: OP.resume,
      d: { token: this.token, session_id: this.sessionId, seq: this.sequence },
    });
  }

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.acked) {
        // A missed ack means a zombie connection: tear down rather than keep
        // pretending we are present.
        this.reconnect();
        return;
      }
      this.acked = false;
      this.sendHeartbeat();
    }, intervalMs);
  }

  private sendHeartbeat(): void {
    this.send({ op: OP.heartbeat, d: this.sequence ?? null });
  }

  private send(payload: unknown): boolean {
    const socket = this.socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  }

  private handleClose(code: number): void {
    this.clearHeartbeat();
    if (this.closed) return;
    // 4004 is an authentication failure; retrying cannot fix a bad credential
    // and repeated failed identifies are exactly what gets an account flagged.
    if (code === 4_004) {
      this.emit("failed", "discord_user_session_authentication_failed");
      return;
    }
    this.emit("disconnected");
    this.scheduleReconnect();
  }

  private reconnect(): void {
    this.clearTimers();
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(4_000, "clankie user session reconnect");
    if (this.closed) return;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== undefined) return;
    if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      this.emit("failed", "discord_user_session_reconnect_budget_exhausted");
      return;
    }
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
    this.reconnectAttempts += 1;
    this.emit("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.closed) return;
      this.openSocket(this.sessionId !== undefined ? (this.resumeUrl ?? this.url) : this.url);
    }, delay);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private clearTimers(): void {
    this.clearHeartbeat();
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private emit<E extends keyof DiscordGatewayEvents>(
    event: E,
    ...args: Parameters<DiscordGatewayEvents[E]>
  ): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (...values: Parameters<DiscordGatewayEvents[E]>) => void)(...args);
    }
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
