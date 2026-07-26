import {
  GbaEmulatorActionSchema,
  GbaEmulatorObservationKindSchema,
  type GbaEmulatorObservation,
} from "@clankie/interactive-environment";
import { FREE_PLAY_ACTION_LIMITS, type GbaDriverIo } from "@clankie/gba-emulator";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/**
 * The emulator surface, published as MCP tools.
 *
 * These are **another consumer** of the one tool surface Clankie already has —
 * `GbaEmulatorToolNameSchema` and the action/observation schemas — never a
 * parallel path to the core. Every action still dispatches through the
 * `EnvironmentRuntime` seam this module is handed, which is what keeps ADR
 * 0049's "changes who decides, not how an action is authorised" true when the
 * decider is an external harness rather than Clankie's own loop.
 *
 * A second definition of what Clankie can do in a game would be the failure
 * mode here, so nothing below invents a capability: each tool maps onto an
 * existing catalogued action or observation kind.
 */

/** Flat action arguments. Providers reject `oneOf` in tool schemas (ADR 0049). */
export const ActArgumentsSchema = z
  .object({
    actionKind: z.enum(["button_press", "walk_to", "frame_advance", "wait"]),
    button: z
      .enum(["up", "down", "left", "right", "a", "b", "start", "select", "l", "r"])
      .optional()
      .describe("Required for button_press."),
    holdFrames: z
      .number()
      .int()
      .optional()
      .describe("Frames to hold. 16 reliably commits a step; a short tap only turns."),
    repeat: z
      .number()
      .int()
      .min(1)
      // The schema advertises exactly what the lease allows: promising more
      // teaches a driver to distrust both and press one button at a time.
      .max(FREE_PLAY_ACTION_LIMITS.maxInputs)
      .optional()
      .describe(
        `Press this many times in one action (max ${String(FREE_PLAY_ACTION_LIMITS.maxInputs)}, the ` +
          "per-action input budget). Use the full budget for dialog mashing.",
      ),
    frames: z.number().int().optional().describe("Required for frame_advance."),
    durationMs: z.number().int().optional().describe("Required for wait."),
    x: z.number().int().optional().describe("Required for walk_to. Target tile x, as reported by observe."),
    y: z.number().int().optional().describe("Required for walk_to. Target tile y, as reported by observe."),
    monologue: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe("One short line of your thinking, shown beside the stream to people watching."),
  })
  .strict();
export type ActArguments = z.infer<typeof ActArgumentsSchema>;

const DEFAULT_HOLD_FRAMES = 16;

/** Build a catalogued action. Returns raw shape; the emulator schema validates. */
export function toAction(args: ActArguments): unknown {
  if (args.actionKind === "button_press") {
    return {
      kind: "button_press",
      button: args.button,
      holdFrames: args.holdFrames ?? DEFAULT_HOLD_FRAMES,
      ...(args.repeat === undefined || args.repeat === 1 ? {} : { repeat: args.repeat }),
    };
  }
  if (args.actionKind === "walk_to") return { kind: "walk_to", x: args.x, y: args.y };
  if (args.actionKind === "frame_advance") return { kind: "frame_advance", frames: args.frames };
  return { kind: "wait", durationMs: args.durationMs };
}

export const ObserveArgumentsSchema = z
  .object({
    kind: GbaEmulatorObservationKindSchema.optional().describe(
      "Omit to read every available view for the current state.",
    ),
  })
  .strict();

const OBSERVED_KINDS = ["danger", "overworld", "battle", "dialog", "menu"] as const;

/** The SDK's own result type, so this cannot drift from what it accepts. */
export type McpToolResult = CallToolResult;

/** What the checkpoint hooks report back to a caller. Digests stay out. */
export interface GbaCheckpointSummary {
  checkpointId: string;
  label: string | null;
  capturedAt: string;
  position: { mapId: string; x: number; y: number } | null;
}

export interface GbaToolContext {
  io: GbaDriverIo;
  framePng: () => Uint8Array | null;
  /** Refuses gameplay unless this caller holds the possession lease. */
  assertMayAct?: (token: string | undefined) => void;
  possessionToken?: string | undefined;
  /**
   * Show the possessor's stated thought to people watching the activity
   * surface. Rides the action call rather than being its own tool, so a
   * thought never costs an extra round-trip. Best-effort: unset means nobody
   * is watching, and play continues.
   */
  publishThought?: (monologue: string) => void;
  /**
   * Checkpoint hooks, absent on the deterministic double. Save mints an
   * operator-local checkpoint; load verifies digests and restores one into
   * the running core.
   */
  saveCheckpoint?: (label: string | undefined) => GbaCheckpointSummary;
  loadCheckpoint?: (checkpointId: string) => GbaCheckpointSummary;
  listCheckpoints?: () => GbaCheckpointSummary[];
}

