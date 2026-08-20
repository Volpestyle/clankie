import type { VoxClient, VoxControlEvent, VoxTransportRole } from "@clankie/vox-client";
import type { DiscordUserGateway } from "./gateway.ts";

const DISCORD_SNOWFLAKE = /^\d{1,20}$/u;
const MAX_SNOWFLAKE = (1n << 64n) - 1n;

interface VoiceTarget {
  readonly guildId: string;
  readonly channelId: string;
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

interface VoiceMembershipState {
  readonly target?: VoiceTarget;
  readonly audible: boolean;
}

interface PendingVoiceTransition {
  readonly kind: "join" | "leave";
  readonly guildId: string;
  readonly channelId?: string;
  readonly promise: Promise<boolean>;
  readonly resolve: (confirmed: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  attempted: boolean;
  expected?: VoiceMembershipState;
}

const VOICE_STATE_CONFIRM_TIMEOUT_MS = 10_000;

/** Keeps the account in one channel while Vox's three transport roles come and go independently. */
export class VoiceMembershipCoordinator {
  private readonly gateway: Pick<DiscordUserGateway, "sendPayload">;
  private readonly leases = new Map<VoxTransportRole, VoiceTarget>();
  private readonly actualChannels = new Map<string, { channelId: string; audible?: boolean }>();

  public constructor(gateway: Pick<DiscordUserGateway, "sendPayload">) {
    this.gateway = gateway;
  }

  public get target(): VoiceTarget | undefined {
    return this.leases.values().next().value as VoiceTarget | undefined;
  }

  public targetFor(role: VoxTransportRole): VoiceTarget | undefined {
    return this.leases.get(role);
  }

  public get actualTarget(): VoiceTarget | undefined {
    const desired = this.target;
    if (desired !== undefined && this.actualChannelFor(desired.guildId) === desired.channelId) {
      return desired;
    }
    const actual = this.actualChannels.entries().next().value as
      | [string, { channelId: string; audible?: boolean }]
      | undefined;
    return actual === undefined ? undefined : { guildId: actual[0], channelId: actual[1].channelId };
  }

  public get desiredState(): VoiceMembershipState {
    const target = this.target;
    return { ...(target === undefined ? {} : { target }), audible: this.leases.has("voice") };
  }

  public acquire(
    role: VoxTransportRole,
    guildId: string,
    channelId: string,
    payload?: VoiceStatePayload,
  ): boolean {
    if (!isDiscordSnowflake(guildId) || !isDiscordSnowflake(channelId)) return false;
    const target = this.target;
    if (target !== undefined && (target.guildId !== guildId || target.channelId !== channelId)) return false;
    const previous = this.leases.get(role);
    const wasAudible = this.leases.has("voice");
    const audible = wasAudible || role === "voice";
    const actual = this.actualChannels.get(guildId);
    const actualChannelId = this.actualChannelFor(guildId);
    const alreadyDesired =
      actualChannelId === channelId && (actual?.audible === undefined || actual.audible === audible);
    const sameLease = previous?.guildId === guildId && previous.channelId === channelId;
    if (sameLease && alreadyDesired) return true;
    if (!alreadyDesired && !this.send(payload ?? voiceStatePayload(guildId, channelId, audible))) {
      return false;
    }
    this.leases.set(role, { guildId, channelId });
    return true;
  }

  public release(role: VoxTransportRole, guildId?: string, payload?: VoiceStatePayload): boolean {
    const lease = this.leases.get(role);
    if (lease === undefined) return true;
    if (guildId !== undefined && lease.guildId !== guildId) return false;

    const wasAudible = this.leases.has("voice");
    const remaining = [...this.leases.entries()].filter(([candidate]) => candidate !== role);
    const target = remaining[0]?.[1];
    const audible = remaining.some(([candidate]) => candidate === "voice");
    if (target !== undefined && wasAudible === audible) {
      this.leases.delete(role);
      return true;
    }
    if (
      !this.send(
        target === undefined
          ? (payload ?? voiceStatePayload(lease.guildId, null, false))
          : voiceStatePayload(target.guildId, target.channelId, audible),
      )
    ) {
      return false;
    }
    this.leases.delete(role);
    return true;
  }

  /** Discord self state is authoritative; stale desired leases never survive a mismatch. */
  public reconcileSelfVoiceState(guildId: string, channelId: string | null, audible?: boolean): boolean {
    if (channelId === null) this.actualChannels.delete(guildId);
    else this.actualChannels.set(guildId, { channelId, ...(audible === undefined ? {} : { audible }) });
    const target = this.target;
    if (target === undefined) return false;
    if (target.guildId === guildId && target.channelId === channelId) return false;
    if (target.guildId !== guildId && channelId === null) return false;
    this.leases.clear();
    return true;
  }

