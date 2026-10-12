import { createAdaptorServer } from "@hono/node-server";
import { randomUUID } from "node:crypto";
import { chmod, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Server } from "node:http";
import {
  LOCAL_COMPANION_HANDOFF_FILE,
  LOCAL_COMPANION_HANDOFF_PATH,
  LOCAL_COMPANION_OFFER_PATH,
  LOCAL_COMPANION_ISSUER_FILE,
  LocalCompanionHandoffSchema,
  LocalCompanionIssuerSchema,
  LocalCompanionOfferSchema,
} from "@clankie/protocol/local-companion";
import { prepareCompanionDirectory } from "../../tui/bin/local-companion-files.ts";
import { readPrivateJson } from "../../tui/bin/update-files.ts";
import type { LocalCompanionBoundary } from "./local-companion-boundary.ts";
import type { TrustedOperatorIdentity } from "./app/types.ts";

/** The mint client never sends an operator bearer to an unproven TCP listener. */
export async function startLocalCompanionIssuer(options: {
  stateRoot: string;
  controlPlaneUrl: string;
  boundary: LocalCompanionBoundary;
  fetch(request: Request): Response | Promise<Response>;
  /** Authority established by access to this user's private Unix listener. */
  owner?: TrustedOperatorIdentity;
}): Promise<{ close(): Promise<void> }> {
  const directory = prepareCompanionDirectory(options.stateRoot);
  const socketPath = join(directory, `mint-${randomUUID().slice(0, 8)}.sock`);
  const discovery = LocalCompanionIssuerSchema.parse({
    version: 1,
    socketPath,
    controlPlaneUrl: options.controlPlaneUrl,
  });
  const forward = options.boundary.privateFetch(options.fetch, options.owner);
  const server = createAdaptorServer({
    fetch: async (request) => {
      if (new URL(request.url).pathname !== LOCAL_COMPANION_HANDOFF_PATH) return forward(request);
      if (request.method !== "POST" || !options.owner)
        return Response.json({ error: "not_found" }, { status: 404 });
      // This route exists only on the private Unix socket. It neither reads nor
      // exposes the operator bearer, and callers cannot choose a remote destination.
      const result = await forward(
        new Request(new URL(LOCAL_COMPANION_OFFER_PATH, options.controlPlaneUrl), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      );
      if (result.status !== 200) return result;
      const offer = LocalCompanionOfferSchema.parse(await result.json());
      const handoff = LocalCompanionHandoffSchema.parse({
        ...offer,
        controlPlaneUrl: options.controlPlaneUrl,
      });
      const pending = join(directory, `.${randomUUID()}.tmp`);
      try {
        if (prepareCompanionDirectory(options.stateRoot) !== directory) throw Error("unsafe_state_root");
        await writeFile(pending, JSON.stringify(handoff) + "\n", { flag: "wx", mode: 0o600 });
        await rename(pending, join(directory, LOCAL_COMPANION_HANDOFF_FILE));
      } finally {
        await rm(pending, { force: true });
      }
      const body = JSON.stringify({ ready: true });
      return new Response(body, {
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
          connection: "close",
          "cache-control": "no-store",
        },
      });
    },
  }) as Server;
  const path = join(directory, LOCAL_COMPANION_ISSUER_FILE);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
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
