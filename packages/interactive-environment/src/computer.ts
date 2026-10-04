import { createHash } from "node:crypto";
import { z } from "zod";
import { EnvironmentLeaseV2Schema } from "./environment.ts";
import { RenderedSurfaceFrameSchema, RENDERED_SURFACE_QUEUE_MAX } from "./rendered-surface.ts";

export const COMPUTER_FRAME_MAX_BYTES = 16 * 1024 * 1024;
export const COMPUTER_FRAME_QUEUE_MAX = RENDERED_SURFACE_QUEUE_MAX;
const id = z.string().trim().min(1).max(512);
const point = z.strictObject({ x: z.number().finite(), y: z.number().finite() });
const size = z.strictObject({
  width: z.number().positive().max(16384),
  height: z.number().positive().max(16384),
});
export const ComputerTargetSchema = z.strictObject({ appId: id, windowId: id });
export type ComputerTarget = z.infer<typeof ComputerTargetSchema>;
export const ComputerCoordinatesSchema = z.strictObject({
  space: z.literal("global_display_points"),
  origin: z.literal("top_left"),
  bounds: point.extend(size.shape).strict(),
});
export type ComputerCoordinates = z.infer<typeof ComputerCoordinatesSchema>;

/** The environment lease clock/identity conventions, bound to one computer and conversation. */
export const ComputerLeaseSchema = z
  .strictObject({
    schemaVersion: z.literal(1).default(1),
    bodyId: id,
    conversationId: id,
    leaseId: EnvironmentLeaseV2Schema.shape.leaseId,
    issuedAt: EnvironmentLeaseV2Schema.shape.issuedAt,
    heartbeatAt: EnvironmentLeaseV2Schema.shape.heartbeatAt,
    expiresAt: EnvironmentLeaseV2Schema.shape.expiresAt,
  })
  .refine(
    (v) =>
      Date.parse(v.issuedAt) <= Date.parse(v.heartbeatAt) &&
      Date.parse(v.heartbeatAt) < Date.parse(v.expiresAt),
    "Invalid lease clock order",
  );
export type ComputerLease = z.infer<typeof ComputerLeaseSchema>;

export const ComputerScreenshotSchema = z.strictObject({
  schemaVersion: z.literal(1).default(1),
  screenshotId: z.uuid(),
  bodyId: id,
  conversationId: id,
  leaseId: id,
  sequence: z.number().int().nonnegative(),
  capturedAt: RenderedSurfaceFrameSchema.shape.capturedAt,
  expiresAt: z.string().datetime(),
  target: ComputerTargetSchema,
  width: z.number().int().positive().max(16384),
  height: z.number().int().positive().max(16384),
  coordinates: ComputerCoordinatesSchema,
  inputReady: z.boolean(),
  elements: z.array(z.strictObject({ id, label: z.string().max(4096), actionable: z.boolean() })).max(1600),
  sha256: RenderedSurfaceFrameSchema.shape.sha256,
});
export type ComputerScreenshot = z.infer<typeof ComputerScreenshotSchema>;

/** Separate bounded media plane. No screenshot bytes belong in semantic action receipts. */
export const ComputerFrameSchema = z
  .strictObject({
    schemaVersion: z.literal(1).default(1),
    screenshotId: z.uuid(),
    encoding: RenderedSurfaceFrameSchema.shape.encoding,
    data: z
      .string()
      .min(1)
      .max(Math.ceil(COMPUTER_FRAME_MAX_BYTES / 3) * 4),
    byteLength: z.number().int().positive().max(COMPUTER_FRAME_MAX_BYTES),
    sha256: RenderedSurfaceFrameSchema.shape.sha256,
  })
  .superRefine((v, ctx) => {
    const bytes = Buffer.from(v.data, "base64");
    if (
      bytes.length !== v.byteLength ||
      bytes.toString("base64") !== v.data ||
      createHash("sha256").update(bytes).digest("hex") !== v.sha256
    )
      ctx.addIssue({ code: "custom", message: "Frame length, encoding or digest mismatch" });
  });
export type ComputerFrame = z.infer<typeof ComputerFrameSchema>;

