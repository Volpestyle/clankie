import { z } from "zod";
import { isTldrawArtifactRef } from "./discord-presence.ts";

// ---------------------------------------------------------------------------
// Drawing a diagram (ADR 0096).
//
// He describes the diagram as data — entities and their fields, lanes and the
// messages between them — and the host renders it through the tldraw desktop
// app in a fixed design system. He never authors canvas code: the script that
// runs is the host's, and the request only fills in what the picture says. See
// `isTldrawArtifactRef` above for why the artifact this mints is attachable.
// ---------------------------------------------------------------------------

/** Why a diagram request produced nothing. Each one is sayable out loud. */
export const DiagramRefusalReasonSchema = z.enum([
  "canvas_unavailable",
  "canvas_failed",
  "diagram_too_large",
  "artifact_too_large",
]);
export type DiagramRefusalReason = z.infer<typeof DiagramRefusalReasonSchema>;

/**
 * One entity box: a name, the store it lives in, and its fields.
 *
 * `columns` is one field per line as `ROLES|field|type`, where roles are any
 * comma-separated mix of `PK`, `SK` and `FK` — the notation the design system's
 * table shape already speaks, so the request carries no rendering decisions.
 */
export const DiagramTableSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    /** Where the rows actually live: `postgres`, `memory · hot`, `ewram`, … */
    engine: z.string().trim().max(60).default(""),
    tone: z.enum(["black", "grey", "blue", "green", "yellow", "orange", "red", "violet"]).default("black"),
    columns: z.string().trim().min(1).max(4_000),
    /** Constraints or lifecycle notes; keep them out of the type cells. */
    footer: z.string().trim().max(600).default(""),
  })
  .strict();
export type DiagramTable = z.infer<typeof DiagramTableSchema>;

/** One relationship, pinned to the rows that actually hold the keys. */
export const DiagramEdgeSchema = z
  .object({
    from: z.string().trim().min(1).max(60),
    fromField: z.string().trim().min(1).max(60),
    to: z.string().trim().min(1).max(60),
    toField: z.string().trim().min(1).max(60),
    label: z.string().trim().max(80).default(""),
  })
  .strict();
export type DiagramEdge = z.infer<typeof DiagramEdgeSchema>;

export const DrawErDiagramRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    title: z.string().trim().min(1).max(120),
    subtitle: z.string().trim().max(240).default(""),
    tables: z.array(DiagramTableSchema).min(1).max(16),
    edges: z.array(DiagramEdgeSchema).max(32).default([]),
  })
  .strict();
export type DrawErDiagramRequest = z.infer<typeof DrawErDiagramRequestSchema>;

export const DrawSequenceDiagramRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    title: z.string().trim().min(1).max(120),
    /** One participant per line as `id|Label|sublabel`, left to right. */
    lanes: z.string().trim().min(1).max(1_200),
    /**
     * The exchange, one step per line, in the design system's mini-syntax:
     * `== phase`, `a->b: message`, `a-->b: reply`, `a->a: self call`,
     * `note over a,b: aside`. A trailing `[red]` colours one step.
     */
    steps: z.string().trim().min(1).max(8_000),
  })
  .strict();
export type DrawSequenceDiagramRequest = z.infer<typeof DrawSequenceDiagramRequestSchema>;

/**
 * Only `ok` carries a reference, so a diagram that failed to render can never
 * yield something attachable.
 */
export const DrawDiagramResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("ok"),
      artifactRef: z.string().refine(isTldrawArtifactRef, "expected a tldraw artifact reference"),
      filename: z.string().min(1),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      /**
       * Which design system it came out in. Operator-chosen, like the model
       * behind a picture — reported so he can name the look, not so he can
       * pick it.
       */
      system: z.string().min(1).max(60).optional(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("refused"),
      reason: DiagramRefusalReasonSchema,
      detail: z.string().max(500).optional(),
    })
    .strict(),
]);
export type DrawDiagramResult = z.infer<typeof DrawDiagramResultSchema>;
