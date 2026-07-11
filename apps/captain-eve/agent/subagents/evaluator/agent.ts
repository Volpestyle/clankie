import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Evaluate a completed mission from its event log and artifacts against the lead-agent scorecard.",
  model: process.env.EVALUATOR_MODEL ?? process.env.CAPTAIN_MODEL ?? "anthropic/claude-sonnet-5",
  limits: { maxSubagentDepth: 1 },
});
