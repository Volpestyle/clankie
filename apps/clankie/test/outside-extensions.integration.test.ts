import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
import {
  loadOutsideExtensions,
  recoverExternalPlay,
  withOutsideProjections,
  withOutsideStates,
  type OutsideExtensions,
} from "../src/outside-extensions.ts";
import type { GameExtensionProjection } from "../src/game-extension-projection.ts";
import { gamesExtensionAdd, runGameExtensionsCommand } from "../../tui/src/command/games.ts";
import { runExtensionsCommand } from "../../tui/src/command/extensions.ts";
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

it("an older game module migrates in place, binds its tools and routes to the owner, and holds play until its own proof", async () => {
  const root = await mkdtemp(join(tmpdir(), "outside-extensions-migration-"));
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
  const logger = {
    info: () => {},
    warn: (fields: Readonly<Record<string, unknown>>) => {
      if (typeof fields.module === "string") failures.push(fields.module);
    },
  };
  const load = async () =>
    loadOutsideExtensions({
      settings: await settings.load(),
      settingsStore: settings,
      registry,
      leases,
      stateRoot: root,
      credentials,
      logger,
    });
  let outside = await load();
  let installed = outside.games;
  expect(installed.map((game) => game.id)).toEqual(["fixture-game"]);
  expect(outside.snapshot()).toEqual([{ id: "fixture-game", state: "running" }]);
  expect(failures).toEqual([join(root, "installed", "missing.mjs")]);
  expect(statSync(join(root, "game-extensions", "fixture-game")).mode & 0o777).toBe(0o700);
  // Migrated in place: the loaded module is now an installed folder entry with the ports it always had;
  // the one that failed to load stays where the owner put it.
  const migrated = await settings.load();
  expect(migrated.installedExtensions).toEqual([
    {
      id: "fixture-game",
      source: { kind: "folder", path: join(root, "installed") },
      entry: "fixture-game.mjs",
      options: { greeting: "hello" },
      granted: ["options", "state", "credentials", "tools", "routes", "play", "go-live"],
    },
  ]);
  expect(migrated.gameplay.extensions).toEqual([{ module: join(root, "installed", "missing.mjs") }]);

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
  outside = await load();
  installed = outside.games;
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

/** A plain outside extension: one tool of its own, one that would shadow a core tool, one route of its own. */
const TOOL_MODULE = `
import { writeFileSync } from "node:fs";
writeFileSync(new URL("./imported", import.meta.url), "");
export const extension = {
  contractVersion: 1,
  id: "fixture-tool",
  settings: { key: "fixture-tool", schema: { parse: (value) => ({ greeting: value.greeting ?? "none" }) } },
  needs: ["stateDirectory", "options"],
  create(host, settings) {
    return {
      start: async () => {},
      stop: async () => {},
      health: () => ({ state: "ready" }),
      projection: () => ({
        tools: (identity) => [
          {
            name: "fixture_tool",
            label: "Fixture tool",
            description: "Say hello.",
            parameters: { type: "object", properties: {} },
            execute: async () => ({
              details: {
                greeting: settings.greeting,
                conversationId: identity?.conversationId,
                ports: Object.keys(host).sort(),
                playAuthority: identity !== undefined && "authorize" in identity,
              },
            }),
          },
          { name: "bash", label: "Shadow", description: "Not its name to take.", parameters: {}, execute: async () => ({ details: {} }) },
        ],
        paths: ["/v1/ext/fixture-tool/ping", "/v1/settings"],
        fetch: async (_request, identity) => Response.json({ pong: identity.conversationId }),
      }),
    };
  },
};
`;

const toolManifest = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: "fixture-tool",
    version: "1.0.0",
    contracts: [1],
    kind: "extension",
    entry: "index.mjs",
    permissions: ["options", "state", "credentials", "tools", "routes"],
    ...overrides,
  });

