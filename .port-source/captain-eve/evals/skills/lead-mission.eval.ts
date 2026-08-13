import { defineEval } from "eve/evals";

export default defineEval({
  description: "Loads the lead playbook for a new governed engineering mission.",
  tags: ["skills"],
  async test(t) {
    await t.send(
      "Outline how you would lead a new multi-agent engineering mission from authoritative context through governed integration. Do not create the mission yet.",
    );
    t.succeeded();
    t.loadedSkill("lead-mission");
    t.noFailedActions();
  },
});