export const ComputerInventorySchema = z.strictObject({
  schemaVersion: z.literal(1).default(1),
  bodyId: id,
  observedAt: z.string().datetime(),
  complete: z.boolean(),
  apps: z.array(z.strictObject({ appId: id, name: id })).max(512),
  windows: z.array(ComputerTargetSchema.extend({ title: z.string().max(4096) }).strict()).max(2048),
});
export type ComputerInventory = z.infer<typeof ComputerInventorySchema>;
const pixel = z.strictObject({
  x: z.number().nonnegative().max(16384),
  y: z.number().nonnegative().max(16384),
});
export const ComputerInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    foreground: z.boolean().default(false),
    kind: z.literal("click"),
    at: pixel,
    button: z.enum(["left", "right"]).default("left"),
  }),
  z.strictObject({ foreground: z.boolean().default(false), kind: z.literal("element"), elementId: id }),
  z.strictObject({
    foreground: z.boolean().default(false),
    kind: z.literal("type"),
    text: z.string().min(1).max(16384),
    clear: z.boolean().default(false),
  }),
  z.strictObject({
    foreground: z.boolean().default(false),
    kind: z.literal("key"),
    keys: z.string().min(1).max(256),
  }),
  z.strictObject({
    foreground: z.boolean().default(false),
    kind: z.literal("scroll"),
    direction: z.enum(["up", "down", "left", "right"]),
    amount: z.number().int().min(1).max(100),
  }),
  z.strictObject({ foreground: z.boolean().default(false), kind: z.literal("drag"), from: pixel, to: pixel }),
]);
export type ComputerInput = z.infer<typeof ComputerInputSchema>;
export const ComputerReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1).default(1),
  requestId: z.uuid(),
  bodyId: id,
  conversationId: id,
  leaseId: id,
  screenshotId: z.uuid(),
  completedAt: z.string().datetime(),
  outcome: z.enum(["confirmed", "failed", "uncertain"]),
  inputs: z
    .array(
      z.strictObject({
        index: z.number().int().nonnegative(),
        outcome: z.enum(["confirmed", "failed", "uncertain"]),
        detail: z.string().max(4096),
      }),
    )
    .max(64),
  reason: z.string().max(4096).optional(),
});
export type ComputerReceipt = z.infer<typeof ComputerReceiptSchema>;
const leased = { leaseId: id };
export const ComputerCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("status") }),
  z.strictObject({
    action: z.literal("acquire"),
    ttlMs: z.number().int().min(1).max(300000).default(300000),
  }),
  z.strictObject({
    action: z.literal("renew"),
    ...leased,
    ttlMs: z.number().int().min(1).max(300000).default(300000),
  }),
  z.strictObject({ action: z.literal("release"), ...leased }),
  z.strictObject({ action: z.literal("revoke"), ...leased }),
  z.strictObject({ action: z.literal("recover") }),
  z.strictObject({ action: z.literal("inventory"), ...leased }),
  z.strictObject({
    action: z.literal("capture"),
    ...leased,
    target: ComputerTargetSchema,
    capture: z.enum(["normal", "classic_read_only"]).default("normal"),
  }),
  z.strictObject({ action: z.literal("frame"), ...leased, screenshotId: z.uuid() }),
  z.strictObject({
    action: z.literal("input"),
    ...leased,
    requestId: z.uuid(),
    screenshotId: z.uuid(),
    inputs: z.array(ComputerInputSchema).min(1).max(64),
  }),
]);
export type ComputerCommand = z.infer<typeof ComputerCommandSchema>;
export const ComputerRequestSchema = z.strictObject({ conversationId: id, command: ComputerCommandSchema });

/** Image-local pixels, including retina/ROI captures, map through the actual capture bounds. */
export function computerPoint(
  screenshot: ComputerScreenshot,
  input: { x: number; y: number },
): { x: number; y: number } {
  if (
    !Number.isFinite(input.x) ||
    !Number.isFinite(input.y) ||
    input.x < 0 ||
    input.y < 0 ||
    input.x >= screenshot.width ||
    input.y >= screenshot.height
  )
    throw new Error("Point outside screenshot");
  const b = screenshot.coordinates.bounds;
  return {
    x: b.x + (input.x * b.width) / screenshot.width,
    y: b.y + (input.y * b.height) / screenshot.height,
  };
}
