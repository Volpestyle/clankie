import type { ClankieExtension } from "@clankie/extension";
import { registerVoiceCallRoute, type VoiceCallOptions } from "./app/voice-call-route.ts";
import { voiceCallHandoff, voiceCallTranscript } from "./captain/voice-call-handoff.ts";
import { composeVoiceLaneInstructions } from "./captain/voice-lane.ts";
import { composerTranscriptionRoutes } from "./composer-transcription.ts";
import type { DiscordRoomVoice } from "./discord-room-voice.ts";
import type { CorePorts, CoreProjection } from "./extension-host.ts";
import type { CaptainVoice } from "./ports/voice.ts";
import { voiceRoomRoutes } from "./voice-room-routes.ts";

/**
 * What voice gives the captain while it is on: the voice lane's instructions
 * and a device call's handoff and transcript (ADR 0328).
 */
export const captainVoice: CaptainVoice = {
  laneInstructions: composeVoiceLaneInstructions,
  callHandoff: voiceCallHandoff,
  callTranscript: voiceCallTranscript,
};

/**
 * Voice as an ADR 0328 extension. It serves the phone composer's
 * transcription routes, the room voice routes and the device voice call; the
 * composition root gives the captain `captainVoice` and the Discord voice body
 * only while it is on.
 */
export function voiceExtension(
  roomVoice: DiscordRoomVoice,
  call?: VoiceCallOptions,
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
              registerVoiceCallRoute(app, host, call);
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
