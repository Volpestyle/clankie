import { z } from "zod";
import {
  OPERATOR_CONVERSATION_REF_MAX,
  OperatorConversationEventRefSchema,
  OperatorSurfaceClientIdSchema,
  OPERATOR_CONVERSATION_TITLE_MAX,
} from "./operator-conversations.ts";
import { isCanonicalBase64 } from "./base64.ts";

// ---------------------------------------------------------------------------
// Pane terminal observation (ADR 0138).
//
// Herdr owns terminal rendering and emits an initial full ANSI redraw followed
// by sequenced diffs. The operator boundary only pages those bounded bytes; it
// does not reconstruct a terminal or expose Herdr's private client socket.
// ---------------------------------------------------------------------------

export const OPERATOR_TERMINAL_TAIL_PATH = "/operator/v1/terminal-tail";
export const OPERATOR_TERMINAL_DIMENSION_MAX = 1_000;
export const OPERATOR_TERMINAL_FRAME_BASE64_MAX = 16 * 1024 * 1024;
export const OPERATOR_TERMINAL_TAIL_FRAMES_MAX = 64;
export const OPERATOR_TERMINAL_SCROLLBACK_ROWS_MAX = 1_000;

export const OperatorTerminalIdSchema = z.string().trim().min(1).max(OPERATOR_CONVERSATION_REF_MAX);
export type OperatorTerminalId = z.infer<typeof OperatorTerminalIdSchema>;

export const OperatorTerminalCursorSchema = z
  .object({
    streamId: OperatorConversationEventRefSchema,
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type OperatorTerminalCursor = z.infer<typeof OperatorTerminalCursorSchema>;

export const OperatorTerminalFrameSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal("terminal.frame"),
    terminalId: OperatorTerminalIdSchema,
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    encoding: z.literal("base64"),
    data: z
      .string()
      .max(OPERATOR_TERMINAL_FRAME_BASE64_MAX)
      .refine((value) => value.length === 0 || isCanonicalBase64(value), {
        message: "expected canonical base64",
      }),
    columns: z.number().int().positive().max(OPERATOR_TERMINAL_DIMENSION_MAX),
    rows: z.number().int().positive().max(OPERATOR_TERMINAL_DIMENSION_MAX),
    /** A full frame resets the native renderer; later frames are ANSI diffs. */
    full: z.boolean(),
    /** Styled rows that entered history without mutating the live viewport. */
    scrollback: z
      .object({
        encoding: z.literal("base64"),
        data: z
          .string()
          .max(OPERATOR_TERMINAL_FRAME_BASE64_MAX)
          .refine(isCanonicalBase64, { message: "expected non-empty canonical base64" }),
        rows: z.number().int().positive().max(OPERATOR_TERMINAL_SCROLLBACK_ROWS_MAX),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((frame, context) => {
    if (frame.data.length === 0 && frame.scrollback === undefined) {
      context.addIssue({ code: "custom", path: ["data"], message: "terminal frame is empty" });
    }
    if (frame.full && frame.data.length === 0) {
      context.addIssue({ code: "custom", path: ["data"], message: "full terminal frame is empty" });
    }
    if (frame.data.length + (frame.scrollback?.data.length ?? 0) > OPERATOR_TERMINAL_FRAME_BASE64_MAX) {
      context.addIssue({
        code: "custom",
        path: ["scrollback"],
        message: "terminal frame exceeds byte bound",
      });
    }
  });
export type OperatorTerminalFrame = z.infer<typeof OperatorTerminalFrameSchema>;

export const OperatorTerminalObservationRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    terminalId: OperatorTerminalIdSchema,
    surfaceClientId: OperatorSurfaceClientIdSchema,
    columns: z.number().int().positive().max(OPERATOR_TERMINAL_DIMENSION_MAX).optional(),
    rows: z.number().int().positive().max(OPERATOR_TERMINAL_DIMENSION_MAX).optional(),
    cursor: OperatorTerminalCursorSchema.optional(),
    limit: z.number().int().positive().max(OPERATOR_TERMINAL_TAIL_FRAMES_MAX).optional(),
  })
  .strict();
export type OperatorTerminalObservationRequest = z.infer<typeof OperatorTerminalObservationRequestSchema>;

export const OperatorTerminalObservationPageSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal("page"),
    terminalId: OperatorTerminalIdSchema,
    surfaceClientId: OperatorSurfaceClientIdSchema,
    cursor: OperatorTerminalCursorSchema,
    frames: z.array(OperatorTerminalFrameSchema).max(OPERATOR_TERMINAL_TAIL_FRAMES_MAX),
    hasMore: z.boolean(),
  })
  .strict()
  .superRefine((page, context) => {
    if (
      page.frames.reduce(
        (total, frame) => total + frame.data.length + (frame.scrollback?.data.length ?? 0),
        0,
      ) > OPERATOR_TERMINAL_FRAME_BASE64_MAX
    ) {
      context.addIssue({ code: "custom", path: ["frames"], message: "terminal page exceeds byte bound" });
    }
    for (const [index, frame] of page.frames.entries()) {
      if (frame.terminalId !== page.terminalId) {
        context.addIssue({
          code: "custom",
          path: ["frames", index, "terminalId"],
          message: "terminal frame belongs to another terminal",
        });
      }
      if (index > 0 && frame.sequence !== page.frames[index - 1]!.sequence + 1) {
        context.addIssue({
          code: "custom",
          path: ["frames", index, "sequence"],
          message: "terminal page frames must be contiguous",
        });
      }
    }
    const last = page.frames.at(-1);
    if (last !== undefined && last.sequence !== page.cursor.sequence) {
      context.addIssue({
        code: "custom",
        path: ["cursor", "sequence"],
        message: "terminal page cursor must follow its last frame",
      });
    }
  });
