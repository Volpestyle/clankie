import {
  createHash,
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  verify,
  type ECDH,
  type KeyObject,
} from "node:crypto";
import {
  HostedDiscordEnvelopeSchema,
  HostedDiscordHeaderSchema,
  HostedDiscordClaimsSchema,
  HostedDiscordPlainRequestSchema,
  hostedDiscordAllows,
  hostedDiscordContext,
  hostedDiscordRequestTranscript,
  HOSTED_DISCORD_PERMIT_TTL_SECONDS,
  type HostedDiscordRequest,
} from "./hosted-discord.ts";
import { randomBytes } from "node:crypto";
export function hostedDiscordRequestDigest(request: HostedDiscordRequest): string {
  return createHash("sha256").update(hostedDiscordRequestTranscript(request)).digest("base64url");
}
function bytes(text: string): Buffer {
  const value = Buffer.from(text, "base64url");
  if (value.toString("base64url") !== text) throw new Error("invalid_encoding");
  return value;
}
export function verifyHostedDiscordPermit(
  permit: string,
  options: {
    tenantId: string;
    installationId: string;
    verifyKeys: ReadonlyMap<string, KeyObject>;
    nowMs: number;
  },
) {
  const parts = permit.split(".");
  if (parts.length !== 3) throw new Error("invalid_permit");
  const [header, payload, signature] = parts as [string, string, string];
  const h = HostedDiscordHeaderSchema.parse(JSON.parse(bytes(header).toString("utf8")));
  const key = options.verifyKeys.get(h.kid);
  if (!key || !verify(null, Buffer.from(`${header}.${payload}`), key, bytes(signature)))
    throw new Error("invalid_permit");
  const claims = HostedDiscordClaimsSchema.parse(JSON.parse(bytes(payload).toString("utf8")));
  if (
    claims.tid !== options.tenantId ||
    claims.inst !== options.installationId ||
    claims.exp * 1000 <= options.nowMs ||
    claims.iat * 1000 > options.nowMs + 5000 ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > HOSTED_DISCORD_PERMIT_TTL_SECONDS
  )
    throw new Error("invalid_permit");
  return claims;
}
/** Verifies authority and scope before deriving keys or opening configuration bytes. */
export function openHostedDiscord(
  input: unknown,
  options: {
    tenantId: string;
    installationId: string;
    key: ECDH;
    verifyKeys: ReadonlyMap<string, KeyObject>;
    nowMs: number;
  },
) {
  const envelope = HostedDiscordEnvelopeSchema.parse(input),
    claims = verifyHostedDiscordPermit(envelope.permit, options);
  if (
    envelope.tenantId !== claims.tid ||
    envelope.installationId !== claims.inst ||
    claims.dig !== hostedDiscordRequestDigest(envelope) ||
    !hostedDiscordAllows(envelope.method, envelope.path)
  )
    throw new Error("invalid_permit");
  const point = bytes(envelope.ephemeralPublicKey);
  if (point.length !== 65 || point[0] !== 4) throw new Error("invalid_point");
  const domain = hostedDiscordContext(envelope),
    secret = options.key.computeSecret(point);
  const key = Buffer.from(hkdfSync("sha256", secret, bytes(envelope.nonce), domain, 32));
  secret.fill(0);
  try {
    const encrypted = bytes(envelope.sealed),
      cipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(0, 12));
    cipher.setAAD(Buffer.from(`${domain}\nrequest\n${envelope.method}\n${envelope.path}`));
    cipher.setAuthTag(encrypted.subarray(-16));
    const request = HostedDiscordPlainRequestSchema.parse(
      JSON.parse(
        Buffer.concat([cipher.update(encrypted.subarray(12, -16)), cipher.final()]).toString("utf8"),
      ),
    );
    const path = request.path ?? envelope.path;
    if (
      !hostedDiscordAllows(envelope.method, path) ||
      new URL(path, "http://control").pathname !== new URL(envelope.path, "http://control").pathname
    )
      throw new Error("invalid_request");
    if (envelope.method === "GET" && request.body !== undefined) throw new Error("invalid_request");
    if (request.body !== undefined && Buffer.byteLength(request.body, "utf8") > 32768)
      throw new Error("invalid_request");
    return {
      claims,
      method: envelope.method,
      path,
      body: request.body,
      sealResponse(value: unknown) {
        const iv = randomBytes(12),
          cipher = createCipheriv("aes-256-gcm", key, iv);
        cipher.setAAD(Buffer.from(`${domain}\nresponse\n${envelope.permit}`));
        return Buffer.concat([
          iv,
          cipher.update(JSON.stringify(value)),
          cipher.final(),
          cipher.getAuthTag(),
        ]).toString("base64url");
      },
      destroy: () => key.fill(0),
    };
  } catch (error) {
    key.fill(0);
    throw error;
  }
}
