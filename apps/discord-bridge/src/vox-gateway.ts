import type { JoinDiscordVoiceInput } from "@clankie/discord-presence-core";
import type { VoxClient, VoxControlEvent, VoxProcessStatus } from "@clankie/vox-client";
import type {
  InternalDiscordGatewayAdapterCreator,
  InternalDiscordGatewayAdapterImplementerMethods,
  InternalDiscordGatewayAdapterLibraryMethods,
} from "discord.js";

const ADAPTER_LEAVE_TIMEOUT_MS = 3_000;
const DISCORD_ID = /^\d{1,20}$/u;

export interface DiscordVoxGuild {
  readonly id: string;
  readonly voiceAdapterCreator: InternalDiscordGatewayAdapterCreator;
}

export interface DiscordVoxSession {
  status(): { readonly active: boolean; readonly guildId?: string; readonly channelId?: string };
  join(input: JoinDiscordVoiceInput): Promise<{ readonly daveProtocolVersion?: number }>;
  leave(reason?: string): Promise<void>;
}

interface AdapterRegistration {
  readonly guildId: string;
  readonly channelId: string;
  adapter: InternalDiscordGatewayAdapterImplementerMethods;
  gatewayLeaveConfirmed: boolean;
  externalLeaveFinalization?: Promise<void>;
}

interface PendingFailure {
  readonly reject: (error: Error) => void;
}

interface PendingLeave extends PendingFailure {
  readonly resolve: () => void;
}

interface VoiceStatePayload {
  readonly op: 4;
  readonly d: {
    readonly guild_id: string;
    readonly channel_id: string | null;
    readonly self_mute: boolean;
    readonly self_deaf: boolean;
  };
}

/** Keeps the official bot gateway outside Vox while Vox remains the sole media owner. */
export class DiscordVoxGatewayBridge {
  private readonly vox: VoxClient;
  private readonly session: DiscordVoxSession;
  private readonly onError: (message: string) => void;
  private readonly onLeaveConfirmed: (confirmation: {
    readonly guildId: string;
    readonly channelId: string;
  }) => void | Promise<void>;
  private readonly leaveTimeoutMs: number;
  private readonly unsubscribes: (() => void)[];
  private registration: AdapterRegistration | undefined;
  private pendingJoin: PendingFailure | undefined;
  private pendingLeave: PendingLeave | undefined;
  private leavePromise: Promise<void> | undefined;
  private joinInFlight = false;
  private disposed = false;
  private handlingFailure = false;

  public constructor(
    vox: VoxClient,
    session: DiscordVoxSession,
    options: {
      readonly onError?: (message: string) => void;
      readonly onLeaveConfirmed?: (confirmation: {
        readonly guildId: string;
        readonly channelId: string;
      }) => void | Promise<void>;
      readonly leaveTimeoutMs?: number;
    } = {},
  ) {
    this.vox = vox;
    this.session = session;
    this.onError = options.onError ?? (() => undefined);
    this.onLeaveConfirmed = options.onLeaveConfirmed ?? (() => undefined);
    this.leaveTimeoutMs = options.leaveTimeoutMs ?? ADAPTER_LEAVE_TIMEOUT_MS;
    this.unsubscribes = [
      vox.onEvent((event) => this.handleVoxEvent(event)),
      vox.onStatus((status, detail) => this.handleVoxStatus(status, detail)),
    ];
  }

  public async join(
    guild: DiscordVoxGuild,
    input: JoinDiscordVoiceInput,
  ): Promise<{ readonly daveProtocolVersion?: number }> {
    if (this.disposed) throw new Error("Discord Vox gateway bridge is disposed");
    if (this.joinInFlight) throw new Error("Discord voice join is already in progress");
    if (this.vox.status !== "ready") throw new Error(`Vox process is not ready: ${this.vox.detail}`);
    if (guild.id !== input.guildId) throw new Error("Discord voice guild does not match the join target");

    this.joinInFlight = true;
    try {
      await this.leave("voice_rejoin");
      this.register(guild, input.channelId);
      let rejectJoin: ((error: Error) => void) | undefined;
      const adapterFailure = new Promise<never>((_resolve, reject) => {
        rejectJoin = reject;
      });
      const pending = { reject: (error: Error) => rejectJoin?.(error) };
      this.pendingJoin = pending;
      try {
        return await Promise.race([this.session.join(input), adapterFailure]);
      } catch (error) {
        await this.leave("join_failed").catch(() => undefined);
        throw error;
      } finally {
        if (this.pendingJoin === pending) this.pendingJoin = undefined;
      }
    } finally {
      this.joinInFlight = false;
    }
  }

