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

    await expect(verifyToken(valid)).resolves.toEqual({
      accountId: "account-1",
      clientId,
      expiresAtMs: 1_060_000,
    });
    const family = await verifyToken(
      jwt(
        { alg: "RS256", kid: "key-1" },
        {
          iss: issuer,
          client_id: clientId,
          token_use: "access",
          sub: "account-1",
          exp: 1_060,
          origin_jti: "family-one",
          auth_time: 900,
        },
        privateKey,
      ),
    );
    const rotated = await verifyToken(
      jwt(
        { alg: "RS256", kid: "key-1" },
        {
          iss: issuer,
          client_id: clientId,
          token_use: "access",
          sub: "account-1",
          exp: 1_060,
          origin_jti: "family-two",
          auth_time: 900,
        },
        privateKey,
      ),
    );
    expect(family.session?.id).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(rotated.session?.id).not.toBe(family.session?.id);
    expect(rotated.session?.authEventId).toBe(family.session?.authEventId);
    expect((await verifyToken(valid)).session).toBeUndefined();
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

describe("web provider revocation (VUH-2123)", () => {
  it("checks every verified access JWT, including one already accepted, without IAM or a success cache", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: "jwk" }), kid: "key-1", alg: "RS256", use: "sig" };
    let revoked = false;
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("jwks.json")) return Response.json({ keys: [jwk] });
      expect(String(url)).toBe("https://cognito-idp.us-east-1.amazonaws.com/");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("x-amz-target")).toBe(
        "AWSCognitoIdentityProviderService.GetUser",
      );
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      expect(JSON.parse(String(init?.body))).toEqual({ AccessToken: valid });
      return revoked
        ? Response.json({ __type: "NotAuthorizedException", message: valid }, { status: 400 })
        : Response.json({ UserAttributes: [{ Name: "sub", Value: "account-1" }] });
    });
    const valid = jwt(
      { alg: "RS256", kid: "key-1" },
      {
        iss: issuer,
        client_id: clientId,
        token_use: "access",
        sub: "account-1",
        exp: 1060,
        scope: "aws.cognito.signin.user.admin",
        origin_jti: "family",
        auth_time: 900,
      },
      privateKey,
    );
    const check = createCognitoAccessTokenVerifier({
      issuer,
      clientId,
      fetchImpl,
      clock: () => 1000000,
      checkRevocation: true,
    });
    await expect(check(valid)).resolves.toMatchObject({ accountId: "account-1" });
    revoked = true;
    await expect(check(valid)).rejects.toThrow(/^Cognito access token revocation check failed$/u);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // JWKS cached; provider status never cached.
    const native = createCognitoAccessTokenVerifier({ issuer, clientId, fetchImpl, clock: () => 1000000 });
    await expect(native(valid)).resolves.toMatchObject({ accountId: "account-1" });
  });

  it("fails closed on unsupported scope, provider failures and subject substitution; never sends an invalid JWT", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: "jwk" }), kid: "key-1", alg: "RS256", use: "sig" };
    const status = vi.fn<typeof fetch>(async () =>
      Response.json({ UserAttributes: [{ Name: "sub", Value: "wrong" }] }),
    );
    const fetchImpl: typeof fetch = async (url, init) =>
      String(url).endsWith("jwks.json") ? Response.json({ keys: [jwk] }) : status(url, init);
    const check = createCognitoAccessTokenVerifier({
      issuer,
      clientId,
      fetchImpl,
      clock: () => 1000000,
      checkRevocation: true,
    });
    const token = (extra: Record<string, unknown>) =>
      jwt(
        { alg: "RS256", kid: "key-1" },
        { iss: issuer, client_id: clientId, token_use: "access", sub: "account-1", exp: 1060, ...extra },
        privateKey,
      );
    await expect(check(token({}))).rejects.toThrow(/cannot be checked/u);
    await expect(check(token({ client_id: "other" }))).rejects.toThrow(/issuer or client/u);
    expect(status).not.toHaveBeenCalled();
    const valid = token({ scope: "aws.cognito.signin.user.admin" });
    await expect(check(valid)).rejects.toThrow(/revocation check failed/u);
    status.mockResolvedValue(Response.json({}, { status: 429 }));
    await expect(check(valid)).rejects.toThrow(/revocation check failed/u);
    status.mockRejectedValue(new Error("fixture timeout"));
    await expect(check(valid)).rejects.toThrow(/revocation check failed/u);
    expect(() =>
      createCognitoAccessTokenVerifier({
        issuer: "https://other.example/pool",
        clientId,
        checkRevocation: true,
      }),
    ).toThrow(/AWS Cognito issuer/u);
  });
});
