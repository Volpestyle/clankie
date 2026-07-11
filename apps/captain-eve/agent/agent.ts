import { defineAgent } from "eve";

export default defineAgent({
  model: process.env.CAPTAIN_MODEL ?? "anthropic/claude-sonnet-5",
  limits: {
    maxSubagentDepth: 2,
    maxSubagents: 12,
  },
});
