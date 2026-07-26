import { ensureActivityProducerCredential } from "@clankie/credential-broker";
import { RenderedSurfaceHub } from "./frame-hub.ts";
import { createFrameProducerServer } from "./producer.ts";
import { createDiscordActivityServer } from "./server.ts";

export { RenderedSurfaceHub, type RenderedSurfaceViewer } from "./frame-hub.ts";
export { createFrameProducerServer, type FrameProducerServer } from "./producer.ts";
export { createDiscordActivityServer, type DiscordActivityServer } from "./server.ts";

/**
 * Standalone entrypoint. The surface is a rendering client only: it holds no
 * Discord credentials, no mission authority, and no emulator core. The host
 * feeds it frames through the loopback producer endpoint.
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = positiveInt(process.env.CLANKIE_ACTIVITY_PORT ?? "4320", "CLANKIE_ACTIVITY_PORT");
  const hub = new RenderedSurfaceHub();
  const activity = createDiscordActivityServer({ hub });
  const bound = await activity.listen(port);
  process.stdout.write(`clankie activity surface listening on 127.0.0.1:${String(bound)}\n`);

  // The activity server owns the listener, so it owns the first-run mint. The
  // runner only resolves, which avoids two processes minting different tokens.
  // The bearer never comes from the environment.
  const token = await ensureActivityProducerCredential();
  const producerPort = positiveInt(
    // 4321 is the captain's default port; colliding defaults meant the
    // activity server refused to start on a machine running the captain.
    process.env.CLANKIE_ACTIVITY_PRODUCER_PORT ?? "4322",
    "CLANKIE_ACTIVITY_PRODUCER_PORT",
  );
  const producer = createFrameProducerServer({ hub, token });
  const producerBound = await producer.listen(producerPort);
  process.stdout.write(`clankie activity producer listening on 127.0.0.1:${String(producerBound)}\n`);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void Promise.all([activity.close(), producer.close()]).then(() => process.exit(0));
    });
  }
}

function positiveInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
