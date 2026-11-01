import type { ClankieExtension } from "@clankie/extension";
import { composerTranscriptionRoutes } from "./composer-transcription.ts";
import type { DiscordRoomVoice } from "./discord-room-voice.ts";
import type { CorePorts, CoreProjection } from "./extension-host.ts";
import { voiceRoomRoutes } from "./voice-room-routes.ts";

/**
 * Voice as an ADR 0328 extension. It starts with the phone composer's
 * transcription routes and the room voice routes; voice lanes, calls and the
 * Discord voice body are still wired by the composition root and the captain,
 * and move with the persona.
 */
export function voiceExtension(
  roomVoice: DiscordRoomVoice,
): ClankieExtension<undefined, CorePorts, never, CoreProjection> {
  return {
    contractVersion: 1,
    id: "voice",
    settings: { key: "voice", schema: { parse: () => undefined } },
    needs: [],
    create() {
      const composer = composerTranscriptionRoutes();
      const room = voiceRoomRoutes(roomVoice);
      return {
        async start() {},
        async stop() {},
        health: () => ({ state: "ready" }),
        projection: () => ({
          routes: {
            place: "body",
            register: (app, host) => {
              composer.register(app, host);
              room.register(app, host);
            },
            close: () => {
              composer.close?.();
              room.close?.();
            },
          },
        }),
      };
    },
  };
}