  public invalidateActualState(): void {
    this.actualChannels.clear();
  }

  /** Retries a desired transition when Vox emitted no adapter payload or a prior send timed out. */
  public ensureDesiredState(guildId: string): boolean {
    const desired = this.desiredState;
    if (desired.target !== undefined && desired.target.guildId !== guildId) return false;
    const actual = this.actualChannels.get(guildId);
    const actualChannelId = this.actualChannelFor(guildId);
    if (desired.target === undefined) {
      if (actualChannelId === undefined) return true;
      return this.send(voiceStatePayload(guildId, null, false));
    }
    if (
      actualChannelId === desired.target.channelId &&
      (actual?.audible === undefined || actual.audible === desired.audible)
    ) {
      return true;
    }
    return this.send(voiceStatePayload(desired.target.guildId, desired.target.channelId, desired.audible));
  }

  public matches(state: VoiceMembershipState, guildId: string): boolean {
    const actual = this.actualChannels.get(guildId);
    if (state.target === undefined)
      return actual === undefined && this.actualChannelFor(guildId) === undefined;
    return (
      state.target.guildId === guildId &&
      this.actualChannelFor(guildId) === state.target.channelId &&
      (actual?.audible === undefined || actual.audible === state.audible)
    );
  }

  private actualChannelFor(guildId: string): string | undefined {
    return this.actualChannels.get(guildId)?.channelId;
  }

  private send(payload: VoiceStatePayload): boolean {
    try {
      return this.gateway.sendPayload(payload);
    } catch {
      return false;
    }
  }
}

/** Structural gateway bridge for the sole Vox child; it owns listeners, not Vox or the gateway. */
export class VoxGatewayBridge {
  private readonly unsubscribes: (() => void)[];
  private readonly allowlisted: (guildId: string, channelId: string) => boolean;
  private readonly membership: VoiceMembershipCoordinator;
  private readonly voiceStateTimeoutMs: number;
  private activeVoiceTarget: VoiceTarget | undefined;
  private pendingVoiceTarget: VoiceTarget | undefined;
  private transition: PendingVoiceTransition | undefined;
  private disposed = false;

