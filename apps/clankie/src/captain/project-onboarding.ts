import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CreateProjectSettingsSchema,
  ProjectSchema,
  ProjectRoleSchema,
  ProjectProposalTargetSchema,
  type ProjectProposalResult,
} from "@clankie/protocol/projects";
import { OPERATOR_AGENT_ROLES } from "@clankie/protocol";
import {
  createProjectSettings,
  observeProjectEnrollment,
  projectsRevision,
  type SettingsStore,
} from "@clankie/settings";
import { applyProjectCreate } from "../project-create.ts";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const directory = z
  .object({ path: z.string().max(4096), identity: z.array(z.string().max(64)).length(3) })
  .strict();
const ObservationSchema = z
  .object({
    directories: z.array(directory).max(8192),
    tracker: directory.extend({ sha256: hash }).strict().optional(),
  })
  .strict();
const ImmutableSchema = z
  .object({
    version: z.literal(1),
    proposalId: z.string().uuid(),
    requestId: z.string().uuid(),
    incarnationId: z.string().uuid(),
    conversationId: z.string().max(256),
    originRunId: z.string().max(256),
    workspace: z.object({ path: z.string().max(4096), dev: z.string(), ino: z.string() }).strict(),
    command: CreateProjectSettingsSchema,
    observation: ObservationSchema,
    project: ProjectSchema,
    effectiveRoles: z.array(ProjectRoleSchema).max(256),
    evidence: z.array(z.string().max(500)).max(8),
  })
  .strict();
/** Canonical JSON, independent of object insertion order; mutable receipts never enter this hash. */
export function proposalHash(value: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([, x]) => x !== undefined)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
export const ProjectCreationSchema = z
  .object({
    immutable: ImmutableSchema,
    artifactSha256: hash,
    status: z.enum(["pending", "committing", "created", "uncertain", "refused"]),
    claim: ProjectProposalTargetSchema.optional(),
    receipt: z
      .object({ projectId: z.string().max(64), projectsRevision: hash })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (
      proposalHash(a.immutable) !== a.artifactSha256 ||
      Buffer.byteLength(JSON.stringify(a.immutable)) > 14_000 ||
      Buffer.byteLength(JSON.stringify(a)) > 16_384
    )
      ctx.addIssue({ code: "custom", message: "Invalid bounded immutable project proposal" });
    if (
      (["committing", "created", "uncertain"].includes(a.status) && !a.claim) ||
      (a.status === "created" && !a.receipt)
    )
      ctx.addIssue({ code: "custom", message: "Missing consumed claim or receipt" });
    if (
      a.claim &&
      (a.claim.proposalId !== a.immutable.proposalId ||
        a.claim.requestId !== a.immutable.requestId ||
        a.claim.incarnationId !== a.immutable.incarnationId ||
        a.claim.conversationId !== a.immutable.conversationId ||
        a.claim.artifactSha256 !== a.artifactSha256 ||
        a.claim.expectedProjectsRevision !== a.immutable.command.expectedRevision)
    )
      ctx.addIssue({ code: "custom", message: "Mismatched consumed claim" });
  });
export type ProjectCreation = z.infer<typeof ProjectCreationSchema>;
export function proposalResult(creation: ProjectCreation, revision: number): ProjectProposalResult {
  const a = ProjectCreationSchema.parse(creation),
    i = a.immutable;
  return {
    status: a.status,
    proposal: {
      target: a.claim ?? {
        conversationId: i.conversationId,
        incarnationId: i.incarnationId,
        requestId: i.requestId,
        expectedRevision: revision,
        proposalId: i.proposalId,
        artifactSha256: a.artifactSha256,
        expectedProjectsRevision: i.command.expectedRevision,
      },
      command: structuredClone(i.command),
      project: structuredClone(i.project),
      effectiveRoles: structuredClone(i.effectiveRoles),
      evidence: [...i.evidence],
    },
    ...(a.receipt ? { receipt: { ...a.receipt } } : {}),
  };
}
/** Only injected by the service composition; not accepted from an owner/model request. */
export function projectOnboarding(settings: Pick<SettingsStore, "load" | "update">) {
  return {
    load: () => settings.load(),
    async prepare(command: z.infer<typeof CreateProjectSettingsSchema>) {
      const current = await settings.load();
      const next = createProjectSettings(current.projects, command);
      const project = next.projects.find((p) => p.id === command.projectId)!;
      const observation = await observeProjectEnrollment(current.projects, command);
      if (projectsRevision((await settings.load()).projects) !== command.expectedRevision)
        throw new Error("Projects changed");
      return {
        project,
        observation,
        effectiveRoles: project.roles.length ? project.roles : OPERATOR_AGENT_ROLES.map((role) => ({ role })),
      };
    },
    apply: (creation: ProjectCreation, guard: () => Promise<void>) =>
      applyProjectCreate(settings, creation.immutable.command, guard, {
        directories: creation.immutable.observation.directories,
        ...(creation.immutable.observation.tracker
          ? { tracker: creation.immutable.observation.tracker }
          : {}),
      }),
  };
}
