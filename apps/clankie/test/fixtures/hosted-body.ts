import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { derivePublicGatewayHostId } from "@clankie/protocol/public-gateway";
export function hostedFixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const kid = createHash("sha256")
    .update(publicKey.export({ format: "der", type: "spki" }))
    .digest("base64url")
    .slice(0, 16);
  const now = 1_790_000_000_000;
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
  const pair = (claims: Record<string, unknown> = {}) =>
    token("clankie-pair", { aud: "clankie-body", jti: "j".repeat(22), exp: now / 1000 + 120, ...claims });
  const bootstrap = {
    hostCredential: host(),
    credentialExpiresAtMs: now + 21600000,
    gatewayOrigin: "https://api.example.test",
    accountId,
    installationId,
    tenantId,
    fleetVerifyKeysJson: JSON.stringify({
      keys: [{ publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) }],
    }),
  };
  return { now, bootstrap, host, pair, hostId };
}
