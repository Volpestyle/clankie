import type { PiModelSelection } from "@clankie/model-provider";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { captainModelExtension, modelCard } from "../src/captain/captain.ts";

const SELECTION = {
  ref: "openai-codex/gpt-5.6-terra",
  thinkingLevel: "medium",
  model: {
    name: "GPT-5.6 Terra",
    provider: "openai-codex",
    reasoning: true,
    contextWindow: 272_000,
    maxTokens: 128_000,
    input: ["text", "image"],
  },
} as unknown as PiModelSelection;

describe("captain model card", () => {
  it("names the model, provider, effort, and limits", () => {
    const card = modelCard(SELECTION);
    expect(card).toContain("GPT-5.6 Terra (`openai-codex/gpt-5.6-terra`), served by openai-codex.");
    expect(card).toContain("Reasoning model, effort medium.");
    expect(card).toContain("Context window 272k tokens, up to 128k out. Takes text and image.");
  });

  it("refreshes the card per run and stays silent when the model cannot be resolved", async () => {
    const resolved = await beforeAgentStartHandler(() => Promise.resolve(SELECTION));
    await expect(resolved({ systemPrompt: "base" })).resolves.toEqual({
      systemPrompt: `base\n\n${modelCard(SELECTION)}`,
    });

    const failing = await beforeAgentStartHandler(() => Promise.reject(new Error("no model")));
    await expect(failing({ systemPrompt: "base" })).resolves.toBeUndefined();
  });
});

async function beforeAgentStartHandler(resolveSelection: () => Promise<PiModelSelection>) {
  let handler: ((event: { systemPrompt: string }) => Promise<unknown>) | undefined;
  await captainModelExtension(resolveSelection).factory({
    on(event: string, candidate: (event: { systemPrompt: string }) => Promise<unknown>) {
      if (event === "before_agent_start") handler = candidate;
    },
  } as unknown as ExtensionAPI);
  if (handler === undefined) throw new Error("before_agent_start handler is missing");
  return handler;
}
