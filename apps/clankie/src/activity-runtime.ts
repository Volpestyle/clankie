import { randomBytes } from "node:crypto";
import { RenderedSurfaceHub } from "../../discord-activity/src/frame-hub.ts";
import { ActivityShareRegistry } from "../../discord-activity/src/share-registry.ts";
import { createFrameProducerServer } from "../../discord-activity/src/producer.ts";

/** Hosted media lives inside the body; customers never configure a listener or tunnel. */
export async function startHostedActivityRuntime() {
  const token = randomBytes(48).toString("base64url");
  const hub = new RenderedSurfaceHub();
  const shares = new ActivityShareRegistry();
  const producer = createFrameProducerServer({ hub, shares, token });
  const port = await producer.listen(0);
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    close: async () => {
      shares.close();
      await producer.close();
    },
  };
}
