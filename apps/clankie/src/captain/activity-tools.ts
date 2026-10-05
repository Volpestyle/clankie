import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ActivitySharingRequestSchema, type ActivitySharing } from "../activity-sharing.ts";
import { assertConversationAuthority, captureConversationAuthority } from "./conversation-owner.ts";
import type { TurnContext } from "./tools.ts";

/** Social sharing uses the current room/owner proof and delivered media; it grants no capture. */
export function activityTools(sharing: ActivitySharing, turn: TurnContext): ToolDefinition[] {
  return [
    defineTool({
      name: "activity_share",
      label: "Share a Discord Activity",
      description:
        "Share an existing source in a voice channel of your current server, or a server chosen by the operator. sourceId=play uses your live play producer; artifact:<conversationId>:<artifactId> uses a file delivered in this conversation (PNG, GIF, MP4, WAV or MP3). image takes artifactId for a delivered PNG. List shares, switch using the exact generation, or stop. Discord room sharing requires an official launch adapter; a refused outcome means nothing was shared. A launch receipt confirms an invite, not a person opening it. Uncertain receipts must be reconciled with list, never blindly resent. No URLs, paths, new capture or desktop authority.",
      parameters: Type.Object({
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
      }),
      execute: async (_id, input) => {
        let result: unknown;
        try {
          const authority = captureConversationAuthority(turn.conversationAuthority);
          await assertConversationAuthority(authority);
          if (authority.owner.discord?.transportKind === "user_session")
            throw new Error("activity_official_bot_required");
          const { action, sourceId, artifactId, guildId, channelId, shareId, generation, ttlMs } = input;
          if (
            authority.owner.discord &&
            (action === "start" || action === "image" || action === "switch") &&
            !sharing.hasLaunchAdapter
          )
            throw new Error("activity_official_bot_required");
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
              sessions: { shareId: string; scope: { guildId: string } }[];
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
              result = await sharing.request(parsed, authorize);
            }
          } else result = await sharing.request(parsed, authorize);
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
      },
    }),
  ];
}
