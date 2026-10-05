import { z } from "zod";
import { DiscordDirectoryRequestSchema, DiscordDirectorySnapshotSchema } from "./discord-directory.ts";
import { DiscordPermissionsRequestSchema, DiscordPermissionsSnapshotSchema } from "./discord-permissions.ts";
import { DiscordSettingsSchema } from "./discord-settings.ts";

export const DiscordConnectionGenerationSchema = z.string().regex(/^[a-f0-9]{32}$/u);
export const DiscordPolicyRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const Installation = z.string().regex(/^[A-Za-z0-9_-]{22}$/u);
const ApplicationId = z.string().regex(/^\d{5,32}$/u);
export const ManagedDiscordDirectoryRequestSchema = z
  .object({ installationId: Installation, query: DiscordDirectoryRequestSchema })
  .strict();
export const ManagedDiscordDirectoryResponseSchema = z
  .object({
    generation: DiscordConnectionGenerationSchema.nullable(),
    snapshot: DiscordDirectorySnapshotSchema,
    applicationId: ApplicationId.optional(),
  })
  .strict();
export const ManagedDiscordPermissionsRequestSchema = z
  .object({ installationId: Installation, query: DiscordPermissionsRequestSchema })
  .strict();
export const ManagedDiscordPermissionsResponseSchema = z
  .object({
    generation: DiscordConnectionGenerationSchema.nullable(),
    snapshot: DiscordPermissionsSnapshotSchema,
    applicationId: ApplicationId.optional(),
  })
  .strict();
export const ManagedDiscordPolicyStateRequestSchema = z.object({ installationId: Installation }).strict();
export const ManagedDiscordPolicyStateSchema = z
  .object({
    generation: DiscordConnectionGenerationSchema.nullable(),
    revision: DiscordPolicyRevisionSchema.nullable(),
    applicationId: ApplicationId.optional(),
  })
  .strict();
export const ManagedDiscordPolicyStateResponseSchema = ManagedDiscordPolicyStateSchema;
export const ManagedDiscordPolicyRequestSchema = z
  .object({
    installationId: Installation,
    generation: DiscordConnectionGenerationSchema,
    revision: DiscordPolicyRevisionSchema,
    expectedRevision: DiscordPolicyRevisionSchema.nullable(),
    settings: DiscordSettingsSchema,
  })
  .strict();
export const ManagedDiscordPolicyResponseSchema = z
  .object({
    generation: DiscordConnectionGenerationSchema,
    revision: DiscordPolicyRevisionSchema,
    applicationId: ApplicationId.optional(),
  })
  .strict();
export const ManagedDiscordPolicyConflictSchema = z
  .object({ error: z.literal("discord_policy_conflict"), current: ManagedDiscordPolicyStateSchema })
  .strict();
export const ManagedDiscordPolicyStatusSchema = z
  .object({
    state: z.enum(["synced", "pending", "conflict", "unavailable", "disconnected"]),
    revision: DiscordPolicyRevisionSchema,
    appliedRevision: DiscordPolicyRevisionSchema.optional(),
  })
  .strict();
export type ManagedDiscordPolicyState = z.infer<typeof ManagedDiscordPolicyStateSchema>;
export type ManagedDiscordDirectoryRequest = z.infer<typeof ManagedDiscordDirectoryRequestSchema>;
export type ManagedDiscordPermissionsRequest = z.infer<typeof ManagedDiscordPermissionsRequestSchema>;
export type ManagedDiscordPolicyRequest = z.infer<typeof ManagedDiscordPolicyRequestSchema>;
export type ManagedDiscordPolicyResponse = z.infer<typeof ManagedDiscordPolicyResponseSchema>;
export type ManagedDiscordPolicyStatus = z.infer<typeof ManagedDiscordPolicyStatusSchema>;
