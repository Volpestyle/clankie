import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  FileCredentialStore,
  ensureOperatorCredential,
  resolveOperatorCredential,
} from "@clankie/credential-broker";
import { GameExtensionRegistry } from "@clankie/game-extension";
import { SettingsStore } from "@clankie/settings";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createCredentialBackedOperatorAuthenticator } from "../src/operator-auth.ts";
import { BodyLeaseStore } from "../src/body-leases.ts";
import { BodyLeaseRouter, type BodyConversationIdentity } from "../src/body-lease-router.ts";
import { loadGameExtensionModules, recoverExternalPlay } from "../src/game-extension-modules.ts";
import type { GameExtensionProjection } from "../src/game-extension-projection.ts";
import { gamesExtensionAdd, runGameExtensionsCommand } from "../../tui/src/command/games.ts";
import { startFixtureServer } from "./owner-settings-surface-fixture.ts";

/**
 * An extension installed outside this repository, importing nothing from it.
 * Its connector "loses" the sitting before termination proof, and a `stopped`
 * file in its state directory stands in for exact connector cleanup evidence.
 */
const FIXTURE_MODULE = `
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export const gameExtensionApis = [1];
export const gameExtension = {
  contractVersion: 1,
  id: "fixture-game",
  connector: { kind: "skill", sessionServer: "fixture-server" },
  skill: { name: "fixture-game", path: "skill/SKILL.md" },
  settings: { key: "gameplay.extensions", schema: { parse: (value) => value } },
  activity: null,
  create(host) {
    const claim = join(host.stateDirectory, "claim.json");
    const stopped = join(host.stateDirectory, "stopped");
    const confirmed = join(host.stateDirectory, "confirmed");
    const owns = () => existsSync(claim) && !existsSync(confirmed);
    const native = host.createRuntime(async () => {});
    return {
      ...native,
      status: () => (owns() ? { state: "uncertain", sessionId: "fixture" } : native.status()),
      health: () => (owns() ? { state: "degraded", reason: "termination_unconfirmed" } : native.health()),
      service: {
        owns,
        async recover(guard) {
          await guard();
          if (!existsSync(stopped)) return false;
          writeFileSync(confirmed, "");
          return true;
        },
        async start(identity) {
          if (!(await identity.authorize("play", "effect"))) return { outcome: "refused" };
          const acquired = host.leases.acquire("play", identity.conversationId, 30000, identity.route);
          if (acquired.outcome !== "acquired") return { outcome: "refused", reason: "play_session_active" };
          const begun = host.leases.begin(acquired.lease);
          writeFileSync(claim, "{}");
          host.leases.finish(acquired.lease, begun.operationId, "uncertain");
          return {
            outcome: "started",
            greeting: host.options.greeting,
            ownCredential: (await host.credential("fixture-game-token")) === "fixture-secret",
            foreignCredential: (await host.credential("other-secret")) !== undefined,
          };
        },
      },
    };
  },
};
export function projectGameExtension(runtime) {
  const service = runtime.service;
  return {
    paths: ["/v1/fixture-game"],
    tools: (identity) => [
      {
        name: "fixture_game",
        label: "Fixture game",
        description: "Start the fixture game.",
        parameters: { type: "object", properties: {} },
        execute: async () => ({
          details: identity ? await service.start(identity) : { outcome: "refused", reason: "identity_required" },
        }),
      },
    ],
    fetch: async (request, identity) =>
      Response.json({ method: request.method, conversationId: identity.conversationId }),
    play: { owns: service.owns, recover: service.recover },
  };
}
`;

const owner = (conversationId = "fixture-owner"): BodyConversationIdentity => ({
  conversationId,
  current: () => true,
  authorize: async () => true,
  route: { owner: { conversationId }, mode: "machine" },
});

