import { defineTool } from "eve/tools";
import { ActionRequestSchema } from "@clankie/protocol";
import { controlPlaneClient } from "../../lib/client.ts";

export default defineTool({
  description:
    "Ask the deterministic policy engine whether a proposed side effect is allowed, denied, or needs human approval.",
  inputSchema: ActionRequestSchema,
  async execute(request) {
    return controlPlaneClient().requestAction(request);
  },
});
