export interface DiscordRoleBindings {
  readonly ambientRoleIds: ReadonlySet<string>;
  /**
   * Individual Discord user ids that hold the ambient tier regardless of role.
   * A single-operator deployment has nobody to hand a role to, and inventing a
   * role just to name one person is ceremony that drifts out of date the first
   * time the role is edited in the Discord UI.
   */
  readonly ambientUserIds: ReadonlySet<string>;
  readonly approvalRoleIds: ReadonlySet<string>;
}

/** Who is asking. Role membership alone cannot identify a specific operator. */
export interface DiscordCommandPrincipal {
  readonly userId: string;
  readonly roleIds: ReadonlySet<string>;
}

/**
 * Who may move Clankie in and out of a voice channel.
 *
 * `ambient` keeps voice behind the same binding as mission creation and
 * steering. `guild_members` opens it to every member of a guild that is already
 * on the deny-by-default voice allowlist.
 *
 * The split exists because the ambient tier was gating two very different blast
 * radii through one list. Creating a mission spawns workers that execute and
 * write code; summoning Clankie into a call spends speech budget and makes
 * noise. Forcing both through one allowlist means opening voice to a room also
 * opens code execution to it — so operators either lock voice down harder than
 * they want, or open execution wider than they meant. Neither is the intent
 * ADR 0045 encodes, and `guild_members` never widens anything but voice
 * presence: mission, steering, and memory commands stay on the ambient binding.
 */
export type DiscordVoiceJoinPolicy = "ambient" | "guild_members";

export type DiscordAuthorityDecision =
  | { allowed: true }
  | { allowed: false; code: "role_not_authorized" | "authenticated_surface_required"; message: string };
export type DiscordAuthorityRefusal = Extract<DiscordAuthorityDecision, { allowed: false }>;

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

export function refuseAmbientApproval(
  memberRoleIds: ReadonlySet<string>,
  bindings: DiscordRoleBindings,
  authenticatedSurfaceUrl: string,
  approvalId: string,
): DiscordAuthorityRefusal {
  if (!intersects(memberRoleIds, bindings.approvalRoleIds)) {
    return {
      allowed: false,
      code: "role_not_authorized",
      message:
        "Refused visibly: none of your Discord roles is mapped to receive approval handoffs for this workspace.",
    };
  }

  const destination = new URL(authenticatedSurfaceUrl);
  destination.searchParams.set("approval", approvalId);
  return {
    allowed: false,
    code: "authenticated_surface_required",
    message:
      `Refused on Discord: this is an ambient channel and cannot record approval decisions. ` +
      `Continue on the authenticated operator surface: ${destination.toString()}`,
  };
}

function intersects(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const value of left) if (right.has(value)) return true;
  return false;
}
