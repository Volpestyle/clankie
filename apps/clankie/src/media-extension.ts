import type { ClankieExtension } from "@clankie/extension";
import type { CorePorts, CoreProjection } from "./extension-host.ts";
import { createTldrawHost, tldrawEnabled } from "./tldraw-host.ts";
import type { DiagramPort } from "./ports/media.ts";

/**
 * What Clankie makes, as an ADR 0328 extension. It starts with his drawing
 * hand (ADR 0096): the tldraw desktop app is a GUI app on the operator's Mac,
 * so "not open" is the normal absent case and stays a refusal he says out
 * loud; nothing here reaches the app until he draws something. Image, video
 * and skin draft generation move in next.
 */
export const mediaExtension: ClankieExtension<
  undefined,
  CorePorts,
  "capabilityStateRoot" | "attachmentRoot" | "logger" | "env",
  CoreProjection
> = {
  contractVersion: 1,
  id: "media",
  settings: { key: "media", schema: { parse: () => undefined } },
  needs: ["capabilityStateRoot", "attachmentRoot", "logger", "env"],
  create(host) {
    let diagrams: DiagramPort | undefined;
    return {
      async start() {
        if (!tldrawEnabled(host.env.CLANKIE_TLDRAW_ENABLED)) return;
        diagrams = await createTldrawHost({
          stateRoot: host.capabilityStateRoot,
          attachmentRoot: host.attachmentRoot,
          logger: host.logger,
          environment: host.env,
        });
        host.logger.info({ event: "tldraw.capability.enabled" }, "diagram host ready");
      },
      async stop() {},
      health: () => ({ state: "ready" }),
      projection: () => (diagrams === undefined ? {} : { diagrams }),
    };
  },
};
