import { z } from "zod";

export const PROJECT_CI_STARTER_PATH = "/v1/operator/projects/ci-starter";
const relativePath = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_.*?/-]+$/u)
  .refine(
    (value) => !value.startsWith("/") && !value.split("/").includes(".."),
    "Use a repository-relative path",
  );
/** Inputs to a proposal, never permission to execute these commands or change a repository. */
export const ProjectCiStarterRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    profile: z.literal("pnpm-vitest-4"),
    repository: z
      .string()
      .max(201)
      .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/u),
    reason: z.string().trim().min(1).max(2000),
    evidence: z.array(z.url().max(2000)).max(8).default([]),
    defaultBranch: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[a-zA-Z0-9_/-]+$/u)
      .default("main"),
    quickCommand: z.string().trim().min(1).max(2000),
    /** Non-test full checks. Their failures are never excused by the test baseline. */
    fullChecksCommand: z.string().trim().min(1).max(2000),
    vitestConfig: relativePath.default("vitest.config.ts"),
    nodeVersion: z.enum(["22", "24", "26"]).default("24"),
    compilerCachePaths: z.array(relativePath).min(1).max(8),
    compilerCacheKeyFiles: z.array(relativePath).min(1).max(8),
  })
  .strict();
export type ProjectCiStarterRequest = z.infer<typeof ProjectCiStarterRequestSchema>;
export const ProjectCiStarterOfferSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal("offered"),
    ownerChoiceRequired: z.literal(true),
    adoption: z.literal("unverified"),
    repository: z.string(),
    reason: z.string(),
    evidence: z.array(z.string()),
    files: z.array(z.object({ path: z.string(), content: z.string().max(65536) }).strict()).max(8),
    pullRequest: z.object({ title: z.string(), body: z.string() }).strict(),
    nextSteps: z.array(z.string()),
    limits: z.array(z.string()),
  })
  .strict();
export type ProjectCiStarterOffer = z.infer<typeof ProjectCiStarterOfferSchema>;