  public constructor(options: {
    readonly gateway: DiscordUserGateway;
    readonly vox: VoxClient;
    readonly membership: VoiceMembershipCoordinator;
    readonly allowlisted: (guildId: string, channelId: string) => boolean;
    readonly onRejected?: (reason: string) => void;
    readonly voiceStateTimeoutMs?: number;
  }) {
    const reject = options.onRejected ?? (() => undefined);
    this.allowlisted = options.allowlisted;
    this.membership = options.membership;
    this.voiceStateTimeoutMs = options.voiceStateTimeoutMs ?? VOICE_STATE_CONFIRM_TIMEOUT_MS;
    this.unsubscribes = [
      options.vox.onEvent((event) => {
        if (this.disposed) return;
        if (event.type !== "adapter_send") return;
        const raw = record(event.payload);
        const channelId = record(raw?.d)?.channel_id;
        const expected =
          channelId === null
            ? this.activeVoiceTarget
            : [this.pendingVoiceTarget, this.activeVoiceTarget].find(
                (target) => target?.channelId === channelId,
              );
        if (expected === undefined) {
          reject("unexpected_adapter_send");
          return;
        }
        const payload = parseVoiceStatePayload(event, expected);
        if (payload === undefined) return reject("invalid_adapter_send");
        if (!this.allowlisted(payload.d.guild_id, expected.channelId)) {
          reject("voice_target_not_allowlisted");
          return;
        }
        if (payload.d.channel_id === null) {
          if (!options.membership.release("voice", payload.d.guild_id, payload)) {
            reject("membership_send_failed");
            this.failTransition("leave", payload.d.guild_id);
            return;
          }
          this.noteTransitionAttempt("leave", payload.d.guild_id);
          return;
        }
        if (!options.membership.acquire("voice", payload.d.guild_id, payload.d.channel_id, payload)) {
          reject("membership_conflict");
          this.failTransition("join", payload.d.guild_id, payload.d.channel_id);
          this.pendingVoiceTarget = undefined;
          options.vox.updateVoiceState({ channel_id: null });
          return;
        }
        this.noteTransitionAttempt("join", payload.d.guild_id, payload.d.channel_id);
      }),
      options.gateway.on("voiceServerUpdate", (server) => {
        if (this.disposed) return;
        const target = this.pendingVoiceTarget ?? this.activeVoiceTarget;
        if (server.guildId !== target?.guildId) {
          reject("unrelated_voice_server_update");
          return;
        }
        options.vox.updateVoiceServer({ endpoint: server.endpoint, token: server.token });
      }),
      options.gateway.on("voiceStateUpdate", (state) => {
        if (this.disposed) return;
        if (state.userId !== options.gateway.userId || state.guildId === undefined) {
          reject("unrelated_voice_state_update");
          return;
        }
        const sessionId = nullableString(state.raw.session_id);
        const userId = nullableString(state.raw.user_id);
        const channelId = nullableString(state.raw.channel_id);
        if (channelId === undefined) {
          reject("invalid_voice_state_update");
          return;
        }
        const target = this.pendingVoiceTarget ?? this.activeVoiceTarget;
        const targetMatches =
          target !== undefined && state.guildId === target.guildId && channelId === target.channelId;
        const audible =
          typeof state.raw.self_mute === "boolean" && typeof state.raw.self_deaf === "boolean"
            ? !state.raw.self_mute && !state.raw.self_deaf
            : undefined;
        options.membership.reconcileSelfVoiceState(state.guildId, channelId, audible);
        const voiceLease = options.membership.targetFor("voice");
        const voiceTargetMatches =
          targetMatches && voiceLease?.guildId === state.guildId && voiceLease.channelId === channelId;
        if (channelId === null) {
          if (this.activeVoiceTarget?.guildId === state.guildId) this.activeVoiceTarget = undefined;
          if (this.pendingVoiceTarget?.guildId === state.guildId) this.pendingVoiceTarget = undefined;
          if (target === undefined || state.guildId !== target.guildId) {
            reject("unrelated_voice_state_update");
          }
        } else if (voiceTargetMatches) {
          this.activeVoiceTarget = target;
          if (this.pendingVoiceTarget === target) this.pendingVoiceTarget = undefined;
        } else {
          this.activeVoiceTarget = undefined;
          this.pendingVoiceTarget = undefined;
          if (target === undefined || state.guildId !== target.guildId) {
            reject("unrelated_voice_state_update");
          }
        }
        options.vox.updateVoiceState({
          ...(sessionId === undefined ? {} : { session_id: sessionId }),
          ...(userId === undefined ? {} : { user_id: userId }),
          channel_id: voiceTargetMatches ? channelId : null,
        });
        this.confirmTransition(state.guildId, channelId);
      }),
      options.gateway.on("ready", () => options.membership.invalidateActualState()),
      options.gateway.on("reconnecting", () => options.membership.invalidateActualState()),
      options.gateway.on("disconnected", () => options.membership.invalidateActualState()),
    ];
  }

  public confirmVoiceJoin(
    guildId: string,
    channelId: string,
    operation: () => Promise<unknown>,
  ): Promise<boolean> {
    return this.confirmVoiceTransition("join", guildId, channelId, operation);
  }

  public confirmVoiceLeave(guildId: string, operation: () => Promise<unknown>): Promise<boolean> {
    return this.confirmVoiceTransition("leave", guildId, undefined, operation);
  }

  public prepareVoiceTarget(guildId: string, channelId: string): boolean {
    if (
      this.disposed ||
      !isDiscordSnowflake(guildId) ||
      !isDiscordSnowflake(channelId) ||
      !this.allowlisted(guildId, channelId)
    ) {
      return false;
    }
    for (const role of ["stream_watch", "stream_publish"] as const) {
      const target = this.membership.targetFor(role);
      if (target !== undefined && (target.guildId !== guildId || target.channelId !== channelId))
        return false;
    }
    const voiceLease = this.membership.targetFor("voice");
    if (
      voiceLease !== undefined &&
      (voiceLease.guildId !== guildId || voiceLease.channelId !== channelId) &&
      (this.activeVoiceTarget?.guildId !== voiceLease.guildId ||
        this.activeVoiceTarget.channelId !== voiceLease.channelId)
    ) {
      return false;
    }
    if (
      this.pendingVoiceTarget !== undefined &&
      (this.pendingVoiceTarget.guildId !== guildId || this.pendingVoiceTarget.channelId !== channelId)
    ) {
      return false;
    }
    this.pendingVoiceTarget = { guildId, channelId };
    return true;
  }

