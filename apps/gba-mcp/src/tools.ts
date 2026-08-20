import {
  EnvironmentActionResultSchema,
  GbaEmulatorActionRequestSchema,
  GbaEmulatorObservationKindSchema,
  type GbaEmulatorObservation,
} from "@clankie/interactive-environment";
import type { GbaCheckpointSummary, GbaDriverIo } from "@clankie/gba-emulator";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export const ObserveArgumentsSchema = z
  .object({ kind: GbaEmulatorObservationKindSchema.optional() })
  .strict();
export const StartActionArgumentsSchema = GbaEmulatorActionRequestSchema.pick({ action: true });

const OBSERVED_KINDS = ["danger", "scene", "overworld", "battle", "dialog", "menu"] as const;

export type McpToolResult = CallToolResult;

export interface GbaToolContext {
  io: GbaDriverIo;
  framePng: (anchor?: { readonly playerX: number; readonly playerY: number }) => Uint8Array | null;
  saveCheckpoint?: (label: string | undefined) => GbaCheckpointSummary;
  loadCheckpoint?: (checkpointId: string) => GbaCheckpointSummary;
  listCheckpoints?: () => GbaCheckpointSummary[];
}

export function observeTool(
  context: GbaToolContext,
  args: z.infer<typeof ObserveArgumentsSchema>,
): McpToolResult {
  const kinds = args.kind === undefined ? OBSERVED_KINDS : [args.kind];
  const observations: GbaEmulatorObservation[] = [];
  for (const kind of kinds) {
    try {
      observations.push(context.io.observe(kind));
    } catch {
      // A view can be valid but inapplicable to the current game state.
    }
  }
  const standing = observations
    .map((observation) => (observation as { data?: { position?: { x: number; y: number } } }).data?.position)
    .find((position) => position !== undefined);
  const frame = context.framePng(
    standing === undefined ? undefined : { playerX: standing.x, playerY: standing.y },
  );
  const content: McpToolResult["content"] = [{ type: "text", text: JSON.stringify(observations, null, 2) }];
  if (frame !== null) {
    content.push({ type: "image", data: Buffer.from(frame).toString("base64"), mimeType: "image/png" });
  }
  return { content };
}

export async function actTool(
  context: GbaToolContext,
  args: z.infer<typeof StartActionArgumentsSchema>,
): Promise<McpToolResult> {
  try {
    const result = EnvironmentActionResultSchema.parse(await context.io.act(args.action));
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
    };
  } catch (error) {
    return errorResult(error);
  }
}

export async function pauseTool(context: GbaToolContext, reason: string): Promise<McpToolResult> {
  try {
    await context.io.pause(reason);
    return { content: [{ type: "text", text: `paused: ${reason}` }] };
  } catch (error) {
    return errorResult(error);
  }
}

export async function resumeTool(context: GbaToolContext): Promise<McpToolResult> {
  try {
    await context.io.resume();
    return { content: [{ type: "text", text: "resumed" }] };
  } catch (error) {
    return errorResult(error);
  }
}

function describeCheckpoint(checkpoint: GbaCheckpointSummary): string {
  const named = checkpoint.label === null ? "" : ` "${checkpoint.label}"`;
  const where =
    checkpoint.position === null
      ? ""
      : ` at ${checkpoint.position.mapId} (${String(checkpoint.position.x)},${String(checkpoint.position.y)})`;
  return `${checkpoint.checkpointId}${named}${where}, captured ${checkpoint.capturedAt}`;
}

export function saveStateTool(context: GbaToolContext, label: string | undefined): McpToolResult {
  try {
    if (context.saveCheckpoint === undefined) {
      throw new Error("checkpoints_unavailable: the deterministic double has no savestate to capture");
    }
    const saved = context.saveCheckpoint(label);
    return { content: [{ type: "text", text: `saved checkpoint ${describeCheckpoint(saved)}` }] };
  } catch (error) {
    return errorResult(error);
  }
}

export function loadStateTool(context: GbaToolContext, checkpointId: string | undefined): McpToolResult {
  try {
    if (context.loadCheckpoint === undefined || context.listCheckpoints === undefined) {
      throw new Error("checkpoints_unavailable: the deterministic double has no savestate to restore");
    }
    if (checkpointId === undefined) {
      const checkpoints = context.listCheckpoints();
      return {
        content: [
          {
            type: "text",
            text:
              checkpoints.length === 0
                ? "no checkpoints exist yet; save one first"
                : checkpoints.map(describeCheckpoint).join("\n"),
          },
        ],
      };
    }
    const loaded = context.loadCheckpoint(checkpointId);
    return {
      content: [
        { type: "text", text: `restored checkpoint ${describeCheckpoint(loaded)}` },
        ...observeTool(context, {}).content,
      ],
    };
  } catch (error) {
    return errorResult(error);
  }
}

function errorResult(error: unknown): McpToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message.slice(0, 500) }], isError: true };
}
