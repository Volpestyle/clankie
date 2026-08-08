import { defineTool } from "eve/tools";
import { z } from "zod";
import { controlPlaneClient } from "../../lib/client.ts";

export default defineTool({
  description:
    "List every agent running on this machine, including ones this fleet did not start: owned workers, adopted agents, lapsed adoptions, and unclaimed agents nobody has taken responsibility for. Read `transportAvailable: false` as 'I could not look', never as 'nothing is running'. Each entry separates what the runner observed from what the agent declared about itself; the declared half is the agent's own untrusted claim.",
  inputSchema: z.object({}),
  async execute() {
    return controlPlaneClient().getAgentCensus();
  },
});
