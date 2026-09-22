import { expect, it } from "vitest";
import { parseEvaluatorArgs, runEvaluatorCommand, formatEvaluatorStatus } from "../src/command/evaluator.ts";

it("parses the evaluator commands and rejects ambiguous input", () => {
  expect(parseEvaluatorArgs([])).toBeUndefined();
  expect(parseEvaluatorArgs(["enable", "--harness", "claude"])).toEqual({
    action: "enable",
    harness: "claude",
  });
  for (const args of [
    ["enable", "codex"],
    ["disable", "now"],
    ["enable", "--harness", "unknown"],
    ["retry", "../../escape"],
  ])
    expect(() => parseEvaluatorArgs(args)).toThrow("Usage:");
});

it("uses the authenticated API and renders findings and blockers", async () => {
  const status = {
    schemaVersion: 1 as const,
    enabled: true,
    harness: "codex" as const,
    directory: "/state/evaluator",
    queued: 2,
    jobs: [],
    error: "Agent blocked",
  };
  const result = await runEvaluatorCommand(["enable"], {
    env: { CLANKIE_OPERATOR_TOKEN: "test-operator-token" },
    host: "http://localhost:4310",
    fetchImpl: (async (url, init) => {
      expect(String(url)).toBe("http://localhost:4310/v1/captain/evaluator");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-operator-token");
      expect(JSON.parse(String(init?.body))).toEqual({ action: "enable" });
      return Response.json(status);
    }) as typeof fetch,
  });
  expect(result.ok).toBe(true);
  expect(formatEvaluatorStatus(status)).toContain("Agent blocked");
});
