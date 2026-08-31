import { ensureActivityProducerCredential } from "@clankie/credential-broker";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RenderedSurfaceHub } from "./frame-hub.ts";
import { createFrameProducerServer } from "./producer.ts";
import { createDiscordActivityServer } from "./server.ts";

/**
 * Standalone entrypoint. The surface is a rendering client only: it holds no
 * Discord credentials, no authority, and no emulator core. The host
 * feeds it frames through the loopback producer endpoint.
 */
if (
  process.argv[1] !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  const port = positiveInt(process.env.CLANKIE_ACTIVITY_PORT ?? "4320", "CLANKIE_ACTIVITY_PORT");
  const hub = new RenderedSurfaceHub();
  const stateRoot = process.env.CLANKIE_STATE?.trim() || join(homedir(), ".clankie");
  const activity = createDiscordActivityServer({
    hub,
    avatarDirectory: join(stateRoot, "captain", "persona-avatars"),
  });
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

  // The hub has always counted the frames it drops for a backed-up viewer, and
  // nothing ever read the counter — so viewer-side loss was invisible exactly
  // when someone was asking why the picture stuttered. Reported on change only:
  // a healthy stream stays silent, and a bad one names itself.
  let reportedDrops = 0;
  const dropWatch = setInterval(() => {
    const dropped = hub.droppedFrameCount;
    if (dropped === reportedDrops) return;
    process.stdout.write(
      `activity: dropped ${String(dropped - reportedDrops)} frames for backpressure ` +
        `(${String(dropped)} total, ${String(hub.viewerCount)} viewers)\n`,
    );
    reportedDrops = dropped;
  }, 5_000);
  dropWatch.unref();

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      clearInterval(dropWatch);
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
