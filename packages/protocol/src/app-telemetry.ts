import { z } from "zod";

/**
 * Node-free contract for the companion app's diagnostics: timings and failure
 * codes the app posts to the public gateway, which validates them and records
 * one metadata-only log line per event (VUH-1364). No field can carry a
 * message, a prompt, terminal bytes, a URL, a device name or a credential:
 * events are closed names, numbers and short codes, and an unknown field
 * rejects the whole batch.
 *
 * `POST /gateway/v1/telemetry`, `content-type: application/json`, no
 * Authorization header. `202 { accepted }` on success; `400 invalid_telemetry`,
 * `413 telemetry_too_large` or `429 telemetry_throttled` (with `Retry-After`)
 * otherwise. The app drops a batch it could not deliver within an hour.
 */
export const APP_TELEMETRY_PATH = "/gateway/v1/telemetry";
export const APP_TELEMETRY_BODY_BYTES_MAX = 8 * 1024;
export const APP_TELEMETRY_EVENTS_MAX = 32;

/** What each event measures. Durations are milliseconds from the first step to the last. */
export const AppTelemetryEventNameSchema = z.enum([
  /** Scan or paste → paired. */
  "app.pairing",
  /** Connection loss → first successful exchange. */
  "app.reconnect",
  /** Wake tap → body answering (`wakeId`). */
  "app.wake",
  /** Send → host acknowledgement. */
  "app.send_ack",
  /** Send → first reply token rendered. */
  "app.first_reply",
  /** Terminal open → first verified frame. */
  "app.terminal_first_frame",
  /** Longest gap between verified terminal frames in one session (`maxGapMs`). */
  "app.terminal_frame_gap",
]);
export type AppTelemetryEventName = z.infer<typeof AppTelemetryEventNameSchema>;

/** Credential shapes a code or id must never resemble. */
const KEY_SHAPED = /(?:^|[^a-z0-9])(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs]|glpat|akia|asia)[_-]/iu;
const notKeyShaped = (value: string) => !KEY_SHAPED.test(value);

/** A protocol error code (`invalid_encrypted_request`) or a platform one (`NSURLErrorTimedOut`, `-1001`). */
export const AppTelemetryCodeSchema = z
  .string()
  .regex(/^-?[A-Za-z0-9_.]{1,64}$/u)
  .refine(notKeyShaped, "a code must not look like a credential");
const OpaqueIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/u)
  .refine(notKeyShaped, "an id must not look like a credential");
const DurationMsSchema = z
  .number()
  .int()
  .nonnegative()
  .max(24 * 3_600_000);

export const AppTelemetryEventSchema = z
  .object({
    event: AppTelemetryEventNameSchema,
    /** When the measured step ended, device clock. */
    atMs: z.number().int().positive(),
    outcome: z.enum(["ok", "error", "cancelled"]),
    durationMs: DurationMsSchema.optional(),
    code: AppTelemetryCodeSchema.optional(),
    /** The gateway's `x-clankie-request-id` for the exchange, when there was one. */
    requestId: OpaqueIdSchema.optional(),
    wakeId: OpaqueIdSchema.optional(),
    maxGapMs: DurationMsSchema.optional(),
  })
  .strict();
export type AppTelemetryEvent = z.infer<typeof AppTelemetryEventSchema>;

export const AppTelemetryBatchSchema = z
  .object({
    v: z.literal(1),
    /** The host route this app is paired with (same shape as a public gateway host id). */
    hostId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/u),
    /** The keyed device reference the body issued at pairing; absent until it does. */
    deviceRef: z
      .string()
      .regex(/^dv[0-9]_[A-Za-z0-9_-]{22}$/u)
      .optional(),
    platform: z.enum(["ios", "ipados", "macos", "android"]),
    appVersion: z.string().regex(/^[0-9]{1,4}(?:\.[0-9]{1,4}){1,3}(?:[-+][0-9A-Za-z.]{1,32})?$/u),
    events: z.array(AppTelemetryEventSchema).min(1).max(APP_TELEMETRY_EVENTS_MAX),
  })
  .strict();
export type AppTelemetryBatch = z.infer<typeof AppTelemetryBatchSchema>;

export const AppTelemetryAcceptedSchema = z.object({ accepted: z.number().int().nonnegative() }).strict();
export type AppTelemetryAccepted = z.infer<typeof AppTelemetryAcceptedSchema>;

export const AppTelemetryErrorCodeSchema = z.enum([
  "invalid_telemetry",
  "telemetry_too_large",
  "telemetry_throttled",
]);
export type AppTelemetryErrorCode = z.infer<typeof AppTelemetryErrorCodeSchema>;
