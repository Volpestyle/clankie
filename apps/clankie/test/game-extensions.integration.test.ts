import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileCredentialStore, ensureOperatorCredential } from "@clankie/credential-broker";
import { GameExtensionRegistry } from "@clankie/game-extension";
import { minecraftExtension, minecraftProjection } from "@clankie/minecraft";
import { MinecraftMcpPort } from "@clankie/minecraft/connector";
import { pokemonExtension } from "@clankie/pokemon";
import { GAME_EXTENSIONS_PATH } from "@clankie/protocol";
import { SettingsStore } from "@clankie/settings";
import { expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createCredentialBackedOperatorAuthenticator } from "../src/operator-auth.ts";
import { startFixtureServer } from "./owner-settings-surface-fixture.ts";
import { runGameExtensionsCommand } from "../../tui/src/command/games.ts";
import { BodyLeaseStore } from "../src/body-leases.ts";
import type { GameExtensionProjection } from "../src/game-extension-projection.ts";

it("discovers registered games over real owner-authenticated HTTP and CLI without connector access", async () => {
  const root = await mkdtemp(join(tmpdir(), "game-extension-discovery-"));
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  await ensureOperatorCredential({ env: {}, store: credentials });
  const registry = new GameExtensionRegistry<GameExtensionProjection>();
  const leases = new BodyLeaseStore(join(root, "leases"));
  let connectorCalls = 0;
  registry.register(
    minecraftExtension,
    {
      store: leases,
      path: join(root, "minecraft.json"),
      port: new MinecraftMcpPort({
        profiles: async () => [],
        resolveProfile: async () => {
          throw new Error("no_profile_approved");
        },
        call: async () => {
          connectorCalls++;
          throw new Error("must_not_dial");
        },
      }),
    },
    (runtime) => minecraftProjection(runtime, () => undefined),
  );
  let modelCalls = 0;
  const host = {
    logger: { info() {}, warn() {} },
    gameplay: pokemonExtension.settings.schema.parse({ pokeagentMmoEnabled: false }),
    resolveMind: async () => {
      modelCalls++;
      throw new Error("must_not_call_a_model");
    },
  };
  registry.register(pokemonExtension, host);
  const service = await createClankieApp({
    captain: createStubCaptain({
      seatContext: () => ({ conversationId: "fixture-owner", cwd: root }),
      validateConversationOwner: async (owner) => owner.conversationId === "fixture-owner",
    }),
    settings: new SettingsStore(join(root, "settings.json")),
    gameExtensions: registry,
    authenticateOperator: createCredentialBackedOperatorAuthenticator({
      env: {},
      store: credentials,
      identity: { operatorId: "fixture-owner" },
    }),
  });
  const server = await startFixtureServer(service.app.fetch);
  try {
    expect((await fetch(server.host + GAME_EXTENSIONS_PATH)).status).toBe(401);
    expect(
      (await fetch(server.host + GAME_EXTENSIONS_PATH, { headers: { authorization: "Bearer wrong-owner" } }))
        .status,
    ).toBe(401);
    const options = { env: {}, host: server.host, operatorCredentialStore: credentials };
    const catalog = await runGameExtensionsCommand(options);
    expect(catalog.extensions).toMatchObject([
      { id: "minecraft", status: { state: "idle" }, settings: { key: "minecraft" } },
      { id: "pokemon", status: { state: "idle" }, health: { state: "ready" }, settings: { key: "gameplay" } },
    ]);
    expect(JSON.stringify(catalog)).not.toContain("credentials");
    expect(modelCalls).toBe(0);
    expect(connectorCalls).toBe(0);
    expect(
      registry
        .projections()
        .flatMap((projection) => projection.tools({}))
        .map((tool) => tool.name),
    ).toContain("minecraft_join");
    const { resolveOperatorCredential } = await import("@clankie/credential-broker");
    const credential = (await resolveOperatorCredential({ env: {}, store: credentials }))!;
    const headers = {
      authorization: `Bearer ${credential.token}`,
      "content-type": "application/json",
      "x-clankie-conversation-id": "fixture-owner",
    };
    expect((await fetch(server.host + "/v1/minecraft/configuration")).status).toBe(403);
    expect((await fetch(server.host + "/v1/minecraft/configuration", { headers })).status).toBe(200);
    const saved = await fetch(server.host + "/v1/minecraft/configuration", {
      method: "PUT",
      headers,
      body: JSON.stringify({ profiles: [], play: { enabled: false } }),
    });
    expect(saved.status).toBe(200);
    expect((await new SettingsStore(join(root, "settings.json")).load()).minecraft.play.enabled).toBe(false);
    await registry.unregister("minecraft");
    expect(registry.projections()).toEqual([]);
    expect((await fetch(server.host + "/v1/minecraft/configuration", { headers })).status).toBe(404);
    expect(() => registry.register(pokemonExtension, host)).toThrow("game_extension_already_registered");
    await registry.unregister("pokemon");
    expect((await runGameExtensionsCommand(options)).extensions).toEqual([]);
    registry.register(pokemonExtension, host);
    expect((await runGameExtensionsCommand(options)).extensions.map((entry) => entry.id)).toEqual([
      "pokemon",
    ]);
    expect(modelCalls).toBe(0);
  } finally {
    service.close();
    await server.close();
    leases.close();
    await rm(root, { recursive: true, force: true });
  }
});
