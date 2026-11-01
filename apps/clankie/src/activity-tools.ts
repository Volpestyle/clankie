import { randomUUID } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { ActivitySharingRequestSchema, type ActivitySharing } from "./activity-sharing.ts";
import { assertConversationAuthority, captureConversationAuthority } from "./captain/conversation-owner.ts";
import type { TurnContext } from "./captain/tools.ts";
import type { ActivityRoomLauncher } from "./ports/activity.ts";

const ActivityShareParameters = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("start"),
    Type.Literal("image"),
    Type.Literal("switch"),
    Type.Literal("stop"),
  ]),
  sourceId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  artifactId: Type.Optional(Type.String({ pattern: "^[a-f0-9]{48}$" })),
  guildId: Type.Optional(Type.String({ pattern: "^[0-9]{1,32}$" })),
  channelId: Type.Optional(Type.String({ pattern: "^[0-9]{1,32}$" })),
  shareId: Type.Optional(Type.String({ format: "uuid" })),
  generation: Type.Optional(Type.Integer({ minimum: 1 })),
  ttlMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 7_200_000 })),
});
type ActivityShareInput = Static<typeof ActivityShareParameters>;

/** Social sharing uses the current room/owner proof and delivered media; it grants no capture. */
export function activityTools(
  sharing: ActivitySharing,
  turn: TurnContext,
  launcher?: ActivityRoomLauncher,
): ToolDefinition[] {
  return [
    defineTool({
      name: "activity_share",
      label: "Share a Discord Activity",
      description:
        "Share an existing source in a voice channel of your current server, or a server chosen by the operator. sourceId=play uses your live play producer; artifact:<conversationId>:<artifactId> uses a file delivered in this conversation (PNG, GIF, MP4, WAV or MP3). image takes artifactId for a delivered PNG. List shares, switch using the exact generation, or stop. Discord room sharing requires an official launch adapter; a refused outcome means nothing was shared. A launch receipt confirms an invite, not a person opening it. Uncertain receipts must be reconciled with list, never blindly resent. No URLs, paths, new capture or desktop authority.",
      parameters: ActivityShareParameters,
      // A room launch posts its invite outside the sharing queue, so every room
      // operation runs whole, in order, across turns: a stop waits for a
      // pending launch, and no older launch can republish after it (VUH-2835).
      execute: (callId, input) =>
        launcher === undefined ? run(callId, input) : roomLifecycle(sharing, () => run(callId, input)),
    }),
  ];

  async function run(callId: string, input: ActivityShareInput) {
    let result: unknown;
    try {
      const authority = captureConversationAuthority(turn.conversationAuthority);
      await assertConversationAuthority(authority);
      if (authority.owner.discord?.transportKind === "user_session")
        throw new Error("activity_official_bot_required");
      const { action, sourceId, artifactId, guildId, shareId, generation, ttlMs } = input;
      let { channelId } = input;
      // Hosted launch wins; otherwise a self-hosted bot's own room launch.
      const roomLaunch = authority.owner.discord && !sharing.hasLaunchAdapter ? launcher : undefined;
      if (
        authority.owner.discord &&
        (action === "start" || action === "image" || action === "switch") &&
        !sharing.hasLaunchAdapter &&
        roomLaunch === undefined
      )
        throw new Error("activity_official_bot_required");
      if (roomLaunch !== undefined && (action === "start" || action === "image")) {
        // The invite goes where the bot is in voice, so the share must too.
        const voice = await roomLaunch.voiceChannel(authority.owner.discord!.guildId!);
        if (voice === undefined) throw new Error("activity_voice_channel_required");
        if (channelId !== undefined && channelId !== voice) throw new Error("activity_destination_refused");
        channelId = voice;
      }
      if (
        sourceId?.startsWith("artifact:") &&
        !sourceId.startsWith(`artifact:${authority.owner.conversationId}:`)
      )
        throw new Error("activity_artifact_unavailable");
      if (authority.owner.discord && guildId && guildId !== authority.owner.discord.guildId)
        throw new Error("activity_destination_refused");
      const request =
        action === "list"
          ? { action }
          : action === "stop"
            ? { action, shareId, generation }
            : action === "switch"
              ? {
                  action,
                  shareId,
                  generation,
                  ...(sourceId
                    ? { sourceId }
                    : { artifactId, conversationId: authority.owner.conversationId }),
                }
              : {
                  action,
                  ...(action === "start"
                    ? { sourceId }
                    : { artifactId, conversationId: authority.owner.conversationId }),
                  guildId: authority.owner.discord?.guildId ?? guildId,
                  channelId,
                  ...(ttlMs === undefined ? {} : { ttlMs }),
                };
      const parsed = ActivitySharingRequestSchema.parse(request);
      const authorize = async () => {
        try {
          await assertConversationAuthority(authority);
          return true;
        } catch {
          return false;
        }
      };
      // A social turn can only manipulate shares in its host-bound server.
      if (authority.owner.discord && (action === "switch" || action === "stop" || action === "list")) {
        const listed = (await sharing.request({ action: "list" }, authorize)) as {
          sessions: LaunchedSession[];
        };
        if (action === "list")
          result = {
            sessions: listed.sessions.filter(
              (session) => session.scope.guildId === authority.owner.discord!.guildId,
            ),
          };
        else {
          if (
            !listed.sessions.some(
              (session) =>
                session.shareId === shareId && session.scope.guildId === authority.owner.discord!.guildId,
            )
          )
            throw new Error("activity_destination_refused");
          const stopping = listed.sessions.find((session) => session.shareId === shareId);
          // Revoke first: a launch still in its body call must not land after this stop.
          let settled = true;
          if (roomLaunch !== undefined && action === "stop" && stopping !== undefined) {
            roomLaunch.revoke(stopping.scope.guildId, stopping.scope.channelId);
            // A revoked launch already inside its Discord effect cleans up after
            // itself; a stop only confirms once that has happened.
            settled = await roomLaunch.settle(stopping.scope.guildId, stopping.scope.channelId);
          }
          result = await sharing.request(parsed, authorize);
          if (roomLaunch !== undefined && action === "stop")
            result = {
              ...(result as object),
              receipt: await launchReceipt(roomLaunch, "watch_stop", callId, listed, shareId!, settled),
            };
        }
      } else {
        result = await sharing.request(parsed, authorize);
        if (roomLaunch !== undefined && (action === "start" || action === "image")) {
          const session = (result as { session: LaunchedSession }).session;
          roomLaunch.reserve(callId, session.scope.guildId, session.scope.channelId);
          const outcome = await roomLaunch.watch("watch_start", callId);
          // A refused launch posted nothing: end the share it would have shown.
          if (outcome === "refused")
            await sharing.request(
              { action: "stop", shareId: session.shareId, generation: session.generation },
              authorize,
            );
          result = { session, receipt: { outcome, receiptId: randomUUID(), session } };
        }
      }
    } catch (error) {
      result = {
        outcome: "refused",
        reason:
          error instanceof Error && error.message.startsWith("activity_")
            ? error.message
            : "activity_share_refused",
      };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
  }
}

const roomQueues = new WeakMap<ActivitySharing, Promise<unknown>>();

function roomLifecycle<T>(sharing: ActivitySharing, work: () => Promise<T>): Promise<T> {
  // allow-swallowed-rejection -- the earlier operation's own caller receives its failure; this one only waits its turn
  const run = (roomQueues.get(sharing) ?? Promise.resolve()).catch(() => undefined).then(work);
  roomQueues.set(
    sharing,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

interface LaunchedSession {
  shareId: string;
  generation: number;
  scope: { guildId: string; channelId: string };
}

async function launchReceipt(
  launcher: ActivityRoomLauncher,
  action: "watch_stop",
  callId: string,
  listed: { sessions: LaunchedSession[] },
  shareId: string,
  settled: boolean,
) {
  const session = listed.sessions.find((candidate) => candidate.shareId === shareId);
  const outcome = await launcher.watch(action, callId);
  // An older accepted launch may still be running: not a confirmed stop yet.
  return {
    outcome: outcome === "confirmed" && !settled ? "uncertain" : outcome,
    receiptId: randomUUID(),
    session,
  };
}
