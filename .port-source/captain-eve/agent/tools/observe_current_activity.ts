import { defineTool } from "eve/tools";
import { z } from "zod";
import { observeCurrentActivity } from "../../lib/activity.ts";
import { controlPlaneClient } from "../../lib/client.ts";

export default defineTool({
  description:
    "Look at the latest settled turn of your own current activity so you can " +
    "truthfully answer questions like ‘how is Pokémon going?’ Use this when " +
    "someone asks what you are doing, what your goal or next move is, or how it " +
    "is going. A snapshot keeps your own gameplay commentary under selfAuthored " +
    "and actual results under runnerObserved; preserve that distinction. " +
    "pending means no turn has settled yet, and not_playing means no activity is " +
    "live. This is self-observation, not another room’s transcript and not an " +
    "action surface.",
  inputSchema: z.object({}),
  async execute() {
    return observeCurrentActivity(controlPlaneClient());
  },
});
