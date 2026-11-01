import { execFile } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Hono } from "hono";
import { Type } from "typebox";
import {
  ExtensionSupervisor,
  GAME_EXTENSION_MODULE_API,
  GAME_MODULE_PERMISSIONS,
  OUTSIDE_PORT_PERMISSION,
  negotiateContract,
  ownsRoutePath,
  ownsToolName,
  readExtensionManifest,
  type ClankieExtension,
  type ExtensionManifest,
  type ExtensionReport,
  type ExtensionRuntime,
  type ExtensionTool,
  type OutsideConversationIdentity,
  type OutsideExtension,
  type OutsidePermission,
  type OutsidePorts,
  type OutsideProjection,
} from "@clankie/extension";
import {
  createGameExtensionRuntime,
  type GameExtension,
  type GameExtensionModuleHost,
  type GameExtensionModuleProjection,
  type GameExtensionRuntime,
  type PlayLeaseAuthority,
} from "@clankie/game-extension";
import type { CredentialStore } from "@clankie/credential-broker";
import type { ClankieSettings, InstalledExtension, SettingsStore } from "@clankie/settings";
import type { GameExtensionProjection, InstalledGameExtensions } from "./game-extension-projection.ts";

const run = promisify(execFile);

/**
 * Ids the service's own extensions and games use. An outside extension may not
 * take one: the owner's switch and the state list key on the id.
 */
const BUILT_IN_IDS = new Set([
  "relay",
  "browser",
  "computer",
  "media",
  "tracker-linear",
  "world",
  "voice",
  "persona",
  "pokemon",
  "minecraft",
]);

/** An installed outside game, for host-owned play recovery. */
export interface InstalledGameExtensionModule {
  readonly id: string;
  readonly play?: GameExtensionModuleProjection["play"];
}

/** What the composition root reads back from the loader. */
export interface OutsideExtensions {
  /** Each outside extension's state: running, degraded with a fixed reason, or off. */
  snapshot(): readonly ExtensionReport[];
  report(): Promise<readonly ExtensionReport[]>;
  /** Tools and routes of running `kind: "extension"` ones. Games project through the game registry. */
  projections(): readonly GameExtensionProjection[];
  /** Running outside games, for restart recovery of the shared play lease. */
  readonly games: readonly InstalledGameExtensionModule[];
  stop(): Promise<void>;
}

