import type { CaptainCeremonyProjection } from "@clankie/doctrine";
import { formatCeremonyInstructions } from "@clankie/tracker-connector";

/**
 * Extract a trusted ceremony projection from Eve channel metadata / client context.
 * Accepts only structured objects — never free-form model text.
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

export function captainCeremonyInstructions(
  channel: { readonly metadata?: Readonly<Record<string, unknown>> },
  fallback?: CaptainCeremonyProjection,
): string {
  const projection = ceremonyProjectionFromChannel(channel) ?? fallback;
  if (projection === undefined) {
    return [
      "# Tracker ceremony",
      "",
      "No compiled ceremony projection was supplied in trusted client context for this turn.",
      "Use governed control-plane tools for draft validation and human attention.",
      "Never invent provider-specific principals, labels, emails, or mentions.",
      "Never claim a human was notified or has replied without a governed tool result.",
    ].join("\n");
  }
  return formatCeremonyInstructions(projection);
}
