import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GbaEmulatorObservationKindSchema } from "@clankie/interactive-environment";
import { z } from "zod";
import { ActArgumentsSchema, actTool, observeTool, pauseTool, type GbaToolContext } from "./tools.ts";

/**
 * Clankie's body, published for any harness to drive.
 *
 * Tool names mirror `GbaEmulatorToolNameSchema` so an external caller and
 * Clankie's own loop are talking about the same capabilities. Nothing here
 * reaches the core directly: the context carries the `EnvironmentRuntime`-backed
 * seam, so a possessor is bounded by the same lease, idempotency, and
 * fail-closed limits a script is.
 */
export function createGbaMcpServer(context: GbaToolContext): McpServer {
  const server = new McpServer({ name: "clankie-gba", version: "0.1.0" });

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
      inputSchema: ActArgumentsSchema.shape,
    },
    (args) => actTool(context, args),
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