export type OperatorTerminalObservationPage = z.infer<typeof OperatorTerminalObservationPageSchema>;

export const OperatorTerminalObservationResetSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal("reset"),
    terminalId: OperatorTerminalIdSchema,
    surfaceClientId: OperatorSurfaceClientIdSchema,
    reason: z.enum(["stream_lost", "sequence_expired"]),
  })
  .strict();
export type OperatorTerminalObservationReset = z.infer<typeof OperatorTerminalObservationResetSchema>;

export const OperatorTerminalObservationUnavailableSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal("unavailable"),
    terminalId: OperatorTerminalIdSchema,
    surfaceClientId: OperatorSurfaceClientIdSchema,
    reason: z.enum(["herdr_unavailable", "terminal_unavailable", "observer_closed", "invalid_frame"]),
  })
  .strict();
export type OperatorTerminalObservationUnavailable = z.infer<
  typeof OperatorTerminalObservationUnavailableSchema
>;

export const OperatorTerminalObservationResultSchema = z.discriminatedUnion("status", [
  OperatorTerminalObservationPageSchema,
  OperatorTerminalObservationResetSchema,
  OperatorTerminalObservationUnavailableSchema,
]);
export type OperatorTerminalObservationResult = z.infer<typeof OperatorTerminalObservationResultSchema>;

export const OperatorTerminalTailItemSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("frame"),
      streamId: OperatorConversationEventRefSchema,
      frame: OperatorTerminalFrameSchema,
    })
    .strict(),
  z.object({ kind: z.literal("reset"), reset: OperatorTerminalObservationResetSchema }).strict(),
  z
    .object({ kind: z.literal("unavailable"), unavailable: OperatorTerminalObservationUnavailableSchema })
    .strict(),
  z
    .object({
      kind: z.literal("auth_failure"),
      failure: z
        .object({
          schemaVersion: z.literal(1),
          outcome: z.literal("auth_failed"),
          reason: z.enum(["invalid", "expired", "revoked", "unavailable", "terminal_observe_grant_required"]),
        })
        .strict(),
    })
    .strict(),
]);
export type OperatorTerminalTailItem = z.infer<typeof OperatorTerminalTailItemSchema>;

// ---------------------------------------------------------------------------
// Pane terminal control (ADR 0144) — the write side of ADR 0138's observation.
//
// A device surface holds one renewable exclusive lease per terminal and rides
// raw VT bytes on it. Herdr's separate terminal control session applies those
// bytes; this boundary never interprets them. Requires the terminalControl
// grant end to end.
// ---------------------------------------------------------------------------

/** One write is keystrokes or a composer draft, never a bulk transfer. */
export const OPERATOR_TERMINAL_INPUT_BASE64_MAX = 32 * 1024;

export const OperatorTerminalLeaseTokenSchema = z.string().trim().min(1).max(OPERATOR_CONVERSATION_REF_MAX);
export type OperatorTerminalLeaseToken = z.infer<typeof OperatorTerminalLeaseTokenSchema>;

export const OperatorTerminalControlOwnerSchema = z
  .object({
    principalId: z.string().trim().min(1).max(OPERATOR_CONVERSATION_REF_MAX),
    displayName: z.string().trim().min(1).max(OPERATOR_CONVERSATION_TITLE_MAX).optional(),
  })
  .strict();
export type OperatorTerminalControlOwner = z.infer<typeof OperatorTerminalControlOwnerSchema>;

export const OperatorTerminalControlGrantSchema = z
  .object({
    schemaVersion: z.literal(1),
    terminalId: OperatorTerminalIdSchema,
    leaseToken: OperatorTerminalLeaseTokenSchema,
    owner: OperatorTerminalControlOwnerSchema,
    expiresAt: z.string().datetime(),
  })
  .strict();
