import { z } from "zod";
import {
  CeremonyDirectNotificationModeSchema,
  CeremonyNotificationSurfaceSchema,
  CeremonyTargetRoleSchema,
  type CeremonyDirectNotificationMode,
  type CeremonyNotificationSurface,
  type CeremonyTargetRole,
} from "@clankie/protocol";

/**
 * Provider-neutral capability an adapter may execute for attention delivery.
 * No Linear/user/label nouns here — those stay in Linear binding fixtures.
 */
export const AttentionCapabilityKindSchema = z.enum([
  "surface_notify",
  "direct_notify",
  "assign_principal",
  "comment_notify",
  "attention_marker",
]);
export type AttentionCapabilityKind = z.infer<typeof AttentionCapabilityKindSchema>;

export const AttentionCapabilitySchema = z
  .object({
    kind: AttentionCapabilityKindSchema,
    /** Opaque principal this capability targets (workspace config; not a provider noun). */
    principalId: z.string().min(1),
    surface: CeremonyNotificationSurfaceSchema.optional(),
  })
  .strict();
export type AttentionCapability = z.infer<typeof AttentionCapabilitySchema>;

export const WorkspaceRoleBindingSchema = z
  .object({
    principalId: z.string().min(1),
    capabilities: z.array(AttentionCapabilitySchema).min(1),
  })
  .strict();
export type WorkspaceRoleBinding = z.infer<typeof WorkspaceRoleBindingSchema>;

/**
 * Provider-neutral workspace binding from semantic target roles and notification
 * surfaces to opaque principals and adapter capabilities.
 */
export const WorkspaceTrackerBindingSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: z.string().min(1),
    /** Bumps whenever binding content changes; used in delivery idempotency fingerprints. */
    revision: z.string().min(1),
    // Partial map of semantic roles → bindings (not every CeremonyTargetRole is required).
    roles: z.record(z.string().min(1), WorkspaceRoleBindingSchema),
    fallbackRole: CeremonyTargetRoleSchema.optional(),
  })
  .strict();
export type WorkspaceTrackerBinding = z.infer<typeof WorkspaceTrackerBindingSchema>;

export interface ResolvedAttentionAction {
  readonly capability: AttentionCapability;
  readonly targetRole: CeremonyTargetRole;
  readonly surface?: CeremonyNotificationSurface;
  readonly directNotification: CeremonyDirectNotificationMode;
  readonly isFallback: boolean;
}

/**
 * Resolve the ordered list of provider-neutral actions for a request against a binding.
 * Does not perform I/O or claim delivery.
 */
export function resolveAttentionActions(input: {
  readonly binding: WorkspaceTrackerBinding;
  readonly targetRole: CeremonyTargetRole;
  readonly notificationSurfaces: readonly CeremonyNotificationSurface[];
  readonly directNotification: CeremonyDirectNotificationMode;
  readonly useFallback?: boolean;
}): { readonly actions: readonly ResolvedAttentionAction[]; readonly unsupported: boolean } {
  const binding = WorkspaceTrackerBindingSchema.parse(input.binding);
  const roleKey = input.useFallback === true ? (binding.fallbackRole ?? input.targetRole) : input.targetRole;
  if (!CeremonyTargetRoleSchema.safeParse(roleKey).success) {
    return { actions: [], unsupported: true };
  }
  const role = binding.roles[roleKey];
  if (role === undefined) {
    return { actions: [], unsupported: true };
  }

  const surfaces = new Set(input.notificationSurfaces);
  const actions: ResolvedAttentionAction[] = [];
  for (const capability of role.capabilities) {
    if (capability.kind === "surface_notify") {
      if (capability.surface !== undefined && !surfaces.has(capability.surface)) continue;
      if (capability.surface === undefined && surfaces.size === 0) continue;
    }
    if (capability.kind === "direct_notify" && input.directNotification === "disabled") continue;
    actions.push({
      capability,
      targetRole: roleKey,
      ...(capability.surface === undefined ? {} : { surface: capability.surface }),
      directNotification: input.directNotification,
      isFallback: input.useFallback === true && roleKey !== input.targetRole,
    });
  }

  if (actions.length === 0) return { actions: [], unsupported: true };
  return { actions, unsupported: false };
}

/** Stable fingerprint of binding revision + resolved actions for idempotency. */
export function bindingFingerprint(
  binding: WorkspaceTrackerBinding,
  actions: readonly ResolvedAttentionAction[],
): string {
  const payload = {
    workspaceId: binding.workspaceId,
    revision: binding.revision,
    actions: actions.map((action) => ({
      kind: action.capability.kind,
      principalId: action.capability.principalId,
      surface: action.surface ?? null,
      targetRole: action.targetRole,
      isFallback: action.isFallback,
    })),
  };
  return JSON.stringify(payload);
}
