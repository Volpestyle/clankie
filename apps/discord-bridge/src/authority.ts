export interface DiscordRoleBindings {
  readonly ambientRoleIds: ReadonlySet<string>;
  readonly approvalRoleIds: ReadonlySet<string>;
}

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

export function authorizeAmbientCommand(
  memberRoleIds: ReadonlySet<string>,
  bindings: DiscordRoleBindings,
): DiscordAuthorityDecision {
  if (intersects(memberRoleIds, bindings.ambientRoleIds)) return { allowed: true };
  return {
    allowed: false,
    code: "role_not_authorized",
    message:
      "Refused visibly: none of your Discord roles is mapped to the ambient command tier for this workspace.",
  };
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
