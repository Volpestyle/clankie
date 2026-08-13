import { TaskSpecSchema } from "@clankie/protocol";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { controlPlaneClient } from "../../lib/client.ts";

export default defineTool({
  description:
    "Add one bounded debugger and unchanged read-only re-verifier pair after authoritative verification failure.",
  inputSchema: z.object({
    missionId: z.string().min(1),
    commandId: z.string().min(1),
    failedTaskId: z.string().min(1),
    debugger: TaskSpecSchema,
    reverify: TaskSpecSchema,
  }),
  async execute({ missionId, ...recovery }) {
    return controlPlaneClient().addRecovery(missionId, recovery);
  },
});
