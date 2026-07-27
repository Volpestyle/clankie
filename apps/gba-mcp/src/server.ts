import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GbaEmulatorObservationKindSchema } from "@clankie/interactive-environment";
import { z } from "zod";
import {
  ActArgumentsSchema,
  actTool,
  loadStateTool,
  observeTool,
  pauseTool,
  resumeTool,
  saveStateTool,
  type GbaToolContext,
} from "./tools.ts";
import type { PossessionLease } from "./possession.ts";
import {
  CLANKIE_HEARING_MAX_LINES,
  CLANKIE_SPEECH_MAX,
  deniedHearingPort,
  deniedSpeechPort,
  PossessorHearing,
  type ClankieHearingPort,
  type ClankieSpeechPort,
} from "./speech.ts";

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
  /** Defaults to refusing; hearing is blocked by the same gateway fence. */
  hearing?: ClankieHearingPort;
}

export function createGbaMcpServer(context: GbaToolContext, options: GbaMcpServerOptions = {}): McpServer {
  const { possession } = options;
  const speech = options.speech ?? deniedSpeechPort;
  const hearing = new PossessorHearing(options.hearing ?? deniedHearingPort);
  const server = new McpServer({ name: "clankie-gba", version: "0.1.0" });

  server.registerTool(
    "clankie_listen",
    {
      title: "Hear what was said near Clankie",
      description:
        "Read recent transcript lines from the voice channel Clankie is in. Requires the possession " +
        "lease. You hear exactly what Clankie was already permitted to hear under the existing " +
        "consent rules — asking as a possessor grants no additional access, and raw audio never " +
        "crosses this boundary.",
      inputSchema: {
        limit: z.number().int().min(1).max(CLANKIE_HEARING_MAX_LINES).optional(),
        possessionToken: z.string().optional(),
      },
    },
    async (args) => {
      try {
        context.assertMayAct?.(args.possessionToken);
        // Subscribing lazily means a possessor that never listens causes no
        // capture at all.
        hearing.start();
        const lines = hearing.recent(args.limit ?? 10);
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: error instanceof Error ? error.message : "refused" }],
          isError: true,
        };
      }
    },
  );

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
          "lease — look before deciding to take the body. While you hold it, checkpoint after " +
          "major events (gba_emulator_save_state): progress lives only in this process until " +
          "saved.",
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
        // What was heard does not outlive the possession that heard it.
        hearing.stop();
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
      title: "Press a button, walk to a tile, or read through a dialog",
      description:
        "Take one catalogued action. A short directional tap only turns the character — hold 16 " +
        "frames to commit a step, or use repeat to cross several tiles in one action. Prefer " +
        "walk_to with a target x/y for anything further than a step: it routes around walls using " +
        "the map's own collision and reports where it stopped. When a dialog is open, prefer " +
        "advance_dialog: it presses through every text box, returns the full transcript, and " +
        "stops exactly when the dialog closes, a choice or battle appears, or the budget runs " +
        "out — never answering a choice for you. The result carries the resulting position, " +
        "facing, whether the press actually moved, what is now adjacent, and any visible dialog " +
        "or menu, so a move needs no follow-up observe. Illegal buttons, exceeded frame bounds, " +
        "unreachable targets and missing capabilities are refused with the reason.",
      inputSchema: { ...ActArgumentsSchema.shape, possessionToken: z.string().optional() },
    },
    (args) => actTool({ ...context, possessionToken: args.possessionToken }, args),
  );

  server.registerTool(
    "gba_emulator_save_state",
    {
      title: "Save progress as a checkpoint",
      description:
        "Capture the full game state as a named operator-local checkpoint, with a companion " +
        "scenario so a later boot can start from it. Save after major events — a starter chosen, " +
        "a battle won, a new area reached — because unsaved progress lives only in this process " +
        "and dies with it. Requires the possession lease. Unavailable on the deterministic core " +
        "double.",
      inputSchema: {
        label: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]{0,39}$/u)
          .optional()
          .describe("Short slug naming the moment, e.g. before-rival."),
        possessionToken: z.string().optional(),
      },
    },
    (args) => saveStateTool({ ...context, possessionToken: args.possessionToken }, args.label),
  );

  server.registerTool(
    "gba_emulator_load_state",
    {
      title: "Restore a saved checkpoint",
      description:
        "Load a checkpoint into the running game, replacing the current state, and return the " +
        "restored view. Omit checkpointId to list what exists. Requires the possession lease: " +
        "rewriting the body's state is driving it. Digests are verified before anything loads; a " +
        "checkpoint from another ROM or core build is refused.",
      inputSchema: {
        checkpointId: z.string().min(1).max(160).optional(),
        possessionToken: z.string().optional(),
      },
    },
    (args) => loadStateTool({ ...context, possessionToken: args.possessionToken }, args.checkpointId),
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

  server.registerTool(
    "gba_emulator_resume",
    {
      title: "Resume the session",
      description:
        "Undo a pause and let actions dispatch again. Requires the possession lease: pausing is " +
        "safe from anyone, resuming is driving.",
      inputSchema: { possessionToken: z.string().optional() },
    },
    (args) => resumeTool({ ...context, possessionToken: args.possessionToken }),
  );

  return server;
}