export interface OutsideExtensionLoadInput {
  readonly settings: Pick<ClankieSettings, "extensions" | "installedExtensions" | "gameplay">;
  /** Writes the in-place migration of `gameplay.extensions`; without it the migration is in memory only. */
  readonly settingsStore?: Pick<SettingsStore, "update">;
  readonly registry: InstalledGameExtensions;
  readonly leases: PlayLeaseAuthority;
  readonly stateRoot: string;
  readonly credentials: Pick<CredentialStore, "get">;
  /** Asks his active Discord body to go live; the persona's body fills it (ADR 0328). */
  readonly goLive?: GameExtensionModuleHost["goLive"];
  readonly logger: {
    info(fields: Readonly<Record<string, unknown>>, message: string): void;
    warn(fields: Readonly<Record<string, unknown>>, message: string): void;
  };
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

/** A fixed reason code for the state list; never a module's own message. */
class Unavailable extends Error {}
const unavailable = (reason: string): never => {
  throw new Unavailable(reason);
};

/** Where `clankie extensions add` puts a pinned git source. */
function extensionCheckout(stateRoot: string, id: string, commit: string): string {
  return join(stateRoot, "extensions", id, commit);
}

/**
 * Loads the owner's outside extensions (ADR 0338): `installedExtensions`, plus
 * the older `gameplay.extensions` game modules, which migrate in place. Each
 * one's manifest is read before its code runs; it receives only the ports the
 * owner granted; its failures stay inside its own supervisor entry; its
 * switch in `extensions` keeps it off without importing anything.
 */
export async function loadOutsideExtensions(input: OutsideExtensionLoadInput): Promise<OutsideExtensions> {
  const items = await migrateGameModules(input);
  const supervisor = new ExtensionSupervisor<object, GameExtensionProjection>({
    ports: {},
    onDegraded: (id, reason) =>
      input.logger.warn(
        { event: "extension.degraded", extension: id, reason, outside: true },
        "an outside extension stopped working",
      ),
  });
  const games: InstalledGameExtensionModule[] = [];
  for (const item of items) {
    const placeholder = (reason?: string) =>
      supervisor.add(inertExtension(item.id), {
        enabled: reason !== undefined,
        settings: undefined,
        ...(reason === undefined ? {} : { unavailable: reason }),
      });
    if (BUILT_IN_IDS.has(item.id)) {
      placeholder("id_reserved");
      continue;
    }
    if (input.settings.extensions[item.id] === "off") {
      placeholder();
      continue;
    }
    try {
      const prepared = await prepare(item, input);
      supervisor.add(
        prepared.kind === "game"
          ? gameWrapper(item, prepared, input, games)
          : extensionWrapper(item, prepared, input),
        { enabled: true, settings: item.options ?? {} },
      );
    } catch (error) {
      if (!(error instanceof Unavailable))
        input.logger.warn(
          { event: "extension.outside_unavailable", extension: item.id },
          "An outside extension did not load",
        );
      placeholder(error instanceof Unavailable ? error.message : "load_failed");
    }
  }
  await supervisor.start();
  for (const report of supervisor.snapshot())
    input.logger.info(
      { event: "extension.outside", extension: report.id, state: report.state, reason: report.reason },
      "Outside extension",
    );
  return {
    snapshot: () => supervisor.snapshot(),
    report: () => supervisor.report(),
    projections: () => supervisor.projections(),
    games,
    stop: () => supervisor.stop(),
  };
}

/**
 * The game modules installed by absolute path before manifests existed become
 * `installedExtensions` folder entries with the ports they always had. Their id
 * is only known from the module itself, so this imports each one once.
 */
async function migrateGameModules(input: OutsideExtensionLoadInput): Promise<readonly InstalledExtension[]> {
  const installed = [...(input.settings.installedExtensions ?? [])];
  const legacy = input.settings.gameplay.extensions ?? [];
  if (legacy.length === 0) return installed;
  const migrated: string[] = [];
  for (const entry of legacy) {
    try {
      const loaded: unknown = await import(pathToFileURL(entry.module).href);
      const id = record(loaded) && record(loaded.gameExtension) ? loaded.gameExtension.id : undefined;
      if (typeof id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(id))
        throw new Error("game_extension_module_id_invalid");
      migrated.push(entry.module);
      if (installed.some((item) => item.id === id)) continue;
      const folder = packageFolder(entry.module);
      installed.push({
        id,
        source: { kind: "folder", path: folder },
        entry: relative(folder, entry.module).split(sep).join("/"),
        ...(entry.options === undefined ? {} : { options: entry.options }),
        granted: [...GAME_MODULE_PERMISSIONS],
      });
    } catch (error) {
      input.logger.warn(
        {
          event: "game_extension.module_unavailable",
          module: entry.module,
          error: error instanceof Error ? error.message : "",
        },
        "Installed game extension did not load",
      );
    }
  }
  if (migrated.length > 0 && input.settingsStore !== undefined) {
    try {
      await input.settingsStore.update((current) => {
        const kept = (current.gameplay.extensions ?? []).filter((entry) => !migrated.includes(entry.module));
        const { extensions: _old, ...gameplay } = current.gameplay;
        const ids = new Set((current.installedExtensions ?? []).map((item) => item.id));
        return {
          ...current,
          gameplay: kept.length === 0 ? gameplay : { ...gameplay, extensions: kept },
          installedExtensions: [
            ...(current.installedExtensions ?? []),
            ...installed.filter(
              (item) => !ids.has(item.id) && !(input.settings.installedExtensions ?? []).includes(item),
            ),
          ],
        };
      });
      input.logger.info(
        { event: "extension.outside_migrated", modules: migrated.length },
        "Moved installed game modules to installedExtensions",
      );
    } catch {
      input.logger.warn(
        { event: "extension.outside_migration_failed" },
        "Installed game modules load this time but stay in gameplay.extensions",
      );
    }
  }
  return installed;
}

/** The nearest folder above a module with a package.json, else the module's own folder. */
function packageFolder(module: string): string {
  let folder = dirname(module);
  for (let depth = 0; depth < 4; depth++) {
    if (existsSync(join(folder, "package.json"))) return folder;
    const parent = dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  return dirname(module);
}

interface Prepared {
  readonly kind: ExtensionManifest["kind"];
  readonly granted: ReadonlySet<OutsidePermission>;
  readonly module: Record<string, unknown>;
}

/** Source, manifest, grants and import, in that order; nothing runs before the grants are known. */
async function prepare(item: InstalledExtension, input: OutsideExtensionLoadInput): Promise<Prepared> {
  const folder = await sourceFolder(item, input.stateRoot);
  let manifest: ExtensionManifest | undefined;
  try {
    manifest = readExtensionManifest(folder);
  } catch (error) {
    unavailable(
      error instanceof Error && /^manifest_[a-z_]+$/u.test(error.message)
        ? error.message
        : "manifest_invalid",
    );
  }
  let kind: ExtensionManifest["kind"];
  let entry: string;
  let asked: readonly OutsidePermission[];
  if (manifest !== undefined) {
    if (manifest.id !== item.id) unavailable("id_mismatch");
    if (negotiateContract(manifest) === undefined) unavailable("contract_unsupported");
    ({ kind, entry } = manifest);
    asked = manifest.permissions;
  } else if (item.entry !== undefined) {
    // The previous form: a game module of API 1 with no manifest.
    kind = "game";
    entry = item.entry;
    asked = GAME_MODULE_PERMISSIONS;
  } else return unavailable("manifest_missing");
  const granted = new Set(asked.filter((permission) => item.granted.includes(permission)));
  if (kind === "game" && !granted.has("play")) unavailable("permission_refused_play");
  const entryPath = join(folder, entry);
  if (!existsSync(entryPath) || !statSync(entryPath).isFile()) unavailable("entry_missing");
  const real = realpathSync(entryPath);
  const root = realpathSync(folder);
  if (!real.startsWith(root + sep)) unavailable("entry_outside_folder");
  let module: unknown;
  try {
    module = await import(pathToFileURL(real).href);
  } catch {
    return unavailable("import_failed");
  }
  if (!record(module)) return unavailable("module_invalid");
  return { kind, granted, module };
}

async function sourceFolder(item: InstalledExtension, stateRoot: string): Promise<string> {
  if (item.source.kind === "folder") {
    if (!existsSync(item.source.path) || !statSync(item.source.path).isDirectory())
      unavailable("source_missing");
    return item.source.path;
  }
  const checkout = extensionCheckout(stateRoot, item.id, item.source.commit);
  if (!existsSync(join(checkout, ".git"))) return unavailable("source_not_fetched");
  const git = async (...args: string[]) =>
    (await run("git", ["-C", checkout, ...args], { timeout: 10_000, encoding: "utf8" })).stdout.trim();
  try {
    // Never a moving ref: the checkout must still be the exact pinned commit, unchanged.
    if ((await git("rev-parse", "HEAD")) !== item.source.commit) unavailable("source_pin_mismatch");
    if ((await git("status", "--porcelain", "--untracked-files=no")) !== "") unavailable("source_modified");
  } catch (error) {
    if (error instanceof Unavailable) throw error;
    unavailable("source_unreadable");
  }
  const folder = item.source.path === undefined ? checkout : join(checkout, item.source.path);
  if (!existsSync(folder)) unavailable("source_missing");
  return folder;
}

/** Only the granted ports, each scoped to this extension. */
function scopedPorts(
  id: string,
  stateDirectory: string,
  granted: ReadonlySet<OutsidePermission>,
  item: InstalledExtension,
  input: OutsideExtensionLoadInput,
): Partial<OutsidePorts> {
  const ports: Partial<OutsidePorts> = {};
  if (granted.has("options")) Object.assign(ports, { options: Object.freeze({ ...item.options }) });
  if (granted.has("state")) {
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    Object.assign(ports, { stateDirectory });
  }
  if (granted.has("credentials"))
    Object.assign(ports, {
      async credential(name: string) {
        // Only its own broker namespace: `ID` or `ID-*`.
        if (name !== id && !name.startsWith(`${id}-`)) return undefined;
        const credential = await input.credentials.get(name);
        return credential?.type === "api" ? credential.key : undefined;
      },
    });
  return ports;
}

/** Placeholder entry for an extension that is off or could not load; never created. */
function inertExtension(id: string): ClankieExtension<undefined, object, never, GameExtensionProjection> {
  return {
    contractVersion: 1,
    id,
    settings: { key: `installedExtensions.${id}`, schema: { parse: () => undefined } },
    needs: [],
    create: () => unavailable("unavailable"),
  };
}

function gameWrapper(
  item: InstalledExtension,
  prepared: Prepared,
  input: OutsideExtensionLoadInput,
  games: InstalledGameExtensionModule[],
): ClankieExtension<unknown, object, never, GameExtensionProjection> {
  const { module, granted } = prepared;
  const apis = module.gameExtensionApis;
  if (!Array.isArray(apis) || !apis.includes(GAME_EXTENSION_MODULE_API)) unavailable("game_api_unsupported");
  const extension = module.gameExtension;
  const project = module.projectGameExtension;
  if (!record(extension) || typeof extension.create !== "function" || typeof project !== "function")
    unavailable("game_exports_required");
  if ((extension as Record<string, unknown>).id !== item.id) unavailable("id_mismatch");
  return {
    contractVersion: 1,
    id: item.id,
    settings: { key: `installedExtensions.${item.id}`, schema: { parse: (value) => value } },
    needs: [],
    create() {
      // Games keep the state directory they always had, where restart recovery reads its receipt.
      const host = {
        ...scopedPorts(item.id, join(input.stateRoot, "game-extensions", item.id), granted, item, input),
        leases: input.leases,
        createRuntime: createGameExtensionRuntime,
        ...(granted.has("go-live") ? { goLive: goLivePort(input) } : {}),
      } as GameExtensionModuleHost;
      let projection: GameExtensionModuleProjection | undefined;
      const runtime = input.registry.register(
        extension as unknown as GameExtension<
          { sessionId: string },
          unknown,
          unknown,
          GameExtensionModuleHost
        > & {
          create(host: GameExtensionModuleHost): GameExtensionRuntime<{ sessionId: string }, unknown>;
        },
        Object.freeze(host),
        () =>
          hostProjection(
            item.id,
            "game",
            granted,
            () => projection,
            (identity) => identity,
          ),
      );
      try {
        // The projection steers through the registered runtime, which keeps the registry's admission fence.
        projection = (project as (runtime: unknown) => GameExtensionModuleProjection)(runtime);
      } catch (error) {
        // allow-swallowed-rejection -- the projection error is rethrown; a busy runtime keeps its registration
        void input.registry.unregister(item.id).catch(() => undefined);
        throw error;
      }
      const current = projection;
      const game: InstalledGameExtensionModule = {
        id: item.id,
        ...(current.play === undefined ? {} : { play: current.play }),
      };
      games.push(game);
      return {
        start: async () => {},
        health: () => runtime.health(),
        stop: async () => {
          // Shutdown closes its connector; the play ledger keeps any uncertain claim for recovery.
          const index = games.indexOf(game);
          if (index !== -1) games.splice(index, 1);
          try {
            await current.close?.();
          } catch (error) {
            input.logger.warn(
              {
                event: "game_extension.close_failed",
                id: item.id,
                error: error instanceof Error ? error.message : "",
              },
              "Installed game extension did not close cleanly",
            );
          }
        },
      } satisfies ExtensionRuntime<GameExtensionProjection>;
    },
  };
}

function goLivePort(input: OutsideExtensionLoadInput): GameExtensionModuleHost["goLive"] {
  return async (destination) => {
    if (!/^\d+$/u.test(destination.guildId) || !/^\d+$/u.test(destination.channelId)) return false;
    const { guildId, channelId, snapshotUrl } = destination;
    try {
      return (await input.goLive?.({ guildId, channelId, snapshotUrl })) ?? false;
    } catch {
      return false; // An unreachable Discord body means the stream was not requested.
    }
  };
}

function extensionWrapper(
  item: InstalledExtension,
  prepared: Prepared,
  input: OutsideExtensionLoadInput,
): ClankieExtension<unknown, object, never, GameExtensionProjection> {
  const { module, granted } = prepared;
  const extension = module.extension as OutsideExtension | undefined;
  if (
    !record(extension) ||
    typeof extension.create !== "function" ||
    !Array.isArray(extension.needs) ||
    !record(extension.settings) ||
    typeof extension.settings.schema?.parse !== "function"
  )
    return unavailable("extension_export_required");
  if (extension.id !== item.id) unavailable("id_mismatch");
  const ports = scopedPorts(item.id, join(input.stateRoot, "extension-state", item.id), granted, item, input);
  const needs = extension.needs as readonly (keyof OutsidePorts)[];
  for (const need of needs) {
    const permission = OUTSIDE_PORT_PERMISSION[need];
    if (permission === undefined) unavailable("needs_unknown_port");
    if (!(need in ports)) unavailable(`permission_refused_${permission}`);
  }
  const host: Partial<OutsidePorts> = {};
  for (const need of needs) Object.assign(host, { [need]: ports[need] });
  return {
    contractVersion: 1,
    id: item.id,
    // The extension parses its own options; a refused `options` grant parses as none.
    settings: {
      key: `installedExtensions.${item.id}`,
      schema: { parse: (value) => extension.settings.schema.parse(granted.has("options") ? value : {}) },
    },
    needs: [],
    create(_ports, settings) {
      const runtime = extension.create(Object.freeze(host) as OutsidePorts, settings);
      return {
        start: (signal) => runtime.start(signal),
        stop: () => runtime.stop(),
        health: () => runtime.health(),
        projection: () => {
          let projection: OutsideProjection | undefined;
          try {
            projection = runtime.projection?.();
          } catch {
            projection = undefined;
          }
          return hostProjection(
            item.id,
            "extension",
            granted,
            () => projection,
            // A plain extension sees who is calling, never the play authority or the owner route.
            (identity) => ({ conversationId: identity.conversationId, current: identity.current }),
          );
        },
      };
    },
  };
}

/** A failing outside projection loses its own tools and routes, never the turn's other tools. */
function contained<T>(read: () => readonly T[]): readonly T[] {
  try {
    return read();
  } catch {
    return [];
  }
}

type BodyIdentity = NonNullable<Parameters<GameExtensionProjection["tools"]>[0]["bodyIdentity"]>;

/**
 * Adapts an outside projection to the host's tools and routes. Grants, tool
 * names and route paths are checked here; auth and turn binding stay here.
 */
function hostProjection<Identity extends OutsideConversationIdentity>(
  id: string,
  kind: ExtensionManifest["kind"],
  granted: ReadonlySet<OutsidePermission>,
  current: () =>
    | {
        tools?(identity: Identity | undefined): readonly ExtensionTool[];
        readonly paths?: readonly string[];
        fetch?(request: Request, identity: Identity): Promise<Response>;
      }
    | undefined,
  identityOf: (identity: BodyIdentity) => Identity,
): GameExtensionProjection {
  const paths = () =>
    granted.has("routes")
      ? contained(() => (current()?.paths ?? []).filter((path) => ownsRoutePath(id, kind, path)))
      : [];
  return {
    get paths() {
      return paths();
    },
    tools: (turn): ToolDefinition[] =>
      (granted.has("tools")
        ? contained(() =>
            (
              current()?.tools?.(
                turn.bodyIdentity === undefined ? undefined : identityOf(turn.bodyIdentity),
              ) ?? []
            ).filter((tool) => ownsToolName(id, tool.name)),
          )
        : []
      ).map((tool) =>
        defineTool({
          name: tool.name,
          label: tool.label,
          description: tool.description,
          parameters: Type.Unsafe<Record<string, unknown>>(tool.parameters),
          executionMode: "sequential",
          execute: async (_id, args) => {
            const result = await tool.execute(args);
            return {
              content: [
                { type: "text" as const, text: result.text ?? JSON.stringify(result.details) },
                ...(result.image === undefined
                  ? []
                  : [{ type: "image" as const, data: result.image.data, mimeType: result.image.mimeType }]),
              ],
              details: result.details,
            };
          },
        }),
      ),
    routes: ({ authorize }) => {
      const app = new Hono();
      app.all("*", async (context) => {
        const projection = current();
        if (projection?.fetch === undefined || !paths().includes(context.req.path))
          return context.json({ error: "not_found" }, 404);
        const identity = await authorize(context.req.raw);
        if (!identity) return context.json({ error: "operator_authentication_required" }, 401);
        return projection.fetch(context.req.raw, identityOf(identity));
      });
      return app;
    },
  };
}

/**
 * Restart recovery for an outside game that holds the shared play lease, run
 * inside the host's incarnation-fenced operation. Undefined when none does.
 * Only the outer operation releases the ledger claim.
 */
export async function recoverExternalPlay(
  games: readonly InstalledGameExtensionModule[],
  registry: Pick<InstalledGameExtensions, "reconcileStopped">,
  guard: () => Promise<void>,
): Promise<boolean | undefined> {
  for (const game of games) {
    const play = game.play;
    if (play === undefined || !play.owns()) continue;
    if (!(await play.recover(guard))) return false;
    return registry.reconcileStopped(game.id, async () => {
      await guard();
      return !play.owns();
    });
  }
  return undefined;
}

/** The core's extension states followed by the outside ones, for `/health` and `/v1/extensions`. */
export function withOutsideStates(
  core: Pick<OutsideExtensions, "snapshot" | "report">,
  outside: Pick<OutsideExtensions, "snapshot" | "report">,
): Pick<OutsideExtensions, "snapshot" | "report"> {
  return {
    snapshot: () => [...core.snapshot(), ...outside.snapshot()],
    report: async () => [...(await core.report()), ...(await outside.report())],
  };
}

/** The game registry's catalog, with outside extensions' tools and routes beside the games'. */
export function withOutsideProjections(
  games: Pick<InstalledGameExtensions, "catalog" | "projections">,
  outside: Pick<OutsideExtensions, "projections">,
): Pick<InstalledGameExtensions, "catalog" | "projections"> {
  return {
    catalog: () => games.catalog(),
    projections: () => [...games.projections(), ...outside.projections()],
  };
}
