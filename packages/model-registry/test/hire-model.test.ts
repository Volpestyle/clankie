import { describe, it, expect } from "vitest";
import { CatalogSchema, resolveHireModel } from "../src/index.ts";

const catalog = CatalogSchema.parse({
  openai: {
    models: {
      "gpt-6.1-sol": { id: "gpt-6.1-sol", name: "GPT-6.1-Sol" },
      "gpt-6-sol": { id: "gpt-6-sol", name: "GPT-6 Sol", status: "deprecated" },
      broken: { name: "Broken" },
    },
  },
  anthropic: { models: { "claude-opus-5-5": { id: "claude-opus-5-5", name: "Claude Opus 5.5" } } },
});
describe("native hire model names", () => {
  it("resolves friendly names to exact current native IDs", () => {
    expect(resolveHireModel(catalog, "codex", "sol 6.1")).toBe("gpt-6.1-sol");
    expect(resolveHireModel(catalog, "codex", "GPT-6.1-Sol")).toBe("gpt-6.1-sol");
    expect(resolveHireModel(catalog, "claude", "Opus")).toBe("claude-opus-5-5");
  });
  it("refuses retired, missing and wrong-harness models without a fallback", () => {
    for (const [harness, model] of [
      ["codex", "sol 6"],
      ["codex", "sol 99"],
      ["codex", "Opus"],
      ["codex", "Broken"],
      ["claude", "sol 6.1"],
    ])
      expect(() => resolveHireModel(catalog, harness!, model!)).toThrow("unavailable or retired");
  });
});
