import { expect, it } from "vitest";
import { questionTools } from "../src/captain/question-tools.ts";

it("gives the model tool schemas without regex patterns its provider may reject", () => {
  // Codex rejects Unicode property escapes (\p{L}) in a tool schema and fails
  // the whole turn; validation stays in each tool's own parse.
  for (const tool of questionTools({})) expect(JSON.stringify(tool.parameters)).not.toContain('"pattern"');
});
