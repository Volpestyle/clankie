import { defineTool } from "eve/tools";
import { z } from "zod";
import { controlPlaneClient } from "../../lib/client.ts";

export default defineTool({
  description: "Send a bounded steering message to a running worker through the runner command bus.",
  inputSchema: z.object({ workerRunId: z.string().min(1), input: z.string().min(1).max(20_000) }),
  async execute({ workerRunId, input }) {
    return controlPlaneClient().steerWorker(workerRunId, input);
  },
});
