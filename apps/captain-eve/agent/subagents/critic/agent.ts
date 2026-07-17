import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Adversarially review a mission plan for hidden dependencies, policy bypass, weak evidence, and integration risk.",
  model: process.env.CRITIC_MODEL ?? process.env.CAPTAIN_MODEL ?? "anthropic/claude-sonnet-5",
});
