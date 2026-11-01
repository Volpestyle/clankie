import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Hono } from "hono";
import { Type } from "typebox";
import {
  GAME_EXTENSION_MODULE_API,
  createGameExtensionRuntime,
  type GameExtension,
  type GameExtensionModuleHost,
  type GameExtensionModuleProjection,
  type GameExtensionRuntime,
  type PlayLeaseAuthority,
} from "@clankie/game-extension";
import type { CredentialStore } from "@clankie/credential-broker";
import type { GameExtensionModuleEntry } from "@clankie/settings";
import type { GameExtensionProjection, InstalledGameExtensions } from "./game-extension-projection.ts";

/** An installed external extension, for host-owned play recovery and shutdown. */
export interface InstalledGameExtensionModule {
  readonly id: string;
  readonly module: string;
  readonly play?: GameExtensionModuleProjection["play"];
  close(): Promise<void>;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

/**
 * Loads owner-installed game extensions (`gameplay.extensions`) into the
 * trusted registry. The path comes from owner settings, never a tool argument
 * or model output. A module that fails to load is reported and skipped; it
 * cannot stop the service or another game.
 */
export async function loadGameExtensionModules(input: {
  entries: readonly GameExtensionModuleEntry[];
  registry: InstalledGameExtensions;
  leases: PlayLeaseAuthority;
  stateRoot: string;
  credentials: Pick<CredentialStore, "get">;
  /** Asks his active Discord body to go live; the persona's body fills it (ADR 0328). */
  goLive?: GameExtensionModuleHost["goLive"];
  onError(module: string, error: unknown): void;
}): Promise<InstalledGameExtensionModule[]> {
  const installed: InstalledGameExtensionModule[] = [];
  for (const entry of input.entries) {
    try {
      installed.push(await loadOne(entry, input));
    } catch (error) {
      input.onError(entry.module, error);
    }
  }
  return installed;
}

/**
 * Restart recovery for an installed extension that holds the shared play
 * lease, run inside the host's incarnation-fenced operation. Undefined when
 * none does. Only the outer operation releases the ledger claim.
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

async function loadOne(
  entry: GameExtensionModuleEntry,
  input: Parameters<typeof loadGameExtensionModules>[0],
): Promise<InstalledGameExtensionModule> {
  if (!isAbsolute(entry.module)) throw new Error("game_extension_module_absolute_path_required");
  const loaded: unknown = await import(pathToFileURL(entry.module).href);
  if (!record(loaded)) throw new Error("game_extension_module_invalid");
  const apis = loaded.gameExtensionApis;
  if (!Array.isArray(apis) || !apis.includes(GAME_EXTENSION_MODULE_API))
    throw new Error("game_extension_module_api_unsupported");
  const extension = loaded.gameExtension;
  const project = loaded.projectGameExtension;
  if (!record(extension) || typeof extension.create !== "function" || typeof project !== "function")
    throw new Error("game_extension_module_exports_required");
  const id = extension.id;
  if (typeof id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(id))
    throw new Error("game_extension_module_id_invalid");
  const stateDirectory = join(input.stateRoot, "game-extensions", id);
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const host: GameExtensionModuleHost = {
    options: Object.freeze({ ...entry.options }),
    stateDirectory,
    leases: input.leases,
    createRuntime: createGameExtensionRuntime,
    async credential(name) {
      // An extension reads only its own broker namespace: `ID` or `ID-*`.
      if (name !== id && !name.startsWith(`${id}-`)) return undefined;
      const credential = await input.credentials.get(name);
      return credential?.type === "api" ? credential.key : undefined;
    },
    async goLive(destination) {
      if (!/^\d+$/u.test(destination.guildId) || !/^\d+$/u.test(destination.channelId)) return false;
      const { guildId, channelId, snapshotUrl } = destination;
      try {
        return (await input.goLive?.({ guildId, channelId, snapshotUrl })) ?? false;
      } catch {
        return false; // An unreachable Discord body means the stream was not requested.
      }
    },
  };
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
    host,
    () => hostProjection(() => projection),
  );
  try {
    // The projection steers through the registered runtime, which keeps the registry's admission fence.
    projection = (project as (runtime: unknown) => GameExtensionModuleProjection)(runtime);
  } catch (error) {
    // allow-swallowed-rejection -- the projection error is rethrown; a busy runtime keeps its registration
    await input.registry.unregister(id).catch(() => undefined);
    throw error;
  }
  const current = projection;
  return {
    id,
    module: entry.module,
    ...(current.play === undefined ? {} : { play: current.play }),
    close: async () => {
      await current.close?.();
    },
  };
}

/** A failing external projection loses its own tools and routes, never the turn's other tools. */
function external<T>(read: () => readonly T[]): readonly T[] {
  try {
    return read();
  } catch {
    return [];
  }
}

/** Adapts a module's projection to the host's tools and routes; auth and turn binding stay here. */
function hostProjection(current: () => GameExtensionModuleProjection | undefined): GameExtensionProjection {
  return {
    get paths() {
      return external(() => current()?.paths ?? []);
    },
    tools: (turn): ToolDefinition[] =>
      external(() => current()?.tools(turn.bodyIdentity) ?? []).map((tool) =>
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
        if (projection?.fetch === undefined || !projection.paths.includes(context.req.path))
          return context.json({ error: "not_found" }, 404);
        const identity = await authorize(context.req.raw);
        if (!identity) return context.json({ error: "operator_authentication_required" }, 401);
        return projection.fetch(context.req.raw, identity);
      });
      return app;
    },
  };
}
