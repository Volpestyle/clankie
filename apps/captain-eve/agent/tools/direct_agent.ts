import { defineTool } from "eve/tools";
import { z } from "zod";
import { controlPlaneClient } from "../../lib/client.ts";

export default defineTool({
  description:
    "Send bounded steering text to an agent adopted at `directed` grade, using an adoptionId from adopt_agent. This is the same vocabulary a human operator has — course corrections and questions — and it is never a channel for approvals, credentials, or policy overrides. A `binding_lapsed` refusal means the agent that was in that terminal has been replaced; say so rather than retrying.",
  inputSchema: z.object({
    adoptionId: z.string().min(1).max(200),
    text: z.string().min(1).max(20_000),
  }),
  async execute({ adoptionId, text }) {
    return controlPlaneClient().directAdoptedAgent({
      schemaVersion: 1,
      adoptionId,
      text,
    });
  },
});
