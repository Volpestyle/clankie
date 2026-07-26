import { defineTool } from "eve/tools";
import { z } from "zod";
import { controlPlaneClient } from "../../lib/client.ts";
import { stopPlay } from "../../lib/play.ts";

export default defineTool({
  description:
    "Stop the game you are currently playing. The session ends at the next " +
    "turn boundary and mints a checkpoint, so progress survives (the result " +
    "carries its id). 'stop_refused' with not_playing means nothing was " +
    "running; 'pending' means the stop is in flight — it lands within a turn.",
  inputSchema: z.object({
    originLane: z
      .enum(["operator", "discord_voice", "discord_presence", "gameplay"])
      .describe("The surface this ask came from; telemetry, not authority.")
      .default("operator"),
    requestedBy: z
      .string()
      .min(1)
      .max(200)
      .describe("The asker's id as the surface authenticated them; 'owner' for the operator."),
  }),
  async execute({ originLane, requestedBy }) {
    return stopPlay(controlPlaneClient(), { originLane, requestedBy });
  },
});
