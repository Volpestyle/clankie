import { createHash, verify, type KeyObject } from "node:crypto";
import { ActivitySessionSchema, type ActivitySession } from "./activity-sharing.ts";
import { DiscordPermitClaimsSchema, DiscordPermitHeaderSchema } from "./discord-ingress.ts";

/** Domain separation prevents a media permit from admitting a Discord turn. */
export function activityViewerDigest(session: ActivitySession, authorization: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: "activity-viewer",
        session: ActivitySessionSchema.parse(session),
        authorization,
      }),
    )
    .digest("base64url");
}

export function verifyActivityViewerPermit(
  permit: string,
  options: {
    tenantId: string;
    installationId: string;
    session: ActivitySession;
    authorization: string;
    keys: ReadonlyMap<string, KeyObject>;
    nowMs: number;
  },
): void {
  const parts = permit.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/u.test(part)))
    throw new Error("activity_viewer_denied");
  const [head, payload, signature] = parts as [string, string, string];
  const header = DiscordPermitHeaderSchema.parse(JSON.parse(Buffer.from(head, "base64url").toString()));
  const key = options.keys.get(header.kid);
  if (!key || !verify(null, Buffer.from(`${head}.${payload}`), key, Buffer.from(signature, "base64url")))
    throw new Error("activity_viewer_denied");
  const claims = DiscordPermitClaimsSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString()));
  const now = options.nowMs / 1000;
  if (
    claims.tid !== options.tenantId ||
    claims.inst !== options.installationId ||
    claims.exp <= now ||
    claims.exp <= claims.iat ||
    claims.iat > now + 1 ||
    claims.exp - claims.iat > 60 ||
    claims.dig !== activityViewerDigest(options.session, options.authorization) ||
    options.session.scope.tenantId !== claims.tid ||
    options.session.scope.installationId !== claims.inst
  )
    throw new Error("activity_viewer_denied");
}