  public leave(reason = "session_leave"): Promise<void> {
    if (this.leavePromise !== undefined) return this.leavePromise;
    const leaving = this.leaveNow(reason);
    this.leavePromise = leaving;
    const clear = (): void => {
      if (this.leavePromise === leaving) this.leavePromise = undefined;
    };
    void leaving.then(clear, clear);
    return leaving;
  }

  private async leaveNow(reason: string): Promise<void> {
    const registration = this.registration;
    if (registration === undefined) {
      await this.session.leave(reason);
      return;
    }
    if (registration.gatewayLeaveConfirmed) {
      await (registration.externalLeaveFinalization ?? this.session.leave(reason));
      return;
    }

    let resolveLeave: (() => void) | undefined;
    let rejectLeave: ((error: Error) => void) | undefined;
    const gatewayLeave = new Promise<void>((resolve, reject) => {
      resolveLeave = resolve;
      rejectLeave = reject;
    });
    const pending: PendingLeave = {
      resolve: () => resolveLeave?.(),
      reject: (error) => rejectLeave?.(error),
    };
    this.pendingLeave = pending;
    const timeout = setTimeout(() => {
      pending.reject(new Error("Discord did not confirm the bot voice-state leave before the timeout"));
    }, this.leaveTimeoutMs);
    timeout.unref?.();
    try {
      await Promise.all([this.session.leave(reason), gatewayLeave]);
      await this.onLeaveConfirmed({
        guildId: registration.guildId,
        channelId: registration.channelId,
      });
    } finally {
      clearTimeout(timeout);
      if (this.pendingLeave === pending) this.pendingLeave = undefined;
      if (registration.gatewayLeaveConfirmed && this.registration === registration) {
        this.removeAdapter(registration);
      }
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.registration !== undefined) this.removeAdapter(this.registration);
    this.pendingJoin?.reject(new Error("Discord Vox gateway bridge was disposed"));
    this.pendingLeave?.reject(new Error("Discord Vox gateway bridge was disposed"));
    this.pendingJoin = undefined;
    this.pendingLeave = undefined;
    for (const unsubscribe of this.unsubscribes) unsubscribe();
  }

  private register(guild: DiscordVoxGuild, channelId: string): void {
    if (this.registration !== undefined) this.removeAdapter(this.registration);
    let registration: AdapterRegistration;
    const callbacks: InternalDiscordGatewayAdapterLibraryMethods = {
      onVoiceServerUpdate: (data) => {
        if (this.registration !== registration) return;
        this.vox.updateVoiceServer({ endpoint: data.endpoint, token: data.token });
      },
      onVoiceStateUpdate: (data) => {
        if (this.registration !== registration) return;
        this.vox.updateVoiceState({
          session_id: data.session_id,
          user_id: data.user_id,
          channel_id: data.channel_id,
        });
        if (data.guild_id === registration.guildId && data.channel_id === null) {
          this.confirmGatewayLeave(registration);
        }
      },
      destroy: () => {
        if (this.registration !== registration) return;
        this.failAdapter(new Error(`Discord shard destroyed the voice adapter for guild ${guild.id}`));
      },
    };
    const adapter = guild.voiceAdapterCreator(callbacks);
    registration = { guildId: guild.id, channelId, adapter, gatewayLeaveConfirmed: false };
    this.registration = registration;
  }

