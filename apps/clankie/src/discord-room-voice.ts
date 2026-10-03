import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  BodyVoiceTargetSchema,
  DiscordVoicePresenceResultSchema,
  DiscordRoomVoiceStatusSchema,
  type DiscordRoomVoiceStatus,
} from "@clankie/protocol";
import type { BodyVoiceStays } from "./body-voice-stays.ts";
import type { BodyLeaseStore } from "./body-leases.ts";
import type { RoomAuthorization } from "./discord-room-routes.ts";
import { postToDiscordActiveBody } from "./discord-active-body.ts";
const Snapshot = z.object({
  active: z.boolean(),
  stayId: z.string().optional(),
  guildId: z.string().optional(),
  channelId: z.string().optional(),
  outputMuted: z.boolean(),
  activity: z.enum(["speaking", "listening", "thinking", "idle", "unknown"]),
  outputControlUncertain: z.boolean().optional(),
  consentedParticipantCount: z.number(),
  activeCaptureCount: z.number(),
  handoffCount: z.number(),
  speakers: DiscordRoomVoiceStatusSchema.shape.speakers,
});
/** Ephemeral operation guards, not a second lease or reconstructed room authority. */
export class DiscordRoomVoice {
  private readonly pending = new Map<
    string,
    {
      stayId: string;
      action: "mute_output" | "unmute_output" | "leave";
      expiresAt: number;
      guard: () => Promise<void>;
    }
  >();
  private readonly stays: BodyVoiceStays;
  private readonly leases: BodyLeaseStore;
  private readonly post: (path: string, body: unknown) => Promise<Response>;
  constructor(
    stays: BodyVoiceStays,
    leases: BodyLeaseStore,
    post = (path: string, body: unknown) => postToDiscordActiveBody(path, body, process.env, fetch),
  ) {
    this.stays = stays;
    this.leases = leases;
    this.post = post;
  }
  async status(): Promise<DiscordRoomVoiceStatus> {
    const response = await this.post("/voice/status", {});
    if (!response.ok) throw Error("voice_unavailable");
    const snapshot = Snapshot.parse(await response.json());
    const lease = this.leases.status("voice");
    const { active, outputControlUncertain, speakers, ...details } = snapshot;
    const exact =
      active && lease?.state === "active" && this.stays.observesActiveAudio(lease.conversationId, snapshot);
    return DiscordRoomVoiceStatusSchema.parse({
      state: outputControlUncertain
        ? "unknown"
        : active
          ? exact
            ? "active"
            : "unknown"
          : lease === undefined
            ? "idle"
            : "unknown",
      ...(lease === undefined ? {} : { conversationId: lease.conversationId }),
      ...details,
      ...(exact && speakers !== undefined ? { speakers } : {}),
    });
  }
  async join(
    conversationId: string,
    targetId: string,
    actorId: string,
    authority: RoomAuthorization,
  ): Promise<DiscordRoomVoiceStatus> {
    const [guildId, channelId] = targetId.split(":");
    if (!guildId || !channelId || guildId === "dm") throw Error("voice_target_required");
    const resolved = await this.post("/voice/resolve", { guildId, actorId });
    if (!resolved.ok) throw Error("voice_target_unavailable");
    const target = BodyVoiceTargetSchema.parse(await resolved.json());
    if (target.guildId !== guildId || target.channelId !== channelId || target.actorId !== actorId)
      throw Error("voice_target_changed");
    const identity = {
      conversationId,
      current: authority.current,
      authorize: async () => {
        try {
          await authority.guard();
          return authority.current();
        } catch {
          return false;
        }
      },
    };
    const issued = await this.stays.ticket(identity, target);
    if (!("ticket" in issued)) throw Error("voice_lease_refused");
    await authority.guard();
    if (!authority.current()) throw Error("voice_operator_revoked");
    const response = await this.post("/voice/join", { guildId, actorId, bodyLeaseTicket: issued.ticket });
    if (!response.ok) throw Error("voice_join_refused");
    const result = DiscordVoicePresenceResultSchema.parse(await response.json());
    if (result.action !== "joined") throw Error("voice_join_refused");
    const status = await this.status();
    await authority.guard();
    if (!authority.current()) throw Error("voice_operator_revoked");
    return status;
  }
  async control(
    conversationId: string,
    stayId: string,
    action: "mute_output" | "unmute_output" | "leave",
    authority: RoomAuthorization,
  ): Promise<DiscordRoomVoiceStatus> {
    const guard = async () => {
      await this.stays.controlGuard(
        conversationId,
        stayId,
        async () => {
          await authority.guard();
          if (!authority.current()) throw Error("voice_operator_revoked");
        },
        authority.current,
      );
    };
    await guard();
    for (const [id, entry] of this.pending) if (entry.expiresAt <= Date.now()) this.pending.delete(id);
    if (this.pending.size >= 64) throw Error("voice_control_busy");
    const nonce = randomUUID();
    this.pending.set(nonce, { stayId, action, expiresAt: Date.now() + 15_000, guard });
    try {
      const response = await this.post("/voice/output", { nonce, stayId, action });
      if (!response.ok) throw Error("voice_control_refused");
      await authority.guard();
      if (!authority.current()) throw Error("voice_operator_revoked");
      const status = await this.status();
      await authority.guard();
      if (!authority.current()) throw Error("voice_operator_revoked");
      return status;
    } finally {
      this.pending.delete(nonce);
    }
  }
  async authorize(command: {
    nonce: string;
    stayId: string;
    action: "mute_output" | "unmute_output" | "leave";
  }): Promise<void> {
    const entry = this.pending.get(command.nonce);
    if (
      !entry ||
      entry.expiresAt <= Date.now() ||
      entry.stayId !== command.stayId ||
      entry.action !== command.action
    )
      throw Error("voice_control_unknown");
    this.pending.delete(command.nonce); // One final command only, even when a callback is repeated concurrently.
    await entry.guard();
    if (entry.expiresAt <= Date.now()) throw Error("voice_control_expired");
  }
}
