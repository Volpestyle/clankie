import type { DiscordSettings } from "@clankie/settings";
import type { BodyConversationIdentity } from "./body-lease-router.ts";
import type { ConversationOwner } from "./captain/conversation-owner.ts";

export class MinecraftHostAuthorityError extends Error {
  readonly code = "minecraft_host_not_authorized";
  constructor() {
    super("minecraft_host_not_authorized");
  }
}

/** Authority belongs to the authenticated conversation, never an MCP argument. */
export function createMinecraftHostAuthority(options: {
  settings(): Promise<DiscordSettings>;
  routeAuthorized(owner: ConversationOwner): boolean | Promise<boolean>;
  /** Host proves this exact conversation is the operator console; gameplay is not an operator. */
  operatorAuthorized?(identity: BodyConversationIdentity): boolean | Promise<boolean>;
}): (
  identity: BodyConversationIdentity | undefined,
  permission: { readonly admin: boolean },
) => Promise<() => void> {
  return async (identity, permission) => {
    const refuse = () => {
      throw new MinecraftHostAuthorityError();
    };
    if (identity === undefined || !identity.current()) return refuse();
    const owner = identity.route?.owner;
    const origin = owner?.discord;
    if (owner !== undefined && owner.conversationId !== identity.conversationId) return refuse();
    if (origin === undefined) {
      if (!(await options.operatorAuthorized?.(identity)) || !identity.current()) return refuse();
    } else {
      if (!(await options.routeAuthorized(owner!)) || !identity.current()) return refuse();
      // A trusted guild deliberately grants every admitted member machine tools;
      // hosting admin remains the existing configured owner or individual operator.
      const settings = await options.settings();
      if (
        permission.admin &&
        origin.actorId !== settings.ownerUserId &&
        !settings.systemActorUserIds.includes(origin.actorId)
      )
        return refuse();
    }
    if (!identity.current()) return refuse();
    return () => {
      if (!identity.current()) refuse();
    };
  };
}
