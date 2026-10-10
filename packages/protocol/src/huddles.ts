import { z } from "zod";

/**
 * Huddles (VUH-2025): a lead asks every seat in a project, or the whole fleet,
 * what it is on, what blocks it, and which files it will land when. Seats
 * answer between steps without stopping work; Clankie compiles a landing order
 * that sequences seats touching the same files, and the blockers.
 *
 * `GET /v1/huddles` lists recent huddles, newest first, each complete.
 * `POST /v1/huddles` starts one. `POST /v1/huddles/close` with `{ id }` stops
 * collecting and tells the lead what arrived. Owner or Take Control authority;
 * fixed paths so every relay and gateway allowlist names them exactly.
 */
export const HUDDLES_PATH = "/v1/huddles";
export const HUDDLE_CLOSE_PATH = "/v1/huddles/close";

export const HuddleIdSchema = z.string().regex(/^hud_[a-z0-9]{12}$/u);
export const HUDDLE_FILES_MAX = 64;

/** What a seat sends back: three fields, in its own words. */
export const HuddleAnswerSchema = z
  .object({
    huddle: HuddleIdSchema,
    /** What it is working on now. */
    on: z.string().trim().min(1).max(500),
    /** What blocks it, or null when nothing does. */
    blocked: z.string().trim().min(1).max(500).nullable(),
    /** True when the blocker costs other seats or the owner time too. */
    blockerUrgent: z.boolean().optional(),
    landing: z
      .object({
        /** Repo-relative paths it will change; empty when it lands nothing. */
        files: z.array(z.string().trim().min(1).max(512)).max(HUDDLE_FILES_MAX),
        /** When it expects to land: an ISO time, or minutes from now. */
        eta: z.iso.datetime({ offset: true }).optional(),
        etaMinutes: z
          .number()
          .int()
          .min(0)
          .max(7 * 24 * 60)
          .optional(),
        /** The repository it lands in, when not the huddle's default. */
        repo: z.string().trim().min(1).max(256).optional(),
      })
      .strict(),
  })
  .strict();
export type HuddleAnswer = z.infer<typeof HuddleAnswerSchema>;

export const HuddleSeatSchema = z.object({
  seatId: z.string(),
  paneId: z.string().optional(),
  title: z.string(),
  harness: z.string(),
  fleet: z.string().optional(),
  workingDirectory: z.string().optional(),
  /** How the request reached it. */
  delivery: z.enum(["delivered", "unconfirmed", "undelivered", "offline"]),
  answeredAt: z.iso.datetime().optional(),
  on: z.string().optional(),
  blocked: z.string().nullable().optional(),
  blockerUrgent: z.boolean().optional(),
  files: z.array(z.string()).optional(),
  /** Normalised landing time. */
  eta: z.iso.datetime().optional(),
  repo: z.string().optional(),
});
export type HuddleSeat = z.infer<typeof HuddleSeatSchema>;

/** One step of the landing order. Seats sharing files land one after another, by ETA. */
export const HuddleLandingStepSchema = z.object({
  position: z.number().int().positive(),
  seatId: z.string(),
  title: z.string(),
  files: z.array(z.string()),
  eta: z.iso.datetime().optional(),
  /** Seats that must land first because they touch the same files. */
  after: z.array(z.object({ seatId: z.string(), title: z.string(), files: z.array(z.string()) })),
});
export type HuddleLandingStep = z.infer<typeof HuddleLandingStepSchema>;

export const HuddleBlockerSchema = z.object({
  seatId: z.string(),
  title: z.string(),
  blocked: z.string(),
  urgent: z.boolean(),
});
export type HuddleBlocker = z.infer<typeof HuddleBlockerSchema>;

export const HuddleSchema = z.object({
  id: HuddleIdSchema,
  /** The project it gathered, or the whole fleet. */
  project: z.string().optional(),
  /** The lead conversation that hears the compiled result. */
  conversationId: z.string(),
  startedAt: z.iso.datetime(),
  /** Answers arriving after this still count; the lead is told at the latest then. */
  dueAt: z.iso.datetime(),
  status: z.enum(["gathering", "compiled", "closed"]),
  compiledAt: z.iso.datetime().optional(),
  seats: z.array(HuddleSeatSchema).max(256),
  landingOrder: z.array(HuddleLandingStepSchema),
  blockers: z.array(HuddleBlockerSchema),
});
export type Huddle = z.infer<typeof HuddleSchema>;

export const HuddleListSchema = z.object({
  schemaVersion: z.literal(1),
  huddles: z.array(HuddleSchema).max(32),
});
export type HuddleList = z.infer<typeof HuddleListSchema>;

export const StartHuddleSchema = z
  .object({
    /** Omit for the whole fleet. */
    project: z.string().trim().min(1).max(128).optional(),
    /** The lead conversation that hears the result; omit for Clankie's main conversation. */
    conversationId: z.string().trim().min(1).max(256).optional(),
    /** How long seats have before the lead hears what arrived, default 15. */
    windowMinutes: z.number().int().min(1).max(240).optional(),
  })
  .strict();
export type StartHuddle = z.infer<typeof StartHuddleSchema>;

/** What `GET`/`POST /v1/huddles` answer: the list, or the huddle just started. */
export const HuddlesResponseSchema = z.union([HuddleListSchema, HuddleSchema]);

export const CloseHuddleSchema = z.object({ id: HuddleIdSchema }).strict();
export type CloseHuddle = z.infer<typeof CloseHuddleSchema>;

/** Shared wording for every surface that shows a huddle. */
export const HUDDLE_WORDING = {
  title: "Huddle",
  summary: "Every seat says what it's on, what blocks it, and what it will land when; nobody stops working.",
  start: "Call a huddle",
  on: "On",
  blocked: "Blocked",
  landing: "Landing order",
  waiting: "Waiting for an answer",
  nothingBlocks: "Nothing blocks it",
} as const;