  private handleVoxEvent(event: VoxControlEvent): void {
    if (event.type !== "adapter_send") return;
    const registration = this.registration;
    const payload = parseVoiceStatePayload(event.payload, registration);
    if (payload === undefined) {
      this.failAdapter(new Error("Vox emitted an invalid Discord OP4 voice-state payload"));
      return;
    }
    if (registration === undefined) {
      if (payload.d.channel_id !== null) {
        this.failAdapter(new Error("Vox emitted a Discord join without a registered guild adapter"));
      }
      return;
    }
    let sent = false;
    try {
      sent = registration.adapter.sendPayload(payload);
    } catch (error) {
      this.failAdapter(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (!sent) {
      this.failAdapter(
        new Error(`Discord shard refused the OP4 voice-state payload for guild ${registration.guildId}`),
      );
      return;
    }
  }

  private confirmGatewayLeave(registration: AdapterRegistration): void {
    if (registration.gatewayLeaveConfirmed) return;
    registration.gatewayLeaveConfirmed = true;
    if (this.pendingLeave !== undefined) {
      this.pendingLeave.resolve();
      return;
    }
    if (this.registration === registration) this.removeAdapter(registration);
    registration.externalLeaveFinalization = this.session
      .leave("discord_gateway_left")
      .then(() =>
        this.onLeaveConfirmed({
          guildId: registration.guildId,
          channelId: registration.channelId,
        }),
      )
      .then(() => undefined);
    void registration.externalLeaveFinalization.catch((error: unknown) => {
      this.onError(error instanceof Error ? error.message : String(error));
    });
  }

  private handleVoxStatus(status: VoxProcessStatus, detail: string): void {
    if (status !== "missing" && status !== "error" && status !== "closed") return;
    this.failAdapter(new Error(`Vox process became unavailable: ${detail}`), true);
  }

  private failAdapter(error: Error, sendFallbackLeave = false): void {
    this.onError(error.message);
    this.pendingJoin?.reject(error);
    this.pendingLeave?.reject(error);
    this.pendingJoin = undefined;
    this.pendingLeave = undefined;
    const registration = this.registration;
    if (registration !== undefined) {
      if (sendFallbackLeave) this.sendFallbackLeave(registration);
      if (this.registration === registration) this.removeAdapter(registration);
    }
    if (this.handlingFailure) return;
    this.handlingFailure = true;
    void this.session
      .leave("gateway_adapter_failed")
      .catch((leaveError: unknown) => {
        this.onError(
          `Discord voice session cleanup failed: ${leaveError instanceof Error ? leaveError.message : String(leaveError)}`,
        );
      })
      .finally(() => {
        this.handlingFailure = false;
      });
  }

  private sendFallbackLeave(registration: AdapterRegistration): void {
    const payload = parseVoiceStatePayload(
      {
        op: 4,
        d: {
          guild_id: registration.guildId,
          channel_id: null,
          self_mute: false,
          self_deaf: false,
        },
      },
      registration,
    );
    if (payload === undefined) {
      this.onError(`Discord rejected the fallback voice-state leave for guild ${registration.guildId}`);
      return;
    }
    try {
      if (!registration.adapter.sendPayload(payload)) {
        this.onError(
          `Discord shard refused the fallback OP4 voice-state leave for guild ${registration.guildId}`,
        );
      }
    } catch (error) {
      this.onError(
        `Discord fallback voice-state leave failed for guild ${registration.guildId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private removeAdapter(registration: AdapterRegistration): void {
    if (this.registration === registration) this.registration = undefined;
    registration.adapter.destroy();
  }
}

function parseVoiceStatePayload(
  value: unknown,
  registration: AdapterRegistration | undefined,
): VoiceStatePayload | undefined {
  if (!isRecord(value) || value.op !== 4 || !isRecord(value.d)) return undefined;
  const { guild_id: guildId, channel_id: channelId, self_mute: selfMute, self_deaf: selfDeaf } = value.d;
  if (typeof guildId !== "string" || !DISCORD_ID.test(guildId)) return undefined;
  if (channelId !== null && (typeof channelId !== "string" || !DISCORD_ID.test(channelId))) return undefined;
  if (typeof selfMute !== "boolean" || typeof selfDeaf !== "boolean") return undefined;
  if (registration !== undefined) {
    if (guildId !== registration.guildId) return undefined;
    if (channelId !== null && channelId !== registration.channelId) return undefined;
  }
  return {
    op: 4,
    d: { guild_id: guildId, channel_id: channelId, self_mute: selfMute, self_deaf: selfDeaf },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
