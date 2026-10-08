import type { GameExtensionRegistry } from "@clankie/game-extension";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Hono } from "hono";
import type { SettingsStore } from "@clankie/settings";
import type { BodyConversationIdentity } from "./body-lease-router.ts";
import type { TurnContext } from "./captain/tools.ts";

/** Trusted game projection; authentication, settings and turn binding stay host-owned. */
export interface GameExtensionProjection {
  tools(turn: TurnContext): ToolDefinition[];
  readonly paths: readonly string[];
  routes(options: {
    settings: Pick<SettingsStore, "load"> & Partial<Pick<SettingsStore, "update">>;
    authorize(request: Request): Promise<BodyConversationIdentity | undefined>;
  }): Hono;
}
export type InstalledGameExtensions = GameExtensionRegistry<GameExtensionProjection>;
