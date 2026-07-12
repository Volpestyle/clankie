import type { CaptainCeremonyProjection } from "@clankie/doctrine";

/**
 * Structural check that a candidate projection matches a trusted compiled projection
 * for security-sensitive ceremony controls. Arbitrary metadata that disables draft
 * validation, human attention, or independent verification is rejected.
 */
export function isTrustedCeremonyProjection(
  candidate: CaptainCeremonyProjection,
  trusted: CaptainCeremonyProjection,
): boolean {
  return (
    candidate.profileId === trusted.profileId &&
    candidate.profileHash === trusted.profileHash &&
    candidate.issueDraft.enabled === trusted.issueDraft.enabled &&
    candidate.issueDraft.requireProductImpact === trusted.issueDraft.requireProductImpact &&
    candidate.humanAttention.enabled === trusted.humanAttention.enabled &&
    candidate.independentVerifierRequired === trusted.independentVerifierRequired &&
    candidate.externalConnectors === trusted.externalConnectors &&
    candidate.integrationFlow === trusted.integrationFlow
  );
}

/**
 * Extract a ceremony projection object from Eve channel metadata.
 * Shape-only: callers must validate against a trusted compiled projection.
 */
export function ceremonyProjectionFromChannel(channel: {
  readonly metadata?: Readonly<Record<string, unknown>>;
}): CaptainCeremonyProjection | undefined {
  const raw = channel.metadata?.ceremonyProjection;
  if (raw === null || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.profileId !== "string" || typeof record.profileHash !== "string") {
    return undefined;
  }
  if (record.issueDraft === null || typeof record.issueDraft !== "object") return undefined;
  if (record.humanAttention === null || typeof record.humanAttention !== "object") return undefined;
  return raw as CaptainCeremonyProjection;
}

/**
 * Resolve the projection used for captain prompt composition.
 * Prefer trusted compiled doctrine. Channel metadata is accepted only when it
 * matches the trusted projection; mismatched/untrusted projections are rejected.
 */
export function resolveTrustedCeremonyProjection(
  channel: { readonly metadata?: Readonly<Record<string, unknown>> },
  trusted: CaptainCeremonyProjection,
): { readonly projection: CaptainCeremonyProjection } | { readonly rejected: true; readonly reason: string } {
  const fromChannel = ceremonyProjectionFromChannel(channel);
  if (fromChannel === undefined) {
    return { projection: trusted };
  }
  if (!isTrustedCeremonyProjection(fromChannel, trusted)) {
    return { rejected: true, reason: "untrusted_ceremony_projection" };
  }
  // Always use the trusted compiled object, never the untrusted channel copy.
  return { projection: trusted };
}

/**
 * Captain-owned markdown renderer over a trusted CaptainCeremonyProjection.
 * Lives in captain-eve (not tracker-connector): connector owns validation/delivery;
 * captain owns prompt composition (VUH-844 / ADR 0028 boundary).
 */
export function formatCeremonyInstructions(projection: CaptainCeremonyProjection): string {
  const draft = projection.issueDraft;
  const attention = projection.humanAttention;
  const lines = [
    "# Tracker ceremony (compiled projection)",
    "",
    "Follow this effective ceremony projection and use governed control-plane tools for draft validation and human-attention delivery. Never invent provider-specific principals, labels, or mentions. Never claim a human was notified or has replied without a governed tool result.",
    "",
    `Profile: \`${projection.profileId}\` (\`${projection.profileHash}\`)`,
    `External connectors: ${projection.externalConnectors}`,
    `Integration flow: ${projection.integrationFlow}`,
    `Independent verifier required: ${projection.independentVerifierRequired ? "yes" : "no"}`,
    "",
    "## Issue drafts",
    draft.enabled
      ? [
          `- Enabled: yes`,
          `- Require product impact: ${draft.requireProductImpact ? "yes" : "no"}`,
          `- Product-impact heading: ${draft.heading}`,
          `- Section placement: ${draft.sectionPlacement}`,
          `- Max product-impact summary sentences: ${String(draft.maxSummarySentences)}`,
          "- Validate every draft with the governed issue-draft validator before any tracker write.",
        ].join("\n")
      : "- Issue-draft ceremony is disabled for this profile.",
    "",
    "## Human attention",
    attention.enabled
      ? [
          `- Enabled: yes`,
          `- Default target role: ${attention.defaultTargetRole}`,
          `- Default request kind: ${attention.defaultRequestKind}`,
          `- Notify when blocking: ${attention.notifyWhenBlocking ? "yes" : "no"}`,
          `- Notification surfaces: ${attention.notificationSurfaces.join(", ")}`,
          `- Blocking urgency: ${attention.blockingUrgency}`,
          `- Direct notification mode: ${attention.directNotification}`,
          `- Wait for authoritative response: ${attention.waitForAuthoritativeResponse ? "yes" : "no"}`,
          "- Delivery is policy-evaluated and may be partial, unsupported, or fallback; a mention or assignment is not a reply.",
          "- Only verified agent-session created/prompted identities may resolve pending attention — never ordinary out-of-session issue comments.",
        ].join("\n")
      : "- Human-attention ceremony is disabled for this profile.",
  ];
  return lines.join("\n");
}

/**
 * Build ceremony instructions from trusted compiled doctrine.
 * `trusted` is required — channel metadata alone cannot supply a projection that
 * disables draft/attention/independent verification.
 */
export function captainCeremonyInstructions(
  channel: { readonly metadata?: Readonly<Record<string, unknown>> },
  trusted?: CaptainCeremonyProjection,
): string {
  if (trusted === undefined) {
    return [
      "# Tracker ceremony",
      "",
      "No trusted compiled ceremony projection was supplied for this turn.",
      "Use governed control-plane tools for draft validation and human attention.",
      "Never invent provider-specific principals, labels, emails, or mentions.",
      "Never claim a human was notified or has replied without a governed tool result.",
    ].join("\n");
  }

  const resolved = resolveTrustedCeremonyProjection(channel, trusted);
  if ("rejected" in resolved) {
    return [
      "# Tracker ceremony",
      "",
      "Rejected untrusted ceremony projection from channel metadata.",
      "Using the trusted compiled doctrine projection only.",
      "Arbitrary metadata cannot disable draft validation, human attention, or independent verification.",
      "",
      formatCeremonyInstructions(trusted),
    ].join("\n");
  }
  return formatCeremonyInstructions(resolved.projection);
}
