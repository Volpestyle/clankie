import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GbaEmulatorObservationKindSchema } from "@clankie/interactive-environment";
import { z } from "zod";
import { ActArgumentsSchema, actTool, observeTool, pauseTool, type GbaToolContext } from "./tools.ts";
import type { PossessionLease } from "./possession.ts";
import { CLANKIE_SPEECH_MAX, deniedSpeechPort, type ClankieSpeechPort } from "./speech.ts";

/**
 * Clankie's body, published for any harness to drive.
 *
 * Tool names mirror `GbaEmulatorToolNameSchema` so an external caller and
 * Clankie's own loop are talking about the same capabilities. Nothing here
 * reaches the core directly: the context carries the `EnvironmentRuntime`-backed
 * seam, so a possessor is bounded by the same lease, idempotency, and
 * fail-closed limits a script is.
 */
export interface GbaMcpServerOptions {
  possession?: PossessionLease;
  /** Defaults to refusing; a possessor cannot speak without a wired port. */
  speech?: ClankieSpeechPort;
}

export function createGbaMcpServer(context: GbaToolContext, options: GbaMcpServerOptions = {}): McpServer {
  const { possession } = options;
  const speech = options.speech ?? deniedSpeechPort;
  const server = new McpServer({ name: "clankie-gba", version: "0.1.0" });

  server.registerTool(
    "clankie_say",
    {
      title: "Say something as Clankie",
      description:
        "Speak in the channel Clankie is present in. Requires the possession lease: talking as him " +
        "is driving him. You cannot choose the audience — a possessor drives the character, it does " +
        "not pick new rooms. Ambient authority: this can never approve privileged work.",
      inputSchema: {
        text: z.string().min(1).max(CLANKIE_SPEECH_MAX),
        possessionToken: z.string().optional(),
      },
    },
    async (args) => {
      try {
        context.assertMayAct?.(args.possessionToken);
        await speech.say(args.text);
        return { content: [{ type: "text" as const, text: "said" }] };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: error instanceof Error ? error.message : "refused" }],
          isError: true,
        };
      }
    },
  );

  if (possession !== undefined) {
    server.registerTool(
      "gba_emulator_possess",
      {
        title: "Take control of the body",
        description:
          "Acquire the possession lease before acting. One holder drives at a time; another " +
          "holder's live lease is only taken with force, which is logged. Observation needs no " +
          "lease — look before deciding to take the body.",
        inputSchema: {
          holderId: z.string().min(1).max(128),
          force: z.boolean().optional().describe("Take the body from a live holder. Logged."),
        },
      },
      (args) => {
        try {
          const grant = possession.acquire(args.holderId, { force: args.force ?? false });
          return {
            content: [
              {
                type: "text" as const,
                text: `possession granted to ${grant.holderId}; pass this token to act: ${grant.token}`,
              },
            ],
          };
        } catch (error) {
          return {
            content: [{ type: "text" as const, text: error instanceof Error ? error.message : "refused" }],
            isError: true,
          };
        }
      },
    );

    server.registerTool(
      "gba_emulator_release",
      {
        title: "Give the body back",
        description: "Release the possession lease so the resident loop resumes.",
        inputSchema: { token: z.string().min(1) },
      },
      (args) => {
        possession.release(args.token);
        return { content: [{ type: "text" as const, text: "possession released" }] };
      },
    );
  }

  server.registerTool(
    "gba_emulator_observe",
    {
      title: "Look at the game",
      description:
        "Read the decoded game state and see the current screen. Returns the overworld position, " +
        "party, dialog, menu and battle views that apply right now, plus the rendered frame as an " +
        "image. Look before you press: the screen shows walls, furniture, doors and text that the " +
        "decoded state does not describe.",
      inputSchema: { kind: GbaEmulatorObservationKindSchema.optional() },
    },
    (args) => observeTool(context, args),
  );

  server.registerTool(
    "gba_emulator_start_action",
    {
      title: "Press a button",
      description:
        "Take one catalogued action. A short directional tap only turns the character — hold 16 " +
        "frames to commit a step, or use repeat to cross several tiles in one action. Illegal " +
        "buttons, exceeded frame bounds and missing capabilities are refused with the reason.",
      inputSchema: { ...ActArgumentsSchema.shape, possessionToken: z.string().optional() },
    },
    (args) => actTool({ ...context, possessionToken: args.possessionToken }, args),
  );

  server.registerTool(
    "gba_emulator_pause",
    {
      title: "Pause the session",
      description: "Stop the session for a stated reason. Use it when the state looks uncertain.",
      inputSchema: { reason: z.string().min(1).max(512) },
    },
    (args) => pauseTool(context, args.reason),
  );

  return server;
}
