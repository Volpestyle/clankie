import { defineTool } from "eve/tools";
import { z } from "zod";
import { controlPlaneClient } from "../../lib/client.ts";
import { startPlay } from "../../lib/play.ts";

export default defineTool({
  description:
    "Start playing a game on your own body, live on the activity watch surface. " +
    "Currently playable: pokemon-firered. The session resumes from your latest " +
    "checkpoint and keeps going until someone asks you to stop; people can " +
    "watch. The result is what actually happened: 'started' means you are " +
    "playing; 'start_refused' names a reason you can say out loud (body_held " +
    "means someone else is already driving your body); 'pending' means it is " +
    "still spinning up — say so, never claim to be playing yet.",
  inputSchema: z.object({
    environmentId: z.enum(["pokemon-firered"]).default("pokemon-firered"),
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
  async execute({ environmentId, originLane, requestedBy }) {
    return startPlay(controlPlaneClient(), { environmentId, originLane, requestedBy });
  },
});
