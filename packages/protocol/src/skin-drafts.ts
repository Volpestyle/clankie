import { z } from "zod";
import { GenerateImageResultSchema } from "./media.ts";

export const SKIN_DRAFTS_PATH = "/v1/operator/skin-drafts";
export const SKIN_KEY_POSES = ["rest", "work", "comms"] as const;
export const SkinKeyPoseSchema = z.enum(SKIN_KEY_POSES);
const Sha = z.string().regex(/^[a-f0-9]{64}$/u);
const Id = z.uuid().toLowerCase();
const Description = z.string().trim().min(1).max(4000);
export const SkinDraftReferenceSchema = z
  .object({
    conversationId: z.string().min(1).max(256),
    artifactId: z.string().regex(/^[a-f0-9]{48}$/u),
  })
  .strict();
const RGB = z.tuple([
  z.number().int().min(0).max(255),
  z.number().int().min(0).max(255),
  z.number().int().min(0).max(255),
]);
export const SkinPoseSamplingSchema = z
  .object({
    grid: z
      .object({
        pitch: z.number().min(1).max(16384),
        x: z.number().min(0).max(16384).optional(),
        y: z.number().min(0).max(16384).optional(),
        columns: z.number().int().min(1).max(32),
        rows: z.number().int().min(1).max(96),
      })
      .strict(),
    background: RGB.optional(),
    backgroundTolerance: z.number().min(0).max(255).optional(),
    colors: z.number().int().min(1).max(64).optional(),
  })
  .strict();
const SourceBytes = {
  sha256: Sha,
  mediaType: z.enum(["image/png", "image/jpeg"]),
  byteCount: z
    .number()
    .int()
    .positive()
    .max(16 * 1024 * 1024),
};
export const SkinGeneratedReferenceSchema = z
  .object({
    generationRequestId: Id,
    pose: SkinKeyPoseSchema,
  })
  .strict();
export const SkinDraftSourceSchema = z.union([
  SkinDraftReferenceSchema.extend(SourceBytes).strict(),
  SkinGeneratedReferenceSchema.extend({
    ...SourceBytes,
    provider: z.string().min(1).max(128),
    model: z.string().min(1).max(256),
  }).strict(),
]);
export const SkinGenerationSchema = z
  .object({
    requestId: Id,
    inputRevision: Sha,
    description: Description,
    state: z.enum(["running", "complete", "refused", "uncertain"]),
    createdAt: z.iso.datetime(),
    steps: z
      .array(
        z
          .object({
            pose: SkinKeyPoseSchema,
            state: z.enum(["dispatching", "complete", "refused", "uncertain"]),
            source: SkinDraftSourceSchema.optional(),
            receipt: GenerateImageResultSchema.optional(),
            detail: z.string().max(500).optional(),
          })
          .strict(),
      )
      .max(3),
  })
  .strict();
const Pose = z
  .object({
    source: SkinDraftSourceSchema,
    sampling: SkinPoseSamplingSchema,
    sha256: Sha,
    width: z.number().int().min(1).max(32),
    height: z.number().int().min(1).max(96),
    palette: z.array(RGB).min(1).max(64),
  })
  .strict();
export const SkinDraftSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: Id,
    owner: Sha,
    version: z.number().int().min(1).max(64),
    revision: Sha,
    description: Description,
    state: z.enum(["awaiting_poses", "awaiting_approval", "approved", "declined", "cancelled"]),
    generation: z.enum(["not_requested", "running", "complete", "refused", "uncertain"]),
    generations: z.array(SkinGenerationSchema).max(16).optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    reference: SkinDraftSourceSchema.optional(),
    poses: z.object({ rest: Pose.optional(), work: Pose.optional(), comms: Pose.optional() }).strict(),
    approval: z
      .object({
        owner: Sha,
        actor: z.object({ kind: z.enum(["operator", "device"]), id: z.string().min(1).max(256) }).strict(),
        revision: Sha,
        poseDigests: z.object({ rest: Sha, work: Sha, comms: Sha }).strict(),
        approvedAt: z.iso.datetime(),
      })
      .strict()
      .optional(),
  })
  .strict();
const Fenced = { draftId: Id, expectedRevision: Sha };
export const SkinDraftCommandSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("create"),
      requestId: Id,
      description: Description,
      reference: SkinDraftReferenceSchema.optional(),
    })
    .strict(),
  z.object({ action: z.literal("list") }).strict(),
  z
    .object({ action: z.literal("get"), draftId: Id, version: z.number().int().min(1).max(64).optional() })
    .strict(),
  z
    .object({
      action: z.literal("pose"),
      ...Fenced,
      pose: SkinKeyPoseSchema,
      source: z.union([SkinDraftReferenceSchema, SkinGeneratedReferenceSchema]),
      sampling: SkinPoseSamplingSchema,
    })
    .strict(),
  z.object({ action: z.literal("revise"), ...Fenced, description: Description }).strict(),
  z.object({ action: z.literal("generate"), ...Fenced, requestId: Id }).strict(),
  z.object({ action: z.enum(["approve", "decline", "cancel"]), ...Fenced }).strict(),
]);
export const SkinDraftResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("draft"), draft: SkinDraftSchema }).strict(),
  z.object({ outcome: z.literal("list"), drafts: z.array(SkinDraftSchema).max(128) }).strict(),
]);
export type SkinDraft = z.infer<typeof SkinDraftSchema>;
export type SkinDraftCommand = z.infer<typeof SkinDraftCommandSchema>;
export type SkinDraftReference = z.infer<typeof SkinDraftReferenceSchema>;
export type SkinDraftSource = z.infer<typeof SkinDraftSourceSchema>;
export type SkinPoseInput = SkinDraftReference | z.infer<typeof SkinGeneratedReferenceSchema>;
export type SkinGeneration = z.infer<typeof SkinGenerationSchema>;
export type SkinDraftResult = z.infer<typeof SkinDraftResultSchema>;
export type SkinKeyPose = z.infer<typeof SkinKeyPoseSchema>;

/** Exact device projection only; reject encoded paths and unknown query authority. */
export function isSkinDraftRoute(method: string, path: string): boolean {
  if (path === SKIN_DRAFTS_PATH) return method === "GET" || method === "POST";
  if (method !== "GET") return false;
  const id = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
  return (
    new RegExp("^" + SKIN_DRAFTS_PATH + "/" + id + "/reference\\?revision=[a-f0-9]{64}$", "u").test(path) ||
    new RegExp("^" + SKIN_DRAFTS_PATH + "/" + id + "(?:\\?version=(?:[1-9]|[1-5][0-9]|6[0-4]))?$", "u").test(
      path,
    ) ||
    new RegExp(
      "^" +
        SKIN_DRAFTS_PATH +
        "/" +
        id +
        "/poses/(?:rest|work|comms)/(?:source|native)\\?revision=[a-f0-9]{64}$",
      "u",
    ).test(path)
  );
}