/** Read the decoded state, and return the screen alongside it. */
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
      // Not every view is meaningful in every state; a missing one is simply
      // context the caller does not get, exactly as in free play.
    }
  }
  const frame = context.framePng();
  const content: McpToolResult["content"] = [
    { type: "text" as const, text: JSON.stringify(observations, null, 2) },
  ];
  if (frame !== null) {
    // The caller sees what Clankie sees, not only what the RAM decoder exposes.
    content.push({ type: "image", data: Buffer.from(frame).toString("base64"), mimeType: "image/png" });
  }
  return { content };
}

/** Dispatch one catalogued action through the environment runtime. */
export async function actTool(context: GbaToolContext, args: ActArguments): Promise<McpToolResult> {
  try {
    context.assertMayAct?.(context.possessionToken);
  } catch (error) {
    return errorResult(error);
  }
  const parsed = GbaEmulatorActionSchema.safeParse(toAction(args));
  if (!parsed.success) {
    // Fail closed with the reason, rather than guessing what was meant.
    return errorResult(
      new Error(`invalid_action: ${parsed.error.issues.map((i) => i.path.join(".")).join(",")}`),
    );
  }
  // After the lease check, never before: only the holder puts words on the
  // surface. Before dispatch, so the viewer reads the thought as it plays out.
  if (args.monologue !== undefined) context.publishThought?.(args.monologue);
  try {
    const result = await context.io.act(parsed.data);
    if (result.status !== "completed") {
      return errorResult(new Error(`${result.status}: the emulator refused this action`));
    }
    return { content: [{ type: "text", text: JSON.stringify(result.outcome) }] };
  } catch (error) {
    return errorResult(error);
  }
}

export async function pauseTool(context: GbaToolContext, reason: string): Promise<McpToolResult> {
  await context.io.pause(reason);
  return { content: [{ type: "text", text: `paused: ${reason}` }] };
}

/**
 * Undo a pause. Pausing is deliberately lease-free — stopping the body is safe
 * from anyone — but resuming is driving, so it is gated exactly like acting.
 */
export async function resumeTool(context: GbaToolContext): Promise<McpToolResult> {
  try {
    context.assertMayAct?.(context.possessionToken);
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

/** Mint an operator-local checkpoint. Gated like acting: saving is capturing the body. */
export function saveStateTool(context: GbaToolContext, label: string | undefined): McpToolResult {
  try {
    context.assertMayAct?.(context.possessionToken);
    if (context.saveCheckpoint === undefined) {
      throw new Error("checkpoints_unavailable: the deterministic double has no savestate to capture");
    }
    const saved = context.saveCheckpoint(label);
    return { content: [{ type: "text", text: `saved checkpoint ${describeCheckpoint(saved)}` }] };
  } catch (error) {
    return errorResult(error);
  }
}

/**
 * Restore a checkpoint into the running core, or list what exists when no id
 * is given. Restoring rewrites the body's whole state, so it is driving.
 */
export function loadStateTool(context: GbaToolContext, checkpointId: string | undefined): McpToolResult {
  try {
    context.assertMayAct?.(context.possessionToken);
    if (context.loadCheckpoint === undefined || context.listCheckpoints === undefined) {
      throw new Error("checkpoints_unavailable: the deterministic double has no savestate to restore");
    }
    if (checkpointId === undefined) {
      const checkpoints = context.listCheckpoints();
      const text =
        checkpoints.length === 0
          ? "no checkpoints exist yet; save one first"
          : checkpoints.map(describeCheckpoint).join("\n");
      return { content: [{ type: "text", text }] };
    }
    const loaded = context.loadCheckpoint(checkpointId);
    // The world just changed out from under the caller, so hand back the new
    // state immediately rather than making it pay for a follow-up observe.
    const observed = observeTool(context, {});
    return {
      content: [
        { type: "text", text: `restored checkpoint ${describeCheckpoint(loaded)}` },
        ...observed.content,
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
