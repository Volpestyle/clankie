import { defineTool } from "eve/tools";
import { z } from "zod";
import { controlPlaneClient } from "../../lib/client.ts";

export default defineTool({
  description: "Create a mission record before planning or delegating work.",
  inputSchema: z.object({
    goal: z.string().min(1),
    context: z.record(z.string(), z.unknown()).default({}),
  }),
  async execute(input) {
    return controlPlaneClient().createMission(input);
  },
});
