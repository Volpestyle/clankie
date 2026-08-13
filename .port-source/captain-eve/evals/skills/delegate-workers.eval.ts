import { defineEval } from "eve/evals";

export default defineEval({
  description: "Loads the delegation playbook for operator-parity worker control.",
  tags: ["skills"],
  async test(t) {
    await t.send(
      "Explain how you would arm, steer, monitor, harvest, and retire a pane-hosted mission worker. Include the operator command vocabulary and approval boundary. Do not start a mission.",
    );
    t.succeeded();
    t.loadedSkill("delegate-workers");
    t.noFailedActions();
  },
});
