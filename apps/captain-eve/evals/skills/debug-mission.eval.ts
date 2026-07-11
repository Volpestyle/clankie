import { defineEval } from "eve/evals";

export default defineEval({
  description: "Loads the recovery playbook for a blocked mission without taking external action.",
  tags: ["skills"],
  async test(t) {
    await t.send(
      "A mission is blocked after independent verification failed. Explain how you would diagnose and recover it, but do not take external action.",
    );
    t.succeeded();
    t.loadedSkill("debug-mission");
    t.noFailedActions();
  },
});
