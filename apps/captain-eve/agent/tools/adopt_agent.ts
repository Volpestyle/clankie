import { defineTool } from "eve/tools";
import { z } from "zod";
import { controlPlaneClient } from "../../lib/client.ts";

export default defineTool({
  description:
    "Take bounded responsibility for an agent this fleet did not start, using the transportInstanceId, terminalId, and workspaceId from survey_agents. Grade `observed` grants knowledge only and needs no approval. Grade `directed` grants semantic steering and reserves the agent's entire bound workspace from new mission writers; it requires both an operator approval and an explicit expected writeScope. A foreign adopted process never receives a mission task or becomes its verifier.",
  inputSchema: z.object({
    transportInstanceId: z.string().min(1).max(200),
    terminalId: z.string().min(1).max(200),
    workspaceId: z.string().min(1).max(200),
    grade: z.enum(["observed", "directed"]),
    writeScope: z
      .array(z.string().min(1).max(400))
      .max(64)
      .default([])
      .describe(
        "Expected paths for a directed agent; advisory context, while scheduling reserves the whole workspace. Required for `directed`, forbidden for `observed`.",
      ),
  }),
  async execute({ transportInstanceId, terminalId, workspaceId, grade, writeScope }) {
    return controlPlaneClient().adoptAgent({
      schemaVersion: 1,
      transport: "herdr",
      transportInstanceId,
      terminalId,
      workspaceId,
      grade,
      writeScope,
    });
  },
});
