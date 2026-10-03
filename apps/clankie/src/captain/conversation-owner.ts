import { z } from "zod";

/** Persisted host proof of the route that admitted this work, never tool input. */
export const DiscordWatchOriginSchema = z
  .object({
    baseSessionKey: z.string().min(1),
    targetId: z.string().min(1),
    actorId: z.string().min(1),
    guildId: z.string().min(1).optional(),
    channelId: z.string().min(1),
    messageId: z.string().min(1),
    transportKind: z.enum(["bot", "user_session"]),
  })
  .strict();
export type DiscordWatchOrigin = z.infer<typeof DiscordWatchOriginSchema>;

export const ConversationOwnerSchema = z
  .object({
    conversationId: z.string().min(1).max(256),
    discord: DiscordWatchOriginSchema.optional(),
  })
  .strict();
export type ConversationOwner = z.infer<typeof ConversationOwnerSchema>;

/** A live admitted turn. Persist only owner; refresh authority before each later wake. */
export interface ConversationAuthority {
  readonly owner: ConversationOwner;
  readonly current: () => boolean;
  readonly authorize: () => Promise<boolean>;
}

export function captureConversationAuthority(
  source: ConversationAuthority | undefined,
): ConversationAuthority {
  if (source === undefined) throw new Error("Turn conversation attribution is unavailable");
  const owner = ConversationOwnerSchema.parse(source.owner);
  if (owner.discord !== undefined) Object.freeze(owner.discord);
  return Object.freeze({ owner: Object.freeze(owner), current: source.current, authorize: source.authorize });
}

export async function assertConversationAuthority(source: ConversationAuthority): Promise<void> {
  if (!source.current() || !(await source.authorize()) || !source.current())
    throw new Error("Turn conversation authority is unavailable");
}