  public cancelPendingVoiceTarget(guildId: string, channelId: string): void {
    if (this.pendingVoiceTarget?.guildId === guildId && this.pendingVoiceTarget.channelId === channelId) {
      this.pendingVoiceTarget = undefined;
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.settleTransition(false);
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    this.pendingVoiceTarget = undefined;
    this.activeVoiceTarget = undefined;
  }

  private async confirmVoiceTransition(
    kind: "join" | "leave",
    guildId: string,
    channelId: string | undefined,
    operation: () => Promise<unknown>,
  ): Promise<boolean> {
    if (this.disposed || this.transition !== undefined) return false;
    let resolve!: (confirmed: boolean) => void;
    const promise = new Promise<boolean>((settle) => {
      resolve = settle;
    });
    const transition: PendingVoiceTransition = {
      kind,
      guildId,
      ...(channelId === undefined ? {} : { channelId }),
      promise,
      resolve,
      timer: setTimeout(() => this.settleTransition(false), this.voiceStateTimeoutMs),
      attempted: false,
    };
    transition.timer.unref();
    this.transition = transition;
    try {
      await operation();
    } catch {
      this.settleTransition(false);
      return false;
    }
    if (this.transition === transition && !transition.attempted) {
      transition.attempted = true;
      const updated =
        kind === "leave"
          ? this.membership.release("voice", guildId)
          : channelId !== undefined && this.membership.acquire("voice", guildId, channelId);
      if (!updated) {
        this.settleTransition(false);
        return promise;
      }
      transition.expected = this.membership.desiredState;
      if (!this.membership.ensureDesiredState(guildId)) this.settleTransition(false);
      else if (this.membership.matches(transition.expected, guildId)) this.settleTransition(true);
    }
    return promise;
  }

  private noteTransitionAttempt(kind: "join" | "leave", guildId: string, channelId?: string): void {
    const transition = this.transition;
    if (
      transition === undefined ||
      transition.kind !== kind ||
      transition.guildId !== guildId ||
      (kind === "join" && transition.channelId !== channelId)
    ) {
      return;
    }
    transition.attempted = true;
    transition.expected = this.membership.desiredState;
    if (this.membership.matches(transition.expected, guildId)) this.settleTransition(true);
  }

  private failTransition(kind: "join" | "leave", guildId: string, channelId?: string): void {
    const transition = this.transition;
    if (
      transition?.kind === kind &&
      transition.guildId === guildId &&
      (kind === "leave" || transition.channelId === channelId)
    ) {
      this.settleTransition(false);
    }
  }

  private confirmTransition(guildId: string, channelId: string | null): void {
    const transition = this.transition;
    if (transition === undefined || !transition.attempted || transition.guildId !== guildId) return;
    if (transition.expected !== undefined && this.membership.matches(transition.expected, guildId)) {
      this.settleTransition(true);
      return;
    }
    if (channelId === null || transition.kind === "join") this.settleTransition(false);
  }

  private settleTransition(confirmed: boolean): void {
    const transition = this.transition;
    if (transition === undefined) return;
    this.transition = undefined;
    clearTimeout(transition.timer);
    transition.resolve(confirmed);
  }
}

function voiceStatePayload(guildId: string, channelId: string | null, audible: boolean): VoiceStatePayload {
  return {
    op: 4,
    d: {
      guild_id: guildId,
      channel_id: channelId,
      self_mute: !audible,
      self_deaf: !audible,
    },
  };
}

function parseVoiceStatePayload(
  event: Extract<VoxControlEvent, { type: "adapter_send" }>,
  expected: VoiceTarget | undefined,
): VoiceStatePayload | undefined {
  const payload = record(event.payload);
  const data = record(payload?.d);
  if (
    expected === undefined ||
    !hasExactKeys(payload, ["op", "d"]) ||
    !hasExactKeys(data, ["guild_id", "channel_id", "self_mute", "self_deaf"]) ||
    payload?.op !== 4 ||
    typeof data?.guild_id !== "string" ||
    !isDiscordSnowflake(data.guild_id) ||
    (typeof data.channel_id !== "string" && data.channel_id !== null) ||
    (typeof data.channel_id === "string" && !isDiscordSnowflake(data.channel_id)) ||
    typeof data.self_mute !== "boolean" ||
    typeof data.self_deaf !== "boolean" ||
    data.guild_id !== expected.guildId ||
    (data.channel_id !== null && data.channel_id !== expected.channelId)
  ) {
    return undefined;
  }
  if (data.channel_id !== null && (data.self_mute || data.self_deaf)) return undefined;
  return {
    op: 4,
    d: {
      guild_id: data.guild_id,
      channel_id: data.channel_id,
      self_mute: data.self_mute,
      self_deaf: data.self_deaf,
    },
  };
}

function hasExactKeys(value: Record<string, unknown> | undefined, keys: readonly string[]): boolean {
  if (value === undefined) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isDiscordSnowflake(value: string): boolean {
  if (!DISCORD_SNOWFLAKE.test(value)) return false;
  const snowflake = BigInt(value);
  return snowflake > 0n && snowflake <= MAX_SNOWFLAKE;
}

function nullableString(value: unknown): string | null | undefined {
  return typeof value === "string" || value === null ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
