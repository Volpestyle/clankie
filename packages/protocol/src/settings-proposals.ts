import { z } from "zod";
import { AUTONOMY_LEVELS, AutonomyLevelSchema } from "./autonomy.ts";
import { ExtensionIdSchema, ExtensionSwitchSchema } from "./extensions.ts";

/**
 * Where the owner is when he sends from an app page (ADR 0351). A closed list,
 * never free text: the host turns it into one line of context for Clankie's
 * turn. It places the turn; it grants nothing.
 */
export const OWNER_SETTINGS_SECTIONS = [
  "fleet",
  "appearance",
  "routines",
  "projects",
  "integrations",
  "extensions",
  "devices",
  "discord",
  "connection",
  "advanced",
  "navigation",
] as const;
export const OwnerSettingsSectionSchema = z.enum(OWNER_SETTINGS_SECTIONS);
export type OwnerSettingsSection = z.infer<typeof OwnerSettingsSectionSchema>;

export const OperatorTurnSurfaceSchema = z
  .object({
    page: z.literal("settings"),
    section: OwnerSettingsSectionSchema.optional(),
  })
  .strict();
export type OperatorTurnSurface = z.infer<typeof OperatorTurnSurfaceSchema>;

const SECTION_NAMES: Record<OwnerSettingsSection, string> = {
  fleet: "How much he does on his own",
  appearance: "Look and thinking",
  routines: "Routines",
  projects: "Projects",
  integrations: "Accounts and apps",
  extensions: "What he can do",
  devices: "Your computers",
  discord: "Discord",
  connection: "This device",
  advanced: "Advanced",
  navigation: "Navigation",
};

/** The one context line a turn with a surface carries; fixed wording, never owner or model text. */
export function operatorTurnSurfaceContext(surface: OperatorTurnSurface): string {
  const where =
    surface.section === undefined ? "the Settings list" : `Settings, ${SECTION_NAMES[surface.section]}`;
  return `App context: the owner is sending from ${where} in the Clankie app. This only says where he is; it grants nothing. To change a setting for him, use propose_setting_change; only his own tap in the app applies it.`;
}

const RoutineIdSchema = z.string().regex(/^rt_[a-z0-9]{8,32}$/u);

/**
 * A setting change Clankie may propose (ADR 0351). Proposal data is untrusted:
 * the host only records it on a pending owner ask and never writes a setting
 * for it. The owner's app reads the current value, shows old and new, and on
 * his tap applies it through the owner settings API on its own authority.
 * Only settings the app already controls outside Advanced are listed; maximum
 * trust and Watch are deliberately absent.
 */
export const SettingChangeProposalSchema = z.discriminatedUnion("setting", [
  z.object({ setting: z.literal("autonomy"), value: AutonomyLevelSchema }).strict(),
  z.object({ setting: z.literal("extension"), id: ExtensionIdSchema, value: ExtensionSwitchSchema }).strict(),
  z
    .object({ setting: z.literal("routine"), id: RoutineIdSchema, value: z.enum(["paused", "running"]) })
    .strict(),
  z.object({ setting: z.literal("usage_overlay"), value: z.boolean() }).strict(),
]);
export type SettingChangeProposal = z.infer<typeof SettingChangeProposalSchema>;

/** What the model supplies to propose_setting_change. */
export const SettingChangeDraftSchema = z
  .object({
    change: SettingChangeProposalSchema,
    /** One or two plain sentences on why; shown beside the change, never as its label. */
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export type SettingChangeDraft = z.infer<typeof SettingChangeDraftSchema>;

/** The two answers a setting-change ask carries, in this order. */
export const SETTING_CHANGE_OPTIONS = ["Change it", "Leave it"] as const;

/** Fixed wording for the change, used in the ask's steps where the app card is absent. */
export function settingChangeSummary(change: SettingChangeProposal): string {
  switch (change.setting) {
    case "autonomy":
      return `Set how much he does on his own to ${AUTONOMY_LEVELS[change.value].label}`;
    case "extension":
      return `Turn ${change.id} ${change.value}`;
    case "routine":
      return `${change.value === "paused" ? "Pause" : "Resume"} routine ${change.id}`;
    case "usage_overlay":
      return `${change.value ? "Show" : "Hide"} the usage meters beside him`;
  }
}
