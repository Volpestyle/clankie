import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GbaEmulatorPauseCommandSchema } from "@clankie/interactive-environment";
import { GbaCheckpointIdSchema, GbaCheckpointLabelSchema } from "@clankie/gba-emulator";
import { z } from "zod";
import {
  ObserveArgumentsSchema,
  StartActionArgumentsSchema,
  actTool,
  loadStateTool,
  observeTool,
  pauseTool,
  resumeTool,
  saveStateTool,
  type GbaToolContext,
} from "./tools.ts";

export const GBA_MCP_TOOL_NAMES = [
  "gba_emulator_observe",
  "gba_emulator_start_action",
  "gba_emulator_pause",
  "gba_emulator_resume",
  "gba_emulator_save_state",
  "gba_emulator_load_state",
] as const;

export function createGbaMcpServer(context: GbaToolContext): McpServer {
  const server = new McpServer({ name: "gba-emulator-harness", version: "0.1.0" });
  let queue = Promise.resolve();
  const serialized = <T>(run: () => T | Promise<T>): Promise<T> => {
    const result = queue.then(run, run);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  server.registerTool(
    "gba_emulator_observe",
    {
      title: "Observe the emulator",
      description: "Read applicable decoded views and the rendered frame from this private emulator session.",
      inputSchema: ObserveArgumentsSchema,
    },
    (args) => serialized(() => observeTool(context, args)),
  );

  server.registerTool(
    "gba_emulator_start_action",
    {
      title: "Start an emulator action",
      description: "Dispatch one canonical GBA emulator action through this session's EnvironmentRuntime.",
      inputSchema: StartActionArgumentsSchema,
    },
    (args) => serialized(() => actTool(context, args)),
  );

  server.registerTool(
    "gba_emulator_pause",
    {
      title: "Pause the emulator",
      description: "Pause this private session for the stated reason.",
      inputSchema: GbaEmulatorPauseCommandSchema.pick({ reason: true }),
    },
    (args) => serialized(() => pauseTool(context, args.reason)),
  );

  server.registerTool(
    "gba_emulator_resume",
    {
      title: "Resume the emulator",
      description: "Resume this private session.",
      inputSchema: z.object({}).strict(),
    },
    () => serialized(() => resumeTool(context)),
  );

  server.registerTool(
    "gba_emulator_save_state",
    {
      title: "Save emulator state",
      description: "Mint a checkpoint for this private session. Unavailable on the deterministic double.",
      inputSchema: z.object({ label: GbaCheckpointLabelSchema.optional() }).strict(),
    },
    (args) => serialized(() => saveStateTool(context, args.label)),
  );

  server.registerTool(
    "gba_emulator_load_state",
    {
      title: "Load emulator state",
      description: "Restore a verified checkpoint, or list checkpoints when no id is supplied.",
      inputSchema: z.object({ checkpointId: GbaCheckpointIdSchema.optional() }).strict(),
    },
    (args) => serialized(() => loadStateTool(context, args.checkpointId)),
  );

  return server;
}
