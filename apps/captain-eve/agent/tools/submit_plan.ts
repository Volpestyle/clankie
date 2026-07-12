import { defineTool } from "eve/tools";
import { MissionPlanSchema } from "@clankie/protocol";
import { controlPlaneClient } from "../../lib/client.ts";

export default defineTool({
  description: "Validate and submit the complete typed plan for an existing mission.",
  inputSchema: MissionPlanSchema,
  async execute(plan) {
    return controlPlaneClient().proposePlan(plan.missionId, plan);
  },
});
