import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CaptainSessionLaneV2 } from "@clankie/protocol";
import type { GameplaySettings } from "@clankie/settings";
import { Type } from "typebox";
import type { CaptainDeps } from "../captain/deps.ts";
import { toolJson as json, turnActor, type TurnContext } from "../captain/tools.ts";
import { HOSTED_WORLD_MIND_OPERATIONS } from "./operations.ts";
import { joinWorld, stopPlay } from "./play.ts";

/**
 * World's PokeAgent play tools for one turn: join, world operations, guide,
 * stop, look and recall. The captain asks for them through `CaptainDeps.playTools`,
 * which World's extension fills (ADR 0328).
 */
export function pokeagentTools(
  deps: Pick<CaptainDeps, "embodiment" | "activity" | "playSight" | "hostedWorld">,
  turn: TurnContext,
  lane: CaptainSessionLaneV2,
  gameplay: GameplaySettings,
): ToolDefinition[] {
  const playPorts = {
    submitEmbodimentIntent: deps.embodiment.submitIntent,
    getEmbodimentSession: deps.embodiment.getSession,
    getLiveEmbodimentSession: deps.embodiment.getLiveSession,
  };
  return [
    defineTool({
      name: "pokeagent_join_mmo",
      label: "PokeAgent: join MMO",
      description:
        "Join the hosted PokeAgent MMO and start the play driver (FireRed or Emerald), live on the activity watch surface. " +
        "This is how you play at all — you are the parent of the sitting, not the button-presser; the world holds the cartridge " +
        "and other players are already in it. " +
        "Not for songs or YouTube — those are youtube_search / music_play. " +
        "You can see who else is here. 'joined' means you are in the world; 'join_refused' names a reason you " +
        "can say out loud (play_session_active means a play session is already active or winding down, " +
        "no_credential means nobody provisioned you a seat, world_unreachable means the host " +
        "is down, world_full means there is no room, region_not_hosted means that game is not up, world_refused " +
        "means the world said no); 'pending' means it is still spinning up — say so, never claim to be playing yet. " +
        "Joining does not start the host: with machine tools, the pokeagents skill starts an installed local world, " +
        "then retry — a host-down refusal is a diagnosis, not the end of a request to play.",
      parameters: Type.Object({
        environmentId: Type.Union([Type.Literal("pokemon-firered"), Type.Literal("pokemon-emerald")], {
          default: "pokemon-firered",
        }),
      }),
      execute: async (_id, params) =>
        json(
          await joinWorld(playPorts, {
            environmentId: params.environmentId,
            originLane: lane,
            requestedBy: turnActor(turn, lane),
            bodyIdentity: turn.bodyIdentity,
            ...(gameplay.pokemonBudget === undefined ? {} : { budget: gameplay.pokemonBudget }),
          }),
        ),
    }),
    defineTool({
      name: "pokeagent_world",
      label: "PokeAgent: world",
      description:
        "Use a granted hosted-world operation while you are in the PokeAgent MMO: session status, who else is here, " +
        "regions you can sail to, travel, or challenges. Omit operation to see what this session currently grants. " +
        "Availability follows the world's grants — a missing capability is a refusal, not a prompt to retry. " +
        "Not for walking or reading the screen; those stay on the play body.",
      parameters: Type.Object({
        operation: Type.Optional(StringEnum(HOSTED_WORLD_MIND_OPERATIONS as [string, ...string[]])),
        destination: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        acknowledgeOneWay: Type.Optional(Type.Boolean()),
        kind: Type.Optional(StringEnum(["battle", "trade"])),
        opponent: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        message: Type.Optional(Type.String({ maxLength: 256 })),
        challengeId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        answer: Type.Optional(StringEnum(["accept", "decline"])),
      }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        const hosted = deps.hostedWorld;
        if (hosted === undefined) {
          return json({
            outcome: "refused",
            reason: "not_playing",
            detail: "hosted world operations are unavailable",
          });
        }
        const operation = params.operation;
        if (operation === undefined) return json(hosted.inspect());
        const input: Record<string, unknown> = {};
        if (operation === "world.travel") {
          if (typeof params.destination !== "string") {
            return json({ outcome: "refused", reason: "invalid_input", detail: "travel needs destination" });
          }
          input.destination = params.destination;
          if (params.acknowledgeOneWay === true) input.acknowledgeOneWay = true;
        } else if (operation === "world.challenge") {
          if (params.kind === undefined || typeof params.opponent !== "string") {
            return json({
              outcome: "refused",
              reason: "invalid_input",
              detail: "challenge needs kind and opponent",
            });
          }
          input.kind = params.kind;
          input.opponent = params.opponent;
          if (typeof params.message === "string") input.message = params.message;
        } else if (operation === "world.answer_challenge") {
          if (typeof params.challengeId !== "string" || params.answer === undefined) {
            return json({
              outcome: "refused",
              reason: "invalid_input",
              detail: "answer_challenge needs challengeId and answer",
            });
          }
          input.challengeId = params.challengeId;
          input.answer = params.answer;
        }
        return json(await hosted.invoke(operation, input, turn.bodyIdentity));
      },
    }),
    defineTool({
      name: "pokeagent_guide",
      label: "PokeAgent: guide play",
      description:
        "Suggest a different objective or approach to your live Pokémon play mind. Use after a notable moment or when the room asks to change direction. The mind chooses its own objective and actions; only the conversation owning play can guide it. You can also tell the room what happened or use pokeagent_stop.",
      parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: 400 }) }),
      execute: async (_id, input) =>
        json(
          (await deps.hostedWorld?.guide?.(input.text, turn.bodyIdentity)) ?? {
            outcome: "refused",
            reason: "not_playing",
          },
        ),
    }),
    defineTool({
      name: "pokeagent_stop",
      label: "PokeAgent: stop",
      description:
        "Stop the live PokeAgent sitting and its play driver. The result is what actually happened; a session that was " +
        "already stopped is not an error worth apologising for.",
      parameters: Type.Object({}),
      execute: async () =>
        json(
          await stopPlay(playPorts, {
            originLane: lane,
            requestedBy: turnActor(turn, lane),
            bodyIdentity: turn.bodyIdentity,
          }),
        ),
    }),
    defineTool({
      name: "pokeagent_observe",
      label: "PokeAgent: look at screen",
      description:
        "Look at the current PokeAgent session — its latest Pokemon frame and status. " +
        "Use it when someone asks what you are doing, what is on screen, or how the run is going. " +
        "When a still is available it arrives as an image; say what you actually see.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      execute: async () => {
        const activity = await deps.activity.current();
        const still = (await deps.playSight?.still()) ?? {
          schemaVersion: 1 as const,
          outcome: "not_playing" as const,
        };
        if (still.outcome !== "still") return json({ ...activity, still: { outcome: still.outcome } });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ...activity,
                still: {
                  outcome: "still",
                  width: still.width,
                  height: still.height,
                  sha256: still.sha256,
                },
              }),
            },
            { type: "image" as const, data: still.pngBase64, mimeType: "image/png" },
          ],
          details: { activity, still: { outcome: "still" } },
        };
      },
    }),
    defineTool({
      name: "pokeagent_recall",
      label: "PokeAgent: recall session",
      description:
        "Read the current or most recent PokeAgent journey: where you have been, what you are after, and the last few " +
        "moments you judged worth a remark across sittings. The card says whether that journey is live; a live timestamp " +
        "gap means the player is deciding, not that it is stuck. Not the raw journal. Use it when someone asks how you " +
        "got here or what has happened in the adventure. Say when you have no journey rather than inventing one.",
      parameters: Type.Object({}),
      execute: async () => {
        const [story, live] = await Promise.all([
          deps.playSight?.story() ??
            Promise.resolve({ schemaVersion: 1 as const, outcome: "not_playing" as const }),
          deps.embodiment.getLiveSession(),
        ]);
        return json(
          story.outcome === "card" ? { ...story, active: live?.sessionId === story.card.sessionId } : story,
        );
      },
    }),
  ];
}
