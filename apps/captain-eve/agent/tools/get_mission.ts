import { defineTool } from "eve/tools";
import { z } from "zod";
import { controlPlaneClient } from "../../lib/client.ts";

export default defineTool({
  description: "Read authoritative mission state from the control plane.",
  inputSchema: z.object({ missionId: z.string().min(1) }),
  async execute({ missionId }) {
    return controlPlaneClient().getMission(missionId);
  },
});
