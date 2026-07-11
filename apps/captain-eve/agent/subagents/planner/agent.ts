import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Turn a bounded mission goal and doctrine card into a typed dependency plan with explicit verification.",
  model: process.env.PLANNER_MODEL ?? process.env.CAPTAIN_MODEL ?? "anthropic/claude-sonnet-5",
  limits: { maxSubagentDepth: 1 },
});
