import { createAdaptorServer } from "@hono/node-server";
import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Server } from "node:http";
import { LOCAL_COMPANION_ISSUER_FILE, LocalCompanionIssuerSchema } from "@clankie/protocol/local-companion";
import { prepareCompanionDirectory } from "../../tui/bin/local-companion-files.ts";
import { readPrivateJson } from "../../tui/bin/update-files.ts";
import type { LocalCompanionBoundary } from "./local-companion-boundary.ts";

/** The mint client never sends an operator bearer to an unproven TCP listener. */
export async function startLocalCompanionIssuer(options: {
  stateRoot: string;
  controlPlaneUrl: string;
  boundary: LocalCompanionBoundary;
  fetch(request: Request): Response | Promise<Response>;
}): Promise<{ close(): Promise<void> }> {
  const directory = prepareCompanionDirectory(options.stateRoot);
  const socketPath = join(directory, `mint-${randomUUID().slice(0, 8)}.sock`);
  const discovery = LocalCompanionIssuerSchema.parse({
    version: 1,
    socketPath,
    controlPlaneUrl: options.controlPlaneUrl,
  });
  const server = createAdaptorServer({ fetch: options.boundary.privateFetch(options.fetch) }) as Server;
  const path = join(directory, LOCAL_COMPANION_ISSUER_FILE);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await writeFile(temporary, JSON.stringify(discovery) + "\n", { flag: "wx", mode: 0o600 });
    if (prepareCompanionDirectory(options.stateRoot) !== directory) throw Error("unsafe_state_root");
    await rename(temporary, path);
  } catch (error) {
    server.close();
    await rm(socketPath, { force: true });
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
  return {
    close: async () => {
      // Only remove our own discovery; a replacement service owns its own listener.
      try {
        const current = LocalCompanionIssuerSchema.parse(readPrivateJson(path));
        if (current.socketPath === socketPath) await rm(path, { force: true });
      } catch {
        /* Missing or invalid discovery has no authority. */
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(socketPath, { force: true });
    },
  };
}
