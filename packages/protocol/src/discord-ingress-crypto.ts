import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  hkdfSync,
  randomBytes,
  verify,
  type ECDH,
  type KeyObject,
} from "node:crypto";
import {
  DISCORD_INGRESS_DOMAIN,
  DiscordIngressEnvelopeSchema,
  DiscordIngressEventSchema,
  DiscordPermitClaimsSchema,
  DiscordPermitHeaderSchema,
  discordRequestDigest,
  type DiscordIngressEnvelope,
  type DiscordIngressEvent,
} from "./discord-ingress.ts";

function bytes(value: string): Buffer {
  const result = Buffer.from(value, "base64url");
  if (result.toString("base64url") !== value) throw new Error("invalid_encoding");
  return result;
}
function info(tenantId: string, installationId: string): string {
  return `${DISCORD_INGRESS_DOMAIN}\n${tenantId}\n${installationId}`;
}
function keyFor(ecdh: ECDH, publicKey: string, nonce: string, domain: string): Buffer {
  const point = bytes(publicKey);
  if (point.length !== 65 || point[0] !== 4) throw new Error("invalid_point");
  const shared = ecdh.computeSecret(point);
  try {
    return Buffer.from(hkdfSync("sha256", shared, bytes(nonce), domain, 32));
  } finally {
    shared.fill(0);
  }
}
function seal(key: Buffer, value: unknown, aad: string): string {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  return Buffer.concat([
    iv,
    cipher.update(JSON.stringify(value)),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64url");
}
function open(key: Buffer, value: string, aad: string): unknown {
  const encoded = bytes(value);
  if (encoded.length < 28) throw new Error("invalid_ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", key, encoded.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(encoded.subarray(-16));
  return JSON.parse(
    Buffer.concat([decipher.update(encoded.subarray(12, -16)), decipher.final()]).toString("utf8"),
  );
}
export function prepareDiscordIngress(
  event: DiscordIngressEvent,
  publicKey: string,
): {
  digest: string;
  seal(permit: string): { envelope: DiscordIngressEnvelope; openResponse(sealed: string): unknown };
  destroy(): void;
} {
  const parsed = DiscordIngressEventSchema.parse(event);
  const ephemeral = createECDH("prime256v1");
  ephemeral.generateKeys();
  const ephemeralPublicKey = ephemeral.getPublicKey().toString("base64url");
  const nonce = randomBytes(16).toString("base64url"),
    domain = info(parsed.tenantId, parsed.installationId);
  const key = keyFor(ephemeral, publicKey, nonce, domain);
  return {
    digest: discordRequestDigest(parsed, ephemeralPublicKey, nonce),
    seal: (permit) => ({
      envelope: {
        version: 1,
        permit,
        ephemeralPublicKey,
        nonce,
        sealed: seal(key, parsed, `${domain}\nrequest\n${permit}`),
      },
      openResponse: (sealed) => open(key, sealed, `${domain}\nresponse\n${permit}`),
    }),
    destroy: () => key.fill(0),
  };
}
export function openDiscordIngress(
  input: unknown,
  options: {
    tenantId: string;
    installationId: string;
    key: ECDH;
    verifyKeys: ReadonlyMap<string, KeyObject>;
    nowMs: number;
  },
): { event: DiscordIngressEvent; sealResponse(value: unknown): string; destroy(): void } {
  const envelope = DiscordIngressEnvelopeSchema.parse(input);
  const parts = envelope.permit.split(".");
  if (parts.length !== 3) throw new Error("invalid_permit");
  const [header, claims, signature] = parts as [string, string, string];
  const h = DiscordPermitHeaderSchema.parse(JSON.parse(bytes(header).toString("utf8")));
  const verifyKey = options.verifyKeys.get(h.kid);
  if (!verifyKey || !verify(null, Buffer.from(`${header}.${claims}`), verifyKey, bytes(signature)))
    throw new Error("invalid_permit");
  const c = DiscordPermitClaimsSchema.parse(JSON.parse(bytes(claims).toString("utf8")));
  if (
    c.tid !== options.tenantId ||
    c.inst !== options.installationId ||
    c.exp * 1000 <= options.nowMs ||
    c.iat * 1000 > options.nowMs + 30_000 ||
    c.exp <= c.iat ||
    c.exp - c.iat > 60
  )
    throw new Error("invalid_permit");
  const domain = info(options.tenantId, options.installationId);
  const key = keyFor(options.key, envelope.ephemeralPublicKey, envelope.nonce, domain);
  try {
    const event = DiscordIngressEventSchema.parse(
      open(key, envelope.sealed, `${domain}\nrequest\n${envelope.permit}`),
    );
    if (
      event.tenantId !== c.tid ||
      event.installationId !== c.inst ||
      discordRequestDigest(event, envelope.ephemeralPublicKey, envelope.nonce) !== c.dig ||
      event.eventAtMs > options.nowMs + 30_000 ||
      event.expiresAtMs <= options.nowMs
    )
      throw new Error("invalid_event");
    return {
      event,
      sealResponse: (value) => seal(key, value, `${domain}\nresponse\n${envelope.permit}`),
      destroy: () => key.fill(0),
    };
  } catch {
    key.fill(0);
    throw new Error("invalid_event");
  }
}
