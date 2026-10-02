import { describe, expect, it, vi } from "vitest";
import { connectLinearApp, refreshLinearApp } from "../src/linear-app.ts";
import { redactCredential } from "../src/credential-store.ts";

const client = { clientId: "clankie-client", clientSecret: "SECRET_client_credentials" };
function provider(app = true, workspace = "workspace") {
  return vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith("/oauth/token")) {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("client_credentials");
      expect(body.get("scope")).toBe("read,write");
      expect(body.has("resource")).toBe(false);
      return Response.json({ access_token: "SECRET_app_token", token_type: "Bearer", expires_in: 2_592_000 });
    }
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer SECRET_app_token");
    return Response.json({
      data: {
        viewer: { id: "app-user", name: "Clankie", email: null, app },
        organization: { id: workspace, name: "Personal" },
      },
    });
  });
}

describe("Linear app connection", () => {
  it("verifies an app without inventing an email and keeps secrets out of summaries", async () => {
    const credential = await connectLinearApp(client, provider());
    expect(credential).toMatchObject({
      type: "oauth",
      linearAuth: "app",
      refresh: "",
      account: { actor: "app", userId: "app-user", workspaceId: "workspace" },
    });
    expect(credential.account).not.toHaveProperty("email");
    expect(JSON.stringify(redactCredential(credential))).not.toContain("SECRET_");
  });

  it("rejects a user token instead of labeling it an app", async () => {
    await expect(connectLinearApp(client, provider(false))).rejects.toThrow("did not verify an app");
  });

  it("renews through the app endpoint and preserves the grant binding", async () => {
    const credential = await connectLinearApp(client, provider());
    const renewed = await refreshLinearApp(credential, provider());
    expect(renewed.account?.connectionId).toBe(credential.account?.connectionId);
    await expect(refreshLinearApp(credential, provider(true, "different-workspace"))).rejects.toThrow(
      "identity changed",
    );
  });

  it("never includes a provider error body containing secrets", async () => {
    const fetchImpl: typeof fetch = async () =>
      Response.json({ error: client.clientSecret }, { status: 401 });
    await expect(connectLinearApp(client, fetchImpl)).rejects.toThrow("token request rejected");
  });
});
