import { describe, expect, it, vi } from "vitest";
import {
  CLANKIE_ACCOUNT_PROVIDER_ID,
  beginClankieAccountLogin,
  completeClankieAccountLogin,
  createClankieAccountTokenProvider,
  derivePublicGatewayHostId,
  generatePublicGatewayInstallationId,
  redactCredential,
  type CredentialStore,
  type ProviderCredential,
  type RedactedCredential,
} from "../src/index.ts";

const gateway = "https://api.clankie.bot";
const accountConfig = {
  schemaVersion: 1,
  account: {
    provider: "cognito_email_otp",
    endpoint: "https://cognito-idp.us-east-1.amazonaws.com",
    issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_pool",
    clientId: "client123",
    selfSignUpEnabled: false,
  },
} as const;

describe("Clankie account credential", () => {
  it("signs an invited user in with one email OTP and derives a per-installation host", async () => {
    const requests: Array<{ readonly target: string | null; readonly body: unknown }> = [];
    const access = jwt({ sub: "account-1", client_id: "client123", token_use: "access" });
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/gateway/v1/config")) return Response.json(accountConfig);
      requests.push({
        target: new Headers(init?.headers).get("x-amz-target"),
        body: JSON.parse(String(init?.body)),
      });
      if (requests.length === 1) return Response.json({ ChallengeName: "EMAIL_OTP", Session: "session-1" });
      return Response.json({
        AuthenticationResult: { AccessToken: access, RefreshToken: "refresh-1", ExpiresIn: 3600 },
      });
    });

    const challenge = await beginClankieAccountLogin({
      gatewayUrl: gateway,
      email: "  Person@Example.com ",
      fetchImpl,
    });
    const credential = await completeClankieAccountLogin({ challenge, code: "123456", fetchImpl });

    expect(challenge).toMatchObject({ mode: "signin", email: "person@example.com" });
    expect(requests.map((request) => request.target)).toEqual([
      "AWSCognitoIdentityProviderService.InitiateAuth",
      "AWSCognitoIdentityProviderService.RespondToAuthChallenge",
    ]);
    expect(credential).toMatchObject({ type: "oauth", accountId: "account-1", clientId: "client123" });
    const installationId = generatePublicGatewayInstallationId();
    expect(installationId).toHaveLength(22);
    expect(derivePublicGatewayHostId("account-1", installationId)).toHaveLength(43);
    expect(derivePublicGatewayHostId("account-2", installationId)).not.toBe(
      derivePublicGatewayHostId("account-1", installationId),
    );
  });

  it("rotates an expiring refresh token once across concurrent connector reads", async () => {
    const store = new MemoryStore();
    await store.set(CLANKIE_ACCOUNT_PROVIDER_ID, {
      type: "oauth",
      access: "expired-access",
      refresh: "refresh-1",
      expires: 1,
      accountId: "account-1",
      clientId: "client123",
    });
    const access = jwt({ sub: "account-1", client_id: "client123", token_use: "access" });
    let refreshes = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/gateway/v1/config")) return Response.json(accountConfig);
      refreshes += 1;
      expect(new Headers(init?.headers).get("x-amz-target")).toBe(
        "AWSCognitoIdentityProviderService.GetTokensFromRefreshToken",
      );
      return Response.json({
        AuthenticationResult: { AccessToken: access, RefreshToken: "refresh-2", ExpiresIn: 3600 },
      });
    });
    const token = createClankieAccountTokenProvider({ gatewayUrl: gateway, store, fetchImpl, now: () => 10 });

    const [first, second] = await Promise.all([token(), token()]);
    expect(first).toEqual(second);
    expect(first.accountId).toBe("account-1");
    expect(refreshes).toBe(1);
    expect(await store.get(CLANKIE_ACCOUNT_PROVIDER_ID)).toMatchObject({ refresh: "refresh-2" });
  });

  it("opens signup with the same email code when the pool permits it", async () => {
    const openConfig = { ...accountConfig, account: { ...accountConfig.account, selfSignUpEnabled: true } };
    const access = jwt({ sub: "account-2", client_id: "client123", token_use: "access" });
    const requests: Array<{ readonly target: string | null; readonly body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/gateway/v1/config")) return Response.json(openConfig);
      const request = {
        target: new Headers(init?.headers).get("x-amz-target"),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      requests.push(request);
      if (requests.length === 1) return Response.json({ Session: "signup-session" });
      if (requests.length === 2) return Response.json({ Session: "confirmed-session" });
      return Response.json({
        AuthenticationResult: { AccessToken: access, RefreshToken: "refresh-2", ExpiresIn: 3600 },
      });
    });

    const challenge = await beginClankieAccountLogin({
      gatewayUrl: gateway,
      email: "person@example.com",
      fetchImpl,
    });
    await expect(
      completeClankieAccountLogin({ challenge, code: "123456", fetchImpl }),
    ).resolves.toMatchObject({
      accountId: "account-2",
    });
    expect(requests.map(({ target }) => target)).toEqual([
      "AWSCognitoIdentityProviderService.SignUp",
      "AWSCognitoIdentityProviderService.ConfirmSignUp",
      "AWSCognitoIdentityProviderService.InitiateAuth",
    ]);
    expect(requests[1]?.body).toMatchObject({ Session: "signup-session" });
    expect(requests[2]?.body).toMatchObject({
      AuthParameters: { USERNAME: "person@example.com" },
      Session: "confirmed-session",
    });
  });
});

class MemoryStore implements CredentialStore {
  private readonly values = new Map<string, ProviderCredential>();

  public get(providerId: string): Promise<ProviderCredential | undefined> {
    return Promise.resolve(this.values.get(providerId));
  }

  public set(providerId: string, credential: ProviderCredential): Promise<void> {
    this.values.set(providerId, credential);
    return Promise.resolve();
  }

  public delete(providerId: string): Promise<boolean> {
    return Promise.resolve(this.values.delete(providerId));
  }

  public list(): Promise<Record<string, RedactedCredential>> {
    return Promise.resolve(
      Object.fromEntries(
        [...this.values].map(([providerId, credential]) => [providerId, redactCredential(credential)]),
      ),
    );
  }
}

function jwt(payload: Readonly<Record<string, unknown>>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "RS256", kid: "key-1" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}
