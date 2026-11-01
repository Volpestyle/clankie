import type { ClankieExtension } from "@clankie/extension";
import { registerDiscordRoutes } from "./app/discord-routes.ts";
import { createAppearanceRoutes } from "./appearance-routes.ts";
import { createDiscordRoomRoutes } from "./discord-room-routes.ts";
import type { CorePorts, CoreProjection } from "./extension-host.ts";
import { createPersonaVoiceSettingsRoutes } from "./persona-voice-settings-routes.ts";
import type { AppearancePort } from "./ports/appearance.ts";
import type { ExtensionRoutes } from "./ports/routes.ts";

/**
 * The Discord persona's HTTP routes: rooms and their settings, the persona and
 * voice settings, appearance, and the Discord body's own routes (presence,
 * channel turns, the user-session opt-in). The body's live state stays in the
 * core, which reads it for its own admission checks, and reaches these routes
 * through the route host.
 */
export function personaRoutes(): ExtensionRoutes {
  return {
    place: "body",
    register(app, host) {
      const body = host.discordBody;
      const { dependencies } = body;
      // First: its /v1/discord/* body limit and no-store reach the body routes below.
      if (dependencies.roomObservations !== undefined)
        app.route(
          "/",
          createDiscordRoomRoutes({
            machineName: body.machineName,
            environment: dependencies.discordEnvironment ?? process.env,
            ...(dependencies.discordDirectory ? { directory: dependencies.discordDirectory } : {}),
            ...(dependencies.discordPermissions ? { permissions: dependencies.discordPermissions } : {}),
            ...(dependencies.discordTestPost ? { testPost: dependencies.discordTestPost } : {}),
            ...(dependencies.builtInTracker
              ? {
                  trackerProjectExists: async (projectId: string) => {
                    const project = (await dependencies.builtInTracker!.call("get_project", {
                      query: projectId,
                    })) as { id?: unknown };
                    return project.id === projectId;
                  },
                }
              : {}),
            authorize: host.room,
            captain: dependencies.captain,
            observations: dependencies.roomObservations,
            settings: host.settings,
          }),
        );
      app.route(
        "/",
        createPersonaVoiceSettingsRoutes({
          settings: host.settings,
          authorizePersona: host.ownerSettings,
          operator: async (request) => {
            const identity = await host.operator(request);
            return identity === "unavailable" ? "unavailable" : identity?.operatorId;
          },
          ...(dependencies.voiceSettingsEnv === undefined
            ? {}
            : { voiceSettingsEnv: dependencies.voiceSettingsEnv }),
        }),
      );
      app.route("/", createAppearanceRoutes(host.ownerSettings, host.settings));
      registerDiscordRoutes({
        ...body,
        app,
        settingsSource: host.settings,
        clock: host.clock,
        authorizeRoom: host.room,
      });
    },
  };
}

/**
 * The persona as an ADR 0328 extension: its routes, and his look, which fills
 * the core's appearance port for media while the persona runs.
 */
export function personaExtension(options: {
  readonly appearance: AppearancePort;
}): ClankieExtension<undefined, CorePorts, never, CoreProjection> {
  return {
    contractVersion: 1,
    id: "persona",
    settings: { key: "persona", schema: { parse: () => undefined } },
    needs: [],
    create() {
      const routes = personaRoutes();
      return {
        async start() {},
        async stop() {},
        health: () => ({ state: "ready" }),
        projection: () => ({ routes, appearance: options.appearance }),
      };
    },
  };
}
