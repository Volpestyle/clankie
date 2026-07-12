import { defineEval } from "eve/evals";

export default defineEval({
  description: "Loads the evaluation playbook when asked to judge a completed mission.",
  tags: ["skills"],
  async test(t) {
    await t.send(
      "Explain how you would evaluate whether a completed mission demonstrates reliable lead-agent orchestration. Do not call control-plane tools.",
    );
    t.succeeded();
    t.loadedSkill("evaluate-mission");
    t.noFailedActions();
  },
});