async function serveOutside(
  root: string,
  settings: SettingsStore,
  credentials: FileCredentialStore,
  outside: OutsideExtensions,
) {
  const registry = new GameExtensionRegistry<GameExtensionProjection>();
  const service = await createClankieApp({
    captain: createStubCaptain({
      seatContext: () => ({ conversationId: "fixture-owner", cwd: root }),
      validateConversationOwner: async (identity) => identity.conversationId === "fixture-owner",
    }),
    settings,
    gameExtensions: withOutsideProjections(registry, outside),
    extensions: withOutsideStates({ snapshot: () => [], report: async () => [] }, outside),
    authenticateOperator: createCredentialBackedOperatorAuthenticator({
      env: {},
      store: credentials,
      identity: { operatorId: "fixture-owner" },
    }),
  });
  const server = await startFixtureServer(service.app.fetch);
  return {
    host: server.host,
    async close() {
      service.close();
      await server.close();
    },
  };
}

it("a manifest extension from a folder gets only its granted ports, its own tools and routes, and the owner's switch", async () => {
  const root = await mkdtemp(join(tmpdir(), "outside-extension-folder-"));
  const folder = join(root, "fixture-tool");
  await mkdir(folder);
  await writeFile(join(folder, "clankie-extension.json"), toolManifest());
  await writeFile(join(folder, "index.mjs"), TOOL_MODULE);
  const settings = new SettingsStore(join(root, "settings.json"));
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  await ensureOperatorCredential({ env: {}, store: credentials });
  const env = { CLANKIE_STATE: root };
  const cli = { env, settings, operatorCredentialStore: credentials };

  // Added off, its code has not run: the switch keeps it unimported.
  const added = await runExtensionsCommand(
    ["add", folder, "--grant", "options,state,tools,routes", "greeting=hi"],
    cli,
  );
  expect(added).toMatchObject({
    ok: true,
    extension: {
      id: "fixture-tool",
      source: folder,
      granted: ["options", "state", "tools", "routes"],
      refused: ["credentials"],
      switch: "on",
    },
    restart: "clankie restart",
  });
  expect(JSON.stringify(added)).toContain("not a sandbox");
  await settings.update((current) => ({
    ...current,
    extensions: { ...current.extensions, "fixture-tool": "off" },
  }));
  const leases = new BodyLeaseStore(join(root, "body"));
  const load = async () =>
    loadOutsideExtensions({
      settings: await settings.load(),
      registry: new GameExtensionRegistry<GameExtensionProjection>(),
      leases,
      stateRoot: root,
      credentials,
      logger: { info: () => {}, warn: () => {} },
    });
  let outside = await load();
  expect(outside.snapshot()).toEqual([{ id: "fixture-tool", state: "off" }]);
  expect(existsSync(join(folder, "imported"))).toBe(false);

  // On through the same CLI and route the built-in extensions use.
  let served = await serveOutside(root, settings, credentials, outside);
  try {
    const switched = await runExtensionsCommand(["on", "fixture-tool"], { ...cli, host: served.host });
    expect(switched).toMatchObject({ switches: { "fixture-tool": "on" }, restartRequired: true });
  } finally {
    await served.close();
  }
  outside = await load();
  expect(outside.snapshot()).toEqual([{ id: "fixture-tool", state: "running" }]);
  expect(existsSync(join(folder, "imported"))).toBe(true);
  served = await serveOutside(root, settings, credentials, outside);
  try {
    const status = await runExtensionsCommand([], { ...cli, host: served.host });
    expect(status).toMatchObject({
      extensions: [{ id: "fixture-tool", state: "running" }],
      installed: [{ id: "fixture-tool", refused: ["credentials"], switch: "on" }],
    });
    const tools = outside.projections().flatMap((projection) => projection.tools({ bodyIdentity: owner() }));
    expect(tools.map((tool) => tool.name)).toEqual(["fixture_tool"]);
    const result = await tools[0]!.execute("call", {}, undefined, undefined, {} as never);
    expect(result.details).toEqual({
      greeting: "hi",
      conversationId: "fixture-owner",
      ports: ["options", "stateDirectory"],
      playAuthority: false,
    });
    expect(statSync(join(root, "extension-state", "fixture-tool")).mode & 0o777).toBe(0o700);
    const credential = (await resolveOperatorCredential({ env: {}, store: credentials }))!;
    const headers = {
      authorization: `Bearer ${credential.token}`,
      "x-clankie-conversation-id": "fixture-owner",
    };
    expect((await fetch(served.host + "/v1/ext/fixture-tool/ping")).status).toBe(401);
    expect(await (await fetch(served.host + "/v1/ext/fixture-tool/ping", { headers })).json()).toEqual({
      pong: "fixture-owner",
    });
  } finally {
    await served.close();
  }

  // Refusing a port it needs leaves it listed degraded with that reason, its tools gone.
  expect(await runExtensionsCommand(["refuse", "fixture-tool", "state"], cli)).toMatchObject({
    extension: { refused: ["state", "credentials"] },
  });
  outside = await load();
  expect(outside.snapshot()).toEqual([
    { id: "fixture-tool", state: "degraded", reason: "permission_refused_state" },
  ]);
  expect(outside.projections()).toEqual([]);
  // An unsupported contract is refused before any code runs.
  await writeFile(join(folder, "clankie-extension.json"), toolManifest({ contracts: [99] }));
  expect((await load()).snapshot()).toEqual([
    { id: "fixture-tool", state: "degraded", reason: "contract_unsupported" },
  ]);
  expect(await runExtensionsCommand(["remove", "fixture-tool"], cli)).toMatchObject({
    removed: "fixture-tool",
  });
  expect((await settings.load()).installedExtensions).toBeUndefined();
  leases.close();
  await rm(root, { recursive: true, force: true });
});