export type OperatorTerminalControlGrant = z.infer<typeof OperatorTerminalControlGrantSchema>;

export const OperatorTerminalControlRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    action: z.enum(["request", "renew", "release", "resize", "scroll"]),
    terminalId: OperatorTerminalIdSchema,
    surfaceClientId: OperatorSurfaceClientIdSchema,
    /** Required for renew, release, resize, and scroll; ignored for request. */
    leaseToken: OperatorTerminalLeaseTokenSchema.optional(),
    columns: z.number().int().positive().max(OPERATOR_TERMINAL_DIMENSION_MAX).optional(),
    rows: z.number().int().positive().max(OPERATOR_TERMINAL_DIMENSION_MAX).optional(),
    /**
     * A scroll the surface could not absorb from its own history. Herdr routes
     * it by the pane's modes (wheel report, cursor keys, or pane scrollback);
     * `column`/`row` name the viewport cell a wheel report is stamped with.
     */
    direction: z.enum(["up", "down"]).optional(),
    lines: z.number().int().positive().max(OPERATOR_TERMINAL_DIMENSION_MAX).optional(),
    column: z.number().int().nonnegative().max(OPERATOR_TERMINAL_DIMENSION_MAX).optional(),
    row: z.number().int().nonnegative().max(OPERATOR_TERMINAL_DIMENSION_MAX).optional(),
  })
  .strict()
  .superRefine((request, context) => {
    const hasGeometry = request.columns !== undefined || request.rows !== undefined;
    if (request.action === "resize" && (request.columns === undefined || request.rows === undefined)) {
      context.addIssue({ code: "custom", path: ["columns"], message: "resize requires columns and rows" });
    } else if (request.action !== "resize" && hasGeometry) {
      context.addIssue({ code: "custom", path: ["columns"], message: "geometry is only valid for resize" });
    }
    const hasScroll =
      request.direction !== undefined ||
      request.lines !== undefined ||
      request.column !== undefined ||
      request.row !== undefined;
    if (request.action === "scroll" && (request.direction === undefined || request.lines === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["direction"],
        message: "scroll requires direction and lines",
      });
    } else if (request.action !== "scroll" && hasScroll) {
      context.addIssue({
        code: "custom",
        path: ["direction"],
        message: "scroll fields are only valid for scroll",
      });
    }
  });
export type OperatorTerminalControlRequest = z.infer<typeof OperatorTerminalControlRequestSchema>;

export const OperatorTerminalControlResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      schemaVersion: z.literal(1),
      status: z.literal("granted"),
      grant: OperatorTerminalControlGrantSchema,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      status: z.literal("released"),
      terminalId: OperatorTerminalIdSchema,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      status: z.literal("contended"),
      terminalId: OperatorTerminalIdSchema,
      owner: OperatorTerminalControlOwnerSchema,
      expiresAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      status: z.literal("denied"),
      terminalId: OperatorTerminalIdSchema,
      reason: z.enum(["lease_required", "lease_expired"]),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      status: z.literal("unavailable"),
      terminalId: OperatorTerminalIdSchema,
      reason: z.enum(["herdr_unavailable", "terminal_unavailable", "controller_closed"]),
    })
    .strict(),
]);
export type OperatorTerminalControlResult = z.infer<typeof OperatorTerminalControlResultSchema>;

export const OperatorTerminalInputRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    terminalId: OperatorTerminalIdSchema,
    surfaceClientId: OperatorSurfaceClientIdSchema,
    leaseToken: OperatorTerminalLeaseTokenSchema,
    /** Raw VT bytes exactly as the device keyboard produced them. */
    dataBase64: z
      .string()
      .max(OPERATOR_TERMINAL_INPUT_BASE64_MAX)
      .refine(isCanonicalBase64, { message: "expected non-empty canonical base64" }),
  })
  .strict();
export type OperatorTerminalInputRequest = z.infer<typeof OperatorTerminalInputRequestSchema>;

export const OperatorTerminalInputResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      schemaVersion: z.literal(1),
      status: z.literal("delivered"),
      terminalId: OperatorTerminalIdSchema,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      status: z.literal("denied"),
      terminalId: OperatorTerminalIdSchema,
      reason: z.enum(["lease_required", "lease_expired"]),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      status: z.literal("contended"),
      terminalId: OperatorTerminalIdSchema,
      owner: OperatorTerminalControlOwnerSchema,
      expiresAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      status: z.literal("unavailable"),
      terminalId: OperatorTerminalIdSchema,
      reason: z.enum(["herdr_unavailable", "terminal_unavailable", "controller_closed"]),
    })
    .strict(),
]);
export type OperatorTerminalInputResult = z.infer<typeof OperatorTerminalInputResultSchema>;
