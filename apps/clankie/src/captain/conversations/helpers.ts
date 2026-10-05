import {
  OPERATOR_CONVERSATION_SUMMARY_MAX,
  type OperatorChannel,
  type OperatorChannelMember,
  type OperatorConversation,
  type OperatorConversationEventBody,
  type OperatorConversationScope,
} from "@clankie/protocol";
import { readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { HerdrTranscriptEntry } from "../herdr-transcript.ts";
import { type ConversationMeta } from "./types.ts";

/**
 * A workspace scope names the directory the conversation's session works in.
 * That directory becomes the cwd of an unsandboxed shell, so the registry
 * refuses anything but an absolute path that already resolves to a directory —
 * a conversation is never created pointing at a path the caller invented.
 */
export function workspaceOf(scope: OperatorConversationScope): string | undefined {
  if (scope.kind !== "workspace") return undefined;
  const workspace = scope.workspaceId;
  if (!isAbsolute(workspace)) {
    throw new Error(`Workspace ${workspace} is not an absolute path`);
  }
  return workspace;
}

export function messageKey(role: "operator" | "agent", text: string): string {
  return `${role}\u0000${text}`;
}

export function transcriptImageKey(meta: ConversationMeta, sessionKey: string, entryId: string): string {
  return `${meta.conversationId}\u0000${sessionKey}\u0000${entryId}`;
}

export function transcriptEventBody(
  entry: Exclude<HerdrTranscriptEntry, { readonly type: "viewed_image" }>,
  agentRole: "agent" | "captain",
): OperatorConversationEventBody {
  if (entry.type === "message") {
    return {
      type: "message",
      role: entry.role === "agent" ? agentRole : entry.role,
      text: entry.text,
      streaming: false,
    };
  }
  return {
    type: "tool",
    toolCallId: entry.toolCallId,
    name: entry.name,
    phase: entry.phase,
    ...(entry.detail === undefined ? {} : { detail: entry.detail }),
  };
}

/**
 * The failure in words, cause chain included — an API rejection routinely puts
 * the only useful detail on `cause`, not on the outer error's own message.
 */
export function turnFailureSummary(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    const text = current instanceof Error ? current.message.trim() : String(current).trim();
    if (text.length > 0 && parts[parts.length - 1] !== text) parts.push(text);
    current = current instanceof Error ? current.cause : undefined;
  }
  const summary = parts.join(": ");
  if (summary.length === 0) return "Turn failed with no error message.";
  return summary.length > OPERATOR_CONVERSATION_SUMMARY_MAX
    ? `${summary.slice(0, OPERATOR_CONVERSATION_SUMMARY_MAX - 1)}\u2026`
    : summary;
}

export function directoryBytes(path: string): number {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return 0;
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path, { withFileTypes: true }).reduce(
    (total, entry) => total + (entry.isSymbolicLink() ? 0 : directoryBytes(join(path, entry.name))),
    0,
  );
}

export function sameScope(a: OperatorConversationScope, b: OperatorConversationScope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "room" && b.kind === "room") return a.lane === b.lane && a.targetId === b.targetId;
  if (a.kind === "workspace" && b.kind === "workspace") return a.workspaceId === b.workspaceId;
  if (a.kind === "persona" && b.kind === "persona") return a.personaId === b.personaId;
  if (a.kind === "seat" && b.kind === "seat") return a.seatId === b.seatId;
  if (a.kind === "channel" && b.kind === "channel") return a.channelId === b.channelId;
  return true;
}

export function publicChannel(meta: ConversationMeta): OperatorChannel {
  if (meta.scope.kind !== "channel") {
    throw new Error(`Conversation ${meta.conversationId} is not a channel`);
  }
  return {
    schemaVersion: 1,
    channelId: meta.scope.channelId,
    conversationId: meta.conversationId,
    title: meta.title,
    members: (meta.channelMembers ?? []).map((member) => ({
      personaId: channelMemberPersonaId(member),
      position: member.position,
      joinedAt: member.joinedAt,
    })),
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    ...(meta.channelDiscord === undefined
      ? {}
      : {
          discord: {
            guildId: meta.channelDiscord.guildId,
            channelId: meta.channelDiscord.channelId,
            ...(meta.channelDiscord.threadId === undefined ? {} : { threadId: meta.channelDiscord.threadId }),
            webhookId: meta.channelDiscord.webhookId,
          },
        }),
  };
}

/** Reads pre-ADR-0147 channel records without keeping seat identity in the public model. */
export function channelMemberPersonaId(member: OperatorChannelMember): string {
  return member.personaId ?? (member as OperatorChannelMember & { readonly seatId: string }).seatId;
}

export function publicConversation(meta: ConversationMeta): OperatorConversation {
  return {
    schemaVersion: 1,
    conversationId: meta.conversationId,
    scope: meta.scope,
    title: meta.title,
    isDefault: meta.isDefault,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    sessionState: meta.sessionState,
    revision: meta.revision,
    ...(meta.designatedHeadConversationId === undefined
      ? {}
      : { designatedHeadConversationId: meta.designatedHeadConversationId }),
    ...(meta.contextUsage === undefined ? {} : { contextUsage: meta.contextUsage }),
    ...(meta.parentConversationId === undefined ? {} : { parentConversationId: meta.parentConversationId }),
  };
}