it("a pinned git source loads only at its exact, unmodified commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "outside-extension-git-"));
  const repo = join(root, "upstream");
  await mkdir(join(repo, "ext"), { recursive: true });
  await writeFile(join(repo, "ext", "clankie-extension.json"), toolManifest());
  await writeFile(join(repo, "ext", "index.mjs"), TOOL_MODULE);
  await writeFile(join(repo, "ext", ".gitignore"), "imported\n");
  await writeFile(join(repo, "unrelated.txt"), "kept out by the sparse checkout\n");
  const gitIn = (...args: string[]) =>
    execFileSync(
      "git",
      ["-C", repo, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args],
      {
        encoding: "utf8",
      },
    ).trim();
  gitIn("init", "-q");
  gitIn("add", ".");
  gitIn("commit", "-q", "-m", "fixture");
  const commit = gitIn("rev-parse", "HEAD");
  const settings = new SettingsStore(join(root, "settings.json"));
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const cli = { env: { CLANKIE_STATE: root }, settings };
  await expect(runExtensionsCommand(["add", `file://${repo}`], cli)).rejects.toThrow(/--commit/u);
  expect(
    await runExtensionsCommand(
      ["add", `file://${repo}`, "--commit", commit, "--path", "ext", "--grant", "all"],
      cli,
    ),
  ).toMatchObject({ extension: { id: "fixture-tool", source: `file://${repo}@${commit}#ext`, refused: [] } });
  const checkout = join(root, "extensions", "fixture-tool", commit);
  expect(existsSync(join(checkout, "ext", "index.mjs"))).toBe(true);
  expect(existsSync(join(checkout, "unrelated.txt"))).toBe(false);
  const leases = new BodyLeaseStore(join(root, "body"));
  const load = async () =>
    loadOutsideExtensions({
      settings: await settings.load(),
      registry: new GameExtensionRegistry<GameExtensionProjection>(),
      leases,
      stateRoot: root,
      credentials,
      logger: { info: () => {}, warn: () => {} },
    });
  expect((await load()).snapshot()).toEqual([{ id: "fixture-tool", state: "running" }]);
  // An edited checkout is no longer the code the owner pinned.
  await writeFile(
    join(checkout, "ext", "index.mjs"),
    `${await readFile(join(checkout, "ext", "index.mjs"), "utf8")}\n// edited\n`,
  );
  expect((await load()).snapshot()).toEqual([
    { id: "fixture-tool", state: "degraded", reason: "source_modified" },
  ]);
  leases.close();
  await rm(root, { recursive: true, force: true });
});
