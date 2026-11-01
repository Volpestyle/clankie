import type { ClankieExtension } from "@clankie/extension";
import { createBrowserHost, type BrowserHost } from "./browser-host.ts";
import type { CorePorts, CoreProjection } from "./extension-host.ts";

/**
 * Clankie's private Browser Use Pi session as an ADR 0328 extension. Starting
 * it builds the host; Chrome itself launches on the first call. Whether to
 * record sessions is read from live settings each time.
 */
export const browserExtension: ClankieExtension<
  undefined,
  CorePorts,
  "capabilityStateRoot" | "attachmentRoot" | "logger" | "env" | "settings",
  CoreProjection
> = {
  contractVersion: 1,
  id: "browser",
  // Its one setting, recordSessions, is read live through the settings port.
  settings: { key: "browser", schema: { parse: () => undefined } },
  needs: ["capabilityStateRoot", "attachmentRoot", "logger", "env", "settings"],
  create(host) {
    let browser: BrowserHost | undefined;
    return {
      async start() {
        try {
          browser = await createBrowserHost({
            stateRoot: host.capabilityStateRoot,
            attachmentRoot: host.attachmentRoot,
            logger: host.logger,
            environment: host.env,
            recordSessions: async () => (await host.settings.load()).browser.recordSessions,
          });
        } catch (error) {
          host.logger.error(
            { err: error instanceof Error ? error.message : String(error) },
            "browser host failed to start; Clankie has no browser this run",
          );
          throw error;
        }
        host.logger.info({ event: "browser.capability.enabled" }, "in-process browser host started");
      },
      async stop() {
        // allow-swallowed-rejection -- shutdown is best effort, as it was before the move.
        await browser?.close().catch(() => undefined);
      },
      health: () => ({ state: "ready" }),
      projection: () => (browser === undefined ? {} : { browser }),
    };
  },
};
