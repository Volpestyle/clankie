import { describe, expect, it, vi } from "vitest";
import { MemoryCredentialStore } from "../../credential-broker/test/memory-store.ts";
import { assertModelCredentialAllowed, modelCredentialAllowed } from "../src/subscription-policy.ts";
import { createCodexFetch, runCodexBrowserLogin, runCodexDeviceLogin } from "../src/oauth/openai-codex.ts";

const hosted = { CLANKIE_HOSTED_BOOTSTRAP_FILE: "/scratch/bootstrap.json" };

describe("Clankie subscription policy", () => {
  it("refuses legacy Claude OAuth and token-shaped keys without touching API credentials", () => {
    for (const credential of [
      { type: "oauth" },
      { type: "api", key: "sk-ant-oat01-stale" },
      { type: "wellknown", token: "sk-ant-oat01-stale" },
    ]) {
      expect(() => assertModelCredentialAllowed("anthropic", credential, { env: {} })).toThrow(
        "no longer supports Claude",
      );
      expect(modelCredentialAllowed("anthropic", credential, { env: {} })).toBe(false);
    }
    expect(() =>
      assertModelCredentialAllowed("anthropic", undefined, {
        env: { ANTHROPIC_API_KEY: "sk-ant-oat01-stale" },
      }),
    ).toThrow("no longer supports Claude");
    expect(
      modelCredentialAllowed("anthropic", { type: "api", key: "sk-ant-api03-owned" }, { env: hosted }),
    ).toBe(true);
    expect(modelCredentialAllowed("openai-codex", { type: "oauth" }, { env: {} })).toBe(true);
    expect(modelCredentialAllowed("openai-codex", { type: "oauth" }, { env: hosted })).toBe(false);
  });

  it("blocks hosted browser/device login and transport before any external action", async () => {
    const openUrl = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(runCodexBrowserLogin({ env: hosted, openUrl, fetchImpl })).rejects.toThrow(
      "pending OpenAI approval",
    );
    await expect(runCodexDeviceLogin({ env: hosted, fetchImpl, onUserCode: vi.fn() })).rejects.toThrow(
      "pending OpenAI approval",
    );
    expect(() => createCodexFetch({ env: hosted, store: new MemoryCredentialStore(), fetchImpl })).toThrow(
      "pending OpenAI approval",
    );
    expect(openUrl).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
