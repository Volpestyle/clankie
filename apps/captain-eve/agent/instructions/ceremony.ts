import { defineDynamic, defineInstructions } from "eve/instructions";
import { captainCeremonyInstructions } from "../../lib/ceremony-instructions.ts";

/**
 * Injects tracker ceremony instructions from the trusted control-plane clientContext
 * projection. Channel metadata that does not match the trusted compiled projection
 * is rejected (cannot disable draft/attention/independent verification).
 *
 * `clientContext.ceremonyProjection` is the trusted compiled projection; channel
 * metadata is only accepted when it matches that projection.
 */
export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      const trusted = trustedProjectionFromContext(ctx);
      return defineInstructions({
        markdown: captainCeremonyInstructions(ctx.channel, trusted),
      });
    },
    "turn.started": (_event, ctx) => {
      const trusted = trustedProjectionFromContext(ctx);
      return defineInstructions({
        markdown: captainCeremonyInstructions(ctx.channel, trusted),
      });
    },
  },
});

function trustedProjectionFromContext(ctx: {
  readonly channel: { readonly metadata?: Readonly<Record<string, unknown>> };
  readonly clientContext?: Readonly<Record<string, unknown>>;
}): import("@clankie/doctrine").CaptainCeremonyProjection | undefined {
  // Prefer top-level trusted clientContext.ceremonyProjection from control plane.
  const top = ctx.clientContext?.ceremonyProjection;
  if (top !== null && typeof top === "object") {
    const record = top as Record<string, unknown>;
    if (typeof record.profileId === "string" && typeof record.profileHash === "string") {
      return top as import("@clankie/doctrine").CaptainCeremonyProjection;
    }
  }
  // Fallback: only when channel metadata was planted by control plane (same path).
  // Without a second trusted source, instructions refuse to treat arbitrary metadata as authority.
  return undefined;
}
