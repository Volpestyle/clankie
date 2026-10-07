import { DiscordRoomObservations } from "../src/discord-room-observations.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { FileCredentialStore, ensureOperatorCredential } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createCredentialBackedOperatorAuthenticator } from "../src/operator-auth.ts";

/** Real HTTP, owner credentials and atomic settings; the unrelated captain never runs. */
export async function ownerSettingsFixture(env: NodeJS.ProcessEnv = {}, suppliedSettings?: SettingsStore) {
  const root = await mkdtemp(join(tmpdir(), "owner-settings-surface-"));
  const settings = suppliedSettings ?? new SettingsStore(join(root, "settings.json"));
  const operatorCredentialStore = new FileCredentialStore(join(root, "credentials.json"));
  await ensureOperatorCredential({ env: {}, store: operatorCredentialStore });
  const service = await createClankieApp({
    captain: createStubCaptain(),
    settings,
    roomObservations: new DiscordRoomObservations(join(root, "rooms.json")),
    authenticateOperator: createCredentialBackedOperatorAuthenticator({
      env: {},
      store: operatorCredentialStore,
      identity: { operatorId: "fixture-owner" },
    }),
    voiceSettingsEnv: env,
  });
  const server = await startFixtureServer(service.app.fetch);
  return {
    settings,
    options: { settings, env, host: server.host, operatorCredentialStore },
    async close() {
      service.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Uses this package's HTTP adapter for real cross-package CLI fixtures. */
export async function startFixtureServer(
  fetch: Awaited<ReturnType<typeof createClankieApp>>["app"]["fetch"],
) {
  const server = serve({ fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture HTTP port");
  return {
    host: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
