import { defineTool } from "eve/tools";
import { z } from "zod";
import { controlPlaneClient } from "../../lib/client.ts";

export default defineTool({
  description:
    "Take bounded responsibility for an agent this fleet did not start, using a terminalId from survey_agents. Grade `observed` grants knowledge only and needs no approval. Grade `directed` grants steering and task assignment and requires both an operator approval and an explicit writeScope — without one you will get `refused: approval_required` or `refused: write_scope_required`, which is a normal answer to relay, not an error. An adopted agent can never be the independent verifier of its own work.",
  inputSchema: z.object({
    terminalId: z.string().min(1).max(200),
    grade: z.enum(["observed", "directed"]),
    writeScope: z
      .array(z.string().min(1).max(400))
      .max(64)
      .default([])
      .describe("Paths a directed agent may write. Required for `directed`, forbidden for `observed`."),
  }),
  async execute({ terminalId, grade, writeScope }) {
    return controlPlaneClient().adoptAgent({
      schemaVersion: 1,
      transport: "herdr",
      terminalId,
      grade,
      writeScope,
      adoptedBy: { kind: "captain", id: "eve" },
    });
  },
});
