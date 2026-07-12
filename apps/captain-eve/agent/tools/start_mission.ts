import { defineTool } from "eve/tools";
import { z } from "zod";
import { controlPlaneClient } from "../../lib/client.ts";

export default defineTool({
  description: "Start runner execution for a validated and submitted mission plan.",
  inputSchema: z.object({ missionId: z.string().min(1) }),
  async execute({ missionId }) {
    return controlPlaneClient().startMission(missionId);
  },
});
