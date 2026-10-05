import { createHash, createECDH, randomBytes, generateKeyPairSync, sign } from "node:crypto";
import { derivePublicGatewayHostId } from "@clankie/protocol/public-gateway";
import { SupportAccessCommandSchema, type SupportAccessCommand } from "@clankie/protocol/support-access";
export function hostedFixture(now = 1_790_000_000_000) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const kid = createHash("sha256")
    .update(publicKey.export({ format: "der", type: "spki" }))
    .digest("base64url")
    .slice(0, 16);
  const accountId = "account-1",
    installationId = "i".repeat(22),
    tenantId = `tn_${"a".repeat(20)}`;
  const hostId = derivePublicGatewayHostId(accountId, installationId);
  const token = (typ: string, claims: Record<string, unknown>) => {
    const data = [
      { alg: "EdDSA", typ, kid },
      { iss: "clankie-fleet", tid: tenantId, hid: hostId, iat: now / 1000, ...claims },
    ]
      .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
      .join(".");
    return `${data}.${sign(null, Buffer.from(data), privateKey).toString("base64url")}`;
  };
  const host = (iat = now / 1000) =>
    token("clankie-host", {
      aud: "clankie-gateway",
      sub: accountId,
      inst: installationId,
      iat,
      exp: iat + 21600,
    });
  const browserPublicKey = createECDH("prime256v1").generateKeys().toString("base64url");
  const nonce = randomBytes(16).toString("base64url");
  const pair = (claims: Record<string, unknown> = {}) =>
    token("clankie-pair", {
      aud: "clankie-body",
      jti: "j".repeat(22),
      bkh: createHash("sha256").update(Buffer.from(browserPublicKey, "base64url")).digest("base64url"),
      non: nonce,
      exp: now / 1000 + 120,
      ...claims,
    });
  const bootstrap = {
    hostCredential: host(),
    pairingKeyRegistrationToken: "bootstrap-only-registration-token",
    credentialExpiresAtMs: now + 21600000,
    gatewayOrigin: "https://api.example.test",
    accountId,
    installationId,
    tenantId,
    fleetVerifyKeysJson: JSON.stringify({
      keys: [{ publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) }],
    }),
  };
  const security = (requestNonce: string, claims: Record<string, unknown> = {}) =>
    token("clankie-security", {
      hid: undefined,
      typ: "clankie-security",
      aud: "clankie-body",
      inst: installationId,
      non: requestNonce,
      exp: now / 1000 + 60,
      gen: 0,
      rev: [],
      ak: null,
      pk: null,
      ...claims,
    });
  const support = (
    command: SupportAccessCommand,
    publicKey: string,
    requestNonce: string,
    claims: Record<string, unknown> = {},
  ) =>
    token("clankie-support", {
      aud: "clankie-body",
      sub: accountId,
      jti: randomBytes(16).toString("base64url"),
      bkh: createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("base64url"),
      non: requestNonce,
      cmd: createHash("sha256")
        .update(JSON.stringify(SupportAccessCommandSchema.parse(command)))
        .digest("base64url"),
      exp: now / 1000 + 120,
      ...claims,
    });
  return { now, bootstrap, host, pair, hostId, browserPublicKey, nonce, security, support };
}
