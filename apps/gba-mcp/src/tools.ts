import {
  GbaEmulatorActionSchema,
  GbaEmulatorObservationKindSchema,
  type GbaEmulatorObservation,
} from "@clankie/interactive-environment";
import type { GbaDriverIo } from "@clankie/gba-emulator";
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
    actionKind: z.enum(["button_press", "frame_advance", "wait"]),
    button: z
      .enum(["up", "down", "left", "right", "a", "b", "start", "select", "l", "r"])
      .optional()
      .describe("Required for button_press."),
    holdFrames: z
      .number()
      .int()
      .optional()
      .describe("Frames to hold. 16 reliably commits a step; a short tap only turns."),
    repeat: z.number().int().optional().describe("Press this many times in one action (max 16)."),
    frames: z.number().int().optional().describe("Required for frame_advance."),
    durationMs: z.number().int().optional().describe("Required for wait."),
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

export interface GbaToolContext {
  io: GbaDriverIo;
  framePng: () => Uint8Array | null;
  /** Refuses gameplay when another holder owns the body (P2). */
  assertMayAct?: () => void;
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
    context.assertMayAct?.();
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

function errorResult(error: unknown): McpToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message.slice(0, 500) }], isError: true };
}
