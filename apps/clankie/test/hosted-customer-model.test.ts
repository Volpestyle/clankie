import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  createHostedCustomerModels,
  customerAuthHeaders,
  customerPlaceholderKey,
  customerSeatModel,
  customerUpstreamUrl,
} from "../src/hosted-customer-model.ts";

const codexToken = (account: string) =>
  [
    Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url"),
    Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: account },
        sub: "user-secret-subject",
      }),
    ).toString("base64url"),
    "real-signature-part",
  ].join(".");

describe("the customer model loopback's pieces (VUH-1373)", () => {
  it("gives pi a placeholder shaped like the credential, never the credential", () => {
    expect(customerPlaceholderKey("openai-responses", "sk-proj-real")).toBe("local");
    expect(customerPlaceholderKey("anthropic-messages", "sk-ant-api03-real")).toBe("local");
    const anthropicOAuth = customerPlaceholderKey("anthropic-messages", "sk-ant-oat01-real-token");
    expect(anthropicOAuth).toContain("sk-ant-oat");
    expect(anthropicOAuth).not.toContain("real");
    const real = codexToken("acct-123");
    const codex = customerPlaceholderKey("openai-codex-responses", real)!;
    // pi reads the account id from the payload with atob, so standard base64.
    const payload = JSON.parse(Buffer.from(codex.split(".")[1]!, "base64").toString("utf8"));
    expect(payload).toEqual({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" } });
    expect(codex).not.toContain("real-signature-part");
    expect(codex).not.toContain(real.split(".")[1]!);
    expect(customerPlaceholderKey("openai-codex-responses", "not-a-jwt")).toBeUndefined();
  });

  it("sends the real credential the way each API does, replacing the placeholder", () => {
    expect(customerAuthHeaders("openai-responses", "sk-real")).toEqual({ authorization: "Bearer sk-real" });
    expect(customerAuthHeaders("anthropic-messages", "sk-ant-api03-real")).toEqual({
      "x-api-key": "sk-ant-api03-real",
    });
    expect(customerAuthHeaders("anthropic-messages", "sk-ant-oat01-real")).toEqual({
      authorization: "Bearer sk-ant-oat01-real",
    });
    expect(customerAuthHeaders("google-generative-ai", "g-real")).toEqual({ "x-goog-api-key": "g-real" });
    const real = codexToken("acct-9");
    expect(customerAuthHeaders("openai-codex-responses", real)).toEqual({
      authorization: `Bearer ${real}`,
      "chatgpt-account-id": "acct-9",
    });
  });

  it("forwards only under the selected provider's base URL", () => {
    expect(customerUpstreamUrl("https://api.openai.com/v1", "/responses")?.href).toBe(
      "https://api.openai.com/v1/responses",
    );
    expect(customerUpstreamUrl("https://api.anthropic.com", "/v1/messages")?.href).toBe(
      "https://api.anthropic.com/v1/messages",
    );
    expect(
      customerUpstreamUrl(
        "https://generativelanguage.googleapis.com/v1beta",
        "/models/g:streamGenerateContent?alt=sse",
      )?.href,
    ).toBe("https://generativelanguage.googleapis.com/v1beta/models/g:streamGenerateContent?alt=sse");
    for (const escape of ["/../admin", "/v1/%2e%2e/x", "//evil.example/x", "evil", "/./x"]) {
      expect(customerUpstreamUrl("https://api.openai.com/v1", escape), escape).toBeUndefined();
    }
  });

  it("declares the customer's model for pi with its API and limits, pointed at the loopback", () => {
    const model = {
      id: "gpt-6-luna",
      name: "GPT-6 Luna",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_050_000,
      maxTokens: 128_000,
    } as unknown as Model<Api>;
    const seat = customerSeatModel(
      { model, baseUrl: model.baseUrl, apiKey: "sk-proj-never-in-pi", headers: {} },
      "http://127.0.0.1:4319/customer",
    );
    expect(seat).toEqual({
      model: "clankie-customer/gpt-6-luna",
      provider: {
        id: "clankie-customer",
        config: {
          baseUrl: "http://127.0.0.1:4319/customer",
          api: "openai-responses",
          apiKey: "local",
          models: [
            {
              id: "gpt-6-luna",
              name: "GPT-6 Luna",
              reasoning: true,
              input: ["text", "image"],
              contextWindow: 1_050_000,
              maxTokens: 128_000,
            },
          ],
        },
      },
    });
    expect(JSON.stringify(seat)).not.toContain("sk-proj-never-in-pi");
  });

  it("resolves the selected model's current credential on every call, and nothing on included usage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "customer-model-"));
    try {
      mkdirSync(join(dir, "clankie"), { recursive: true });
      const env = { XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, CLANKIE_DISABLE_MODELS_FETCH: "1" };
      const store = new FileCredentialStore(join(dir, "credentials.json"));
      const models = createHostedCustomerModels({ store, env });
      writeFileSync(join(dir, "clankie", "clankie.json"), JSON.stringify({ model: "clankie/default" }));
      expect(await models.resolve()).toBeUndefined();

      writeFileSync(join(dir, "clankie", "clankie.json"), JSON.stringify({ model: "openai/gpt-6-luna" }));
      await store.set("openai", { type: "api", key: "sk-first" });
      const first = await models.resolve();
      expect(first).toMatchObject({
        apiKey: "sk-first",
        model: { provider: "openai", api: "openai-responses" },
      });
      expect(first?.baseUrl).toMatch(/^https:\/\/api\.openai\.com/u);
      // A key replaced mid-run is used on the very next call, with no restart.
      await store.set("openai", { type: "api", key: "sk-second" });
      expect((await models.resolve())?.apiKey).toBe("sk-second");
      // No credential behind the selection: nothing to forward to.
      await store.delete("openai");
      expect(await models.resolve()).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
