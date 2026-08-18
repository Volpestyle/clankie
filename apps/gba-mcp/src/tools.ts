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
    // The catalogued `wait` is deliberately not offered here: a clockless core
    // never completes one — the runtime parks it as "running" until a deadline
    // sweep cancels it, wedging every action in between behind
    // `action_already_pending`. `frame_advance` is how a driver waits.
    actionKind: z.enum([
      "button_press",
      "walk_to",
      "advance_dialog",
      "enter_text",
      "select_menu_entry",
      "frame_advance",
    ]),
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
          "per-action input budget). For dialog, prefer advance_dialog over a blind mash: it " +
          "stops at choices and box close instead of pressing through them.",
      ),
    frames: z
      .number()
      .int()
      .optional()
      .describe("Required for frame_advance — also how you wait: 60 frames is one second."),
    x: z.number().int().optional().describe("Required for walk_to. Target tile x, as reported by observe."),
    y: z.number().int().optional().describe("Required for walk_to. Target tile y, as reported by observe."),
    text: z
      .string()
      .optional()
      .describe(
        "Required for enter_text: the whole name to type on the open naming screen " +
          "(1-10 characters: letters, digits, space, basic punctuation). Typed text that " +
          "matches is kept, a mismatch is erased first, so repeating the action resumes it.",
      ),
    submit: z
      .boolean()
      .optional()
      .describe("enter_text only. Omit or true confirms with OK; false leaves the screen open."),
    entryId: z
      .string()
      .optional()
      .describe(
        "Required for select_menu_entry: the entry id exactly as the menu view lists it. Walks " +
          "the cursor to that entry and confirms it in one action — battle command and move " +
          "menus, the start menu, party and short bag lists. Never chooses for you.",
      ),
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
  if (args.actionKind === "advance_dialog") return { kind: "advance_dialog" };
  if (args.actionKind === "enter_text") {
    return {
      kind: "enter_text",
      text: args.text,
      ...(args.submit === undefined || args.submit ? {} : { submit: false }),
    };
  }
  if (args.actionKind === "select_menu_entry") return { kind: "select_menu_entry", entryId: args.entryId };
  return { kind: "frame_advance", frames: args.frames };
}

export const ObserveArgumentsSchema = z
  .object({
    kind: GbaEmulatorObservationKindSchema.optional().describe(
      "Omit to read every available view for the current state.",
    ),
  })
  .strict();

const OBSERVED_KINDS = ["danger", "scene", "overworld", "battle", "dialog", "menu"] as const;

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
  /**
   * The screen. Anchored to the tile the player stands on, it carries labelled
   * tile axes — an external agent driving this body reads `walk_to` coordinates
   * off the picture instead of guessing them, same as Clankie does (ADR 0120).
   */
  framePng: (anchor?: { readonly playerX: number; readonly playerY: number }) => Uint8Array | null;
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
  // The observations were just read; the overworld one carries where he stands,
  // which is what turns the picture into a coordinate frame.
  const standing = observations
    .flatMap(
      (observation) => (observation as { data?: { position?: { x?: unknown; y?: unknown } } }).data ?? [],
    )
    .map((data) => (data as { position?: { x?: unknown; y?: unknown } }).position)
    .find((position) => typeof position?.x === "number" && typeof position?.y === "number") as
    | { readonly x: number; readonly y: number }
    | undefined;
  const frame = context.framePng(
    standing === undefined ? undefined : { playerX: standing.x, playerY: standing.y },
  );
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
