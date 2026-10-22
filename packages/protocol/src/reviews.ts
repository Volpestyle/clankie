import { z } from "zod";
import { OperatorAgentRoleSchema } from "./agent-roles.ts";

/**
 * The standing review gate (ADR 0287). A project may name a reviewer: an exact
 * seat or a role its live seats hold. A worker's landing candidate is its
 * exact patch; the service hashes the bytes it stores, and a verdict binds to
 * that hash. Landing waits for APPROVE (or an owner/lead waiver) of exactly the
 * patch that lands.
 */
export const ProjectReviewSchema = z.union([
  z.object({ seat: z.string().trim().min(1).max(256) }).strict(),
  z.object({ role: OperatorAgentRoleSchema }).strict(),
]);
export type ProjectReview = z.infer<typeof ProjectReviewSchema>;

/** `git patch-id --verbatim` of the stored patch: base-independent, whitespace-exact. */
export const ReviewPatchIdSchema = z.string().regex(/^[0-9a-f]{40,64}$/u, "a git patch-id");
const CommitSchema = z.string().regex(/^[0-9a-f]{40,64}$/u, "a full commit id");
/** The patch is `git diff --binary BASE HEAD` bytes, base64 on the wire. */
export const REVIEW_PATCH_MAX_BYTES = 4 * 1024 * 1024;
const Base64Schema = z
  .string()
  .max(Math.ceil(REVIEW_PATCH_MAX_BYTES / 3) * 4)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/u);
const SingleLine = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine((value) => !/[\r\n]/u.test(value), "single line");

export const REVIEW_VERDICTS = ["approve", "changes"] as const;
export const ReviewVerdictKindSchema = z.enum(REVIEW_VERDICTS);

/** What an author's seat submits; the service attributes it from native proof, never these fields. */
export const ReviewSubmissionSchema = z
  .object({
    schemaVersion: z.literal(1),
    base: CommitSchema,
    head: CommitSchema,
    patchId: ReviewPatchIdSchema,
    patch: Base64Schema.min(4),
    /** The tracker issue this change belongs to, such as VUH-2616. */
    issue: SingleLine(64).optional(),
    summary: z.string().trim().min(1).max(4000),
    /** Links the reviewer should check: evidence, logs, runs. */
    evidence: z.array(SingleLine(2048)).max(20).default([]),
    /** The candidate this one answers; the service also links an author's earlier one. */
    supersedes: z.string().uuid().optional(),
    /**
     * The work-tree root the patch was read from, on the author's machine. It names the
     * candidate's project; older bridges omit it and the seat's own directory decides (VUH-2662).
     */
    checkout: z.string().min(1).max(4096).optional(),
  })
  .strict();
export type ReviewSubmission = z.infer<typeof ReviewSubmissionSchema>;

export const ReviewVerdictInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    candidateId: z.string().uuid(),
    /** Must equal the candidate's stored hash: a verdict names the patch it read. */
    patchId: ReviewPatchIdSchema,
    verdict: ReviewVerdictKindSchema,
    findings: z.array(z.string().trim().min(1).max(4000)).max(50).default([]),
    summary: z.string().trim().min(1).max(4000).optional(),
  })
  .strict()
  .refine((input) => input.verdict === "approve" || input.findings.length > 0, {
    message: "CHANGES names at least one concrete required change",
    path: ["findings"],
  });
export type ReviewVerdictInput = z.infer<typeof ReviewVerdictInputSchema>;

const ReviewSeatSchema = z
  .object({
    seatId: z.string().min(1).max(256),
    occupantId: z.string().min(1).max(256),
    harness: z.string().min(1).max(64),
    title: z.string().max(200).optional(),
  })
  .strict();
export type ReviewSeat = z.infer<typeof ReviewSeatSchema>;

export const ReviewWaiverSchema = z
  .object({
    actor: z.enum(["owner", "lead"]),
    /** The lead conversation that waived; absent for the owner. */
    conversationId: z.string().min(1).max(256).optional(),
    reason: z.string().trim().min(1).max(2000),
    at: z.string().datetime(),
  })
  .strict();
