/**
 * Several wire schemas still carry a profile-hash slot from the retired policy
 * engine. One constant fills them all. User-session opt-in still compares
 * against it, so changing the constant re-asks for that consent; nothing else
 * branches on the value.
 */
export const PROFILE_HASH = "unversioned";

/** The key of one live Discord body in the core's live-session map. */
export function discordPresenceBindingKey(identity: {
  readonly transportKind: "bot" | "user_session";
  readonly characterId: string;
  readonly credentialRef: string;
}): string {
  return JSON.stringify([identity.transportKind, identity.characterId, identity.credentialRef]);
}
