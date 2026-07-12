import type { CaptainCeremonyProjection } from "@clankie/doctrine";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Authenticate a compiled projection supplied through caller-controlled Eve
 * context. Shape checks prevent malformed signed data from reaching the renderer.
 */
export function verifyCeremonyProjectionEnvelope(
  context: Readonly<Record<string, unknown>> | undefined,
  captainToken: string | undefined,
): CaptainCeremonyProjection | undefined {
  if (context === undefined || captainToken === undefined || captainToken.length === 0) return undefined;
  const projection = context.ceremonyProjection;
  const signature = context.ceremonyProjectionSignature;
  if (projection === null || typeof projection !== "object") return undefined;
  if (typeof signature !== "string" || !/^[a-f0-9]{64}$/u.test(signature)) return undefined;
  const record = projection as Record<string, unknown>;
  if (
    typeof record.profileId !== "string" ||
    typeof record.profileHash !== "string" ||
    record.issueDraft === null ||
    typeof record.issueDraft !== "object" ||
    record.humanAttention === null ||
    typeof record.humanAttention !== "object"
  ) {
    return undefined;
  }
  const expected = createHmac("sha256", captainToken)
    .update(`clankie:captain-ceremony:v1\0${JSON.stringify(projection)}`)
    .digest();
  const supplied = Buffer.from(signature, "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return undefined;
  return projection as CaptainCeremonyProjection;
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
export function captainCeremonyInstructions(trusted?: CaptainCeremonyProjection): string {
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

  return formatCeremonyInstructions(trusted);
}
