import type { CaptainCeremonyProjection } from "@clankie/doctrine";

/**
 * Portable markdown for Eve dynamic instructions. Connector-neutral: no
 * provider, email, label, or mention nouns.
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
