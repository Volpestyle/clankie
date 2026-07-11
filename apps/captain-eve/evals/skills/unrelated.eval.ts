import { defineEval } from "eve/evals";

export default defineEval({
  description: "Does not load a mission playbook for an unrelated conversational turn.",
  tags: ["skills", "ablation"],
  async test(t) {
    await t.send("Reply with a brief greeting and do nothing else.");
    t.succeeded();
    t.notCalledTool("load_skill");
    t.noFailedActions();
  },
});