export type ReviewWaiver = z.infer<typeof ReviewWaiverSchema>;

export const REVIEW_STATUSES = ["awaiting_review", "changes", "approved", "waived", "superseded"] as const;
export const ReviewStatusSchema = z.enum(REVIEW_STATUSES);
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

export const ReviewCandidateSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().uuid(),
    projectId: z.string().min(1).max(64),
    status: ReviewStatusSchema,
    patchId: ReviewPatchIdSchema,
    /** sha256 of the stored patch bytes, for byte-exact comparison. */
    patchSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    bytes: z.number().int().nonnegative(),
    files: z.array(z.string().max(4096)).max(2000),
    base: CommitSchema,
    head: CommitSchema,
    issue: z.string().max(64).optional(),
    summary: z.string().max(4000),
    evidence: z.array(z.string().max(2048)).max(20),
    /** The submitting seat, from native proof; absent for a waiver recorded without one. */
    author: ReviewSeatSchema.optional(),
    supersedes: z.string().uuid().optional(),
    supersededBy: z.string().uuid().optional(),
    submittedAt: z.string().datetime(),
    /** The reviewer seat this candidate was sent to, and how far it got. */
    reviewer: ReviewSeatSchema.extend({
      deliveryStage: z.string().max(32),
      detail: z.string().max(1000).optional(),
      at: z.string().datetime(),
    })
      .strict()
      .optional(),
    verdict: z
      .object({
        verdict: ReviewVerdictKindSchema,
        findings: z.array(z.string().max(4000)).max(50),
        summary: z.string().max(4000).optional(),
        reviewer: ReviewSeatSchema,
        /** Author and reviewer ran the same harness: independence is weaker. */
        sameHarness: z.boolean(),
        at: z.string().datetime(),
      })
      .strict()
      .optional(),
    waiver: ReviewWaiverSchema.optional(),
  })
  .strict();
export type ReviewCandidate = z.infer<typeof ReviewCandidateSchema>;

export const ReviewCandidatesSchema = z
  .object({ schemaVersion: z.literal(1), candidates: z.array(ReviewCandidateSchema).max(500) })
  .strict();
export type ReviewCandidates = z.infer<typeof ReviewCandidatesSchema>;

/** What the landing gate asks: does this exact patch, from this checkout, have to wait? */
export const ReviewLandingQuerySchema = z
  .object({
    directory: z.string().min(1).max(4096),
    patchId: z.union([ReviewPatchIdSchema, z.literal("empty")]),
  })
  .strict();
export const ReviewLandingSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** False when the checkout's project names no reviewer, or the change is empty. */
    required: z.boolean(),
    projectId: z.string().max(64).optional(),
    patchId: z.string().max(64),
    /** `not_submitted` until a candidate for this exact patch exists. */
    status: z.union([ReviewStatusSchema, z.literal("not_submitted"), z.literal("not_required")]),
    landable: z.boolean(),
    candidate: ReviewCandidateSchema.optional(),
  })
  .strict();
export type ReviewLanding = z.infer<typeof ReviewLandingSchema>;

/** The owner waives review of one exact patch; the lead does the same through its own tool. */
export const ReviewWaiverInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    directory: z.string().min(1).max(4096),
    base: CommitSchema,
    head: CommitSchema,
    patchId: ReviewPatchIdSchema,
    patch: Base64Schema.min(4),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
export type ReviewWaiverInput = z.infer<typeof ReviewWaiverInputSchema>;

/** Seat routes take the author's or reviewer's native proof (ADR 0213), like peer messages. */
export const FLEET_REVIEW_CANDIDATES_PATH = "/v1/fleet/seats/:paneId/review-candidates";
export const FLEET_REVIEW_VERDICTS_PATH = "/v1/fleet/seats/:paneId/review-verdicts";
export const OPERATOR_REVIEWS_PATH = "/v1/operator/reviews";
export const OPERATOR_REVIEW_LANDING_PATH = "/v1/operator/reviews/landing";
export const OPERATOR_REVIEW_WAIVERS_PATH = "/v1/operator/reviews/waivers";
