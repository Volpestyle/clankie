import { describe, expect, it } from "vitest";
import { applyRepoProviderEnvironment } from "../src/repo-environment.ts";

describe("repo provider environment", () => {
  it("loads provider fallbacks without importing broker-owned bearers", () => {
    const environment: NodeJS.ProcessEnv = { OPENAI_API_KEY: "shell-wins" };

    applyRepoProviderEnvironment(
      [
        "OPENAI_API_KEY=repo-key",
        'ANTHROPIC_API_KEY="anthropic-key"',
        "CLANKIE_OPERATOR_TOKEN=stale-operator",
        "CLANKIE_CAPTAIN_TOKEN=stale-captain",
      ].join("\n"),
      environment,
    );

    expect(environment).toEqual({
      OPENAI_API_KEY: "shell-wins",
      ANTHROPIC_API_KEY: "anthropic-key",
    });
  });
});