it("an owner-installed module registers, binds its tools and routes to the owner, and holds play until its own proof", async () => {
  const root = await mkdtemp(join(tmpdir(), "game-extension-modules-"));
  const modulePath = join(root, "installed", "fixture-game.mjs");
  await mkdir(join(root, "installed"));
  await writeFile(modulePath, FIXTURE_MODULE);
  const settings = new SettingsStore(join(root, "settings.json"));
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  await ensureOperatorCredential({ env: {}, store: credentials });
  await credentials.set("fixture-game-token", { type: "api", key: "fixture-secret" });
  await credentials.set("other-secret", { type: "api", key: "not-for-this-extension" });
  // The CLI install path writes the owner setting the service reads at start.
  await gamesExtensionAdd(modulePath, { greeting: "hello" }, { settings });
  await gamesExtensionAdd(join(root, "installed", "missing.mjs"), {}, { settings });
  let leases = new BodyLeaseStore(join(root, "body"));
  let registry = new GameExtensionRegistry<GameExtensionProjection>();
  const failures: string[] = [];
  const load = async () =>
    loadGameExtensionModules({
      entries: (await settings.load()).gameplay.extensions ?? [],
      registry,
      leases,
      stateRoot: root,
      credentials,
      onError: (module) => failures.push(module),
    });
  let installed = await load();
  expect(installed.map((game) => game.id)).toEqual(["fixture-game"]);
  expect(failures).toEqual([join(root, "installed", "missing.mjs")]);
  expect(statSync(join(root, "game-extensions", "fixture-game")).mode & 0o777).toBe(0o700);

  const service = await createClankieApp({
    captain: createStubCaptain({
      seatContext: () => ({ conversationId: "fixture-owner", cwd: root }),
      validateConversationOwner: async (identity) => identity.conversationId === "fixture-owner",
    }),
    settings,
    gameExtensions: registry,
    authenticateOperator: createCredentialBackedOperatorAuthenticator({
      env: {},
      store: credentials,
      identity: { operatorId: "fixture-owner" },
    }),
  });
  const server = await startFixtureServer(service.app.fetch);
  try {
    const options = { env: {}, host: server.host, operatorCredentialStore: credentials };
    expect((await runGameExtensionsCommand(options)).extensions).toMatchObject([
      { id: "fixture-game", settings: { key: "gameplay.extensions" }, status: { state: "idle" } },
    ]);
    expect((await fetch(server.host + "/v1/fixture-game", { method: "POST" })).status).toBe(401);
    const credential = (await resolveOperatorCredential({ env: {}, store: credentials }))!;
    const routed = await fetch(server.host + "/v1/fixture-game", {
      method: "POST",
      headers: { authorization: `Bearer ${credential.token}`, "x-clankie-conversation-id": "fixture-owner" },
    });
    expect(await routed.json()).toEqual({ method: "POST", conversationId: "fixture-owner" });

    const [tool] = registry
      .projections()
      .flatMap((projection) => projection.tools({ bodyIdentity: owner() }));
    expect(tool?.name).toBe("fixture_game");
    const started = await tool!.execute("call", {}, undefined, undefined, {} as never);
    expect(started.details).toEqual({
      outcome: "started",
      greeting: "hello",
      ownCredential: true,
      foreignCredential: false,
    });
    expect(JSON.stringify(started.content)).not.toContain("fixture-secret");
    expect(leases.acquire("play", "another-game", 30_000).outcome).toBe("busy");
  } finally {
    service.close();
    await server.close();
  }

  // A real ledger restart: the claim survives, and so does the extension's uncertainty.
  leases.close();
  leases = new BodyLeaseStore(join(root, "body"));
  registry = new GameExtensionRegistry<GameExtensionProjection>();
  installed = await load();
  expect((await registry.catalog()).extensions[0]?.status.state).toBe("uncertain");
  const recover = () =>
    new BodyLeaseRouter(leases).recover(owner(), "play", async (guard) => {
      const external = await recoverExternalPlay(installed, registry, guard);
      if (external === undefined) throw new Error("fixture claim must belong to the extension");
      return external;
    });
  expect(await recover()).toMatchObject({ reason: "recovery_required" });
  expect(leases.acquire("play", "another-game", 30_000).outcome).toBe("busy");
  await writeFile(join(root, "game-extensions", "fixture-game", "stopped"), "");
  expect(await recover()).toMatchObject({ outcome: "released" });
  expect((await registry.catalog()).extensions[0]?.status.state).toBe("idle");
  expect(await recoverExternalPlay(installed, registry, async () => {})).toBeUndefined();
  leases.close();
  await rm(root, { recursive: true, force: true });
});
