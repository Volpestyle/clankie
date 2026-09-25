import { describe, expect, it } from "vitest";
import { captainReadiness } from "../src/readiness.ts";

describe("captainReadiness", () => {
  it("is not ready until a model is chosen", () => {
    expect(captainReadiness({ config: {}, credentialIds: ["anthropic"], env: {} })).toEqual({
      ready: false,
      reason: "no_model",
    });
  });

  it("names the provider a chosen model still needs a credential for", () => {
    expect(
      captainReadiness({ config: { model: "anthropic/claude-opus-5-5" }, credentialIds: [], env: {} }),
    ).toEqual({
      ready: false,
      reason: "no_credential",
      model: "anthropic/claude-opus-5-5",
      providerId: "anthropic",
    });
  });

  it("accepts a stored credential, a provider env key, or a declared endpoint", () => {
    const stored = captainReadiness({
      config: { model: "anthropic/claude-opus-5-5" },
      credentialIds: ["anthropic"],
      env: {},
    });
    expect(stored).toMatchObject({ ready: true, auth: "credential" });

    const env = captainReadiness({
      config: { model: "anthropic/claude-opus-5-5" },
      credentialIds: [],
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
    });
    expect(env).toMatchObject({ ready: true, auth: "env" });

    const endpoint = captainReadiness({
      config: {
        model: "ollama/qwen3:8b",
        provider: { ollama: { options: { baseURL: "http://localhost:11434/v1" } } },
      },
      credentialIds: [],
      env: {},
    });
    expect(endpoint).toMatchObject({ ready: true, auth: "endpoint" });
  });

  it("lets a ChatGPT subscription serve an openai ref it routes", () => {
    expect(
      captainReadiness({ config: { model: "openai/gpt-5.5" }, credentialIds: ["openai-codex"], env: {} }),
    ).toMatchObject({ ready: true, auth: "subscription" });
    expect(
      captainReadiness({
        config: { model: "openai/gpt-5.5", disabled_providers: ["openai-codex"] },
        credentialIds: ["openai-codex"],
        env: {},
      }),
    ).toMatchObject({ ready: false, reason: "no_credential" });
  });
});
