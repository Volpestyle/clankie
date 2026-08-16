export interface DiscordRoleBindings {
  readonly ambientRoleIds: ReadonlySet<string>;
  /**
   * Individual Discord user ids that hold the ambient tier regardless of role.
   * A single-operator deployment has nobody to hand a role to, and inventing a
   * role just to name one person is ceremony that drifts out of date the first
   * time the role is edited in the Discord UI.
   */
  readonly ambientUserIds: ReadonlySet<string>;
}

/** Who is asking. Role membership alone cannot identify a specific operator. */
export interface DiscordCommandPrincipal {
  readonly userId: string;
  readonly roleIds: ReadonlySet<string>;
}

/**
 * Who may move Clankie in and out of a voice channel.
 *
 * `ambient` keeps voice behind the same role binding as the other ambient
 * commands. `guild_members` opens it to every member of a guild that is
 * already on the deny-by-default voice allowlist, and never widens anything
 * but voice presence: person-memory commands stay on the ambient binding.
 */
export type DiscordVoiceJoinPolicy = "ambient" | "guild_members";

export type DiscordAuthorityDecision =
  | { allowed: true }
  | { allowed: false; code: "role_not_authorized"; message: string };

export function parseRoleIds(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((roleId) => roleId.trim())
      .filter((roleId) => roleId.length > 0),
  );
}

/** Unknown or absent values fall back to the closed policy, never the open one. */
export function parseDiscordVoiceJoinPolicy(value: string | undefined): DiscordVoiceJoinPolicy {
  return value?.trim() === "guild_members" ? "guild_members" : "ambient";
}

export function authorizeAmbientCommand(
  principal: DiscordCommandPrincipal,
  bindings: DiscordRoleBindings,
): DiscordAuthorityDecision {
  if (bindings.ambientUserIds.has(principal.userId)) return { allowed: true };
  if (intersects(principal.roleIds, bindings.ambientRoleIds)) return { allowed: true };
  return {
    allowed: false,
    code: "role_not_authorized",
    message:
      "Refused visibly: none of your Discord roles is mapped to the ambient command tier for this workspace.",
  };
}

/**
 * Authorize `/clankie join` and `/clankie leave`.
 *
 * The caller must still check the guild allowlist. This decides *who* inside an
 * already-allowlisted guild may move Clankie between calls; it never decides
 * *which* guild, so an open policy cannot reach a server the owner did not
 * choose.
 */
export function authorizeVoicePresenceCommand(
  principal: DiscordCommandPrincipal,
  bindings: DiscordRoleBindings,
  policy: DiscordVoiceJoinPolicy,
): DiscordAuthorityDecision {
  if (policy === "guild_members") return { allowed: true };
  return authorizeAmbientCommand(principal, bindings);
}

function intersects(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const value of left) if (right.has(value)) return true;
  return false;
}
