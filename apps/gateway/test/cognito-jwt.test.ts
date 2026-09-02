import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createCognitoAccessTokenVerifier } from "../src/cognito-jwt.ts";

const issuer = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_pool";
const clientId = "client123";

describe("Cognito access token verification", () => {
  it("pins RS256, issuer, client, token use, signature, and expiry", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: "jwk" }), kid: "key-1", alg: "RS256", use: "sig" };
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ keys: [jwk] }));
    const verifyToken = createCognitoAccessTokenVerifier({
      issuer,
      clientId,
      fetchImpl,
      clock: () => 1_000_000,
    });
    const valid = jwt(
      { alg: "RS256", kid: "key-1" },
      { iss: issuer, client_id: clientId, token_use: "access", sub: "account-1", exp: 1_060 },
      privateKey,
    );

    await expect(verifyToken(valid)).resolves.toEqual({ accountId: "account-1", expiresAtMs: 1_060_000 });
    const parts = valid.split(".");
    const signature = Buffer.from(parts[2] ?? "", "base64url");
    signature[0] = (signature[0] ?? 0) ^ 1;
    const tampered = `${parts[0]}.${parts[1]}.${signature.toString("base64url")}`;
    await expect(verifyToken(tampered)).rejects.toThrow(/signature/u);
    await expect(
      verifyToken(
        jwt(
          { alg: "RS256", kid: "key-1" },
          { iss: issuer, client_id: "other", token_use: "access", sub: "account-1", exp: 1_060 },
          privateKey,
        ),
      ),
    ).rejects.toThrow(/issuer or client/u);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

function jwt(
  header: Readonly<Record<string, unknown>>,
  payload: Readonly<Record<string, unknown>>,
  privateKey: Parameters<typeof sign>[2],
): string {
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedPayload}`), privateKey);
  return `${encodedHeader}.${encodedPayload}.${signature.toString("base64url")}`;
}
