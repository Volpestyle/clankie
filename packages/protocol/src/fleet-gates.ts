import { z } from "zod";

/** A gate describes who decides; it never grants machine or account authority. */
export const FleetGateModeSchema = z.enum(["allow", "lead", "owner"]);
export type FleetGateMode = z.infer<typeof FleetGateModeSchema>;
export const FLEET_GATE_FIELDS = ["everydayWork", "leavesMac", "hardToUndo", "moneyAndAccounts"] as const;
export const FleetGateCategorySchema = z.enum(FLEET_GATE_FIELDS);
export type FleetGateCategory = z.infer<typeof FleetGateCategorySchema>;
export const FleetGatesSchema = z
  .object({
    everydayWork: FleetGateModeSchema,
    leavesMac: FleetGateModeSchema,
    hardToUndo: FleetGateModeSchema,
    moneyAndAccounts: z.literal("owner"),
  })
  .strict();
export type FleetGates = z.infer<typeof FleetGatesSchema>;

export const FLEET_GATE_MODES = {
  allow: { label: "Just do it", description: "Workers may proceed within their existing authority." },
  lead: { label: "Clankie decides", description: "Clankie answers the worker's question." },
  owner: { label: "Ask me", description: "The owner answers before the worker proceeds." },
} as const satisfies Record<FleetGateMode, { label: string; description: string }>;
/** Existing push/commit/release modes preserve their original delegated-authority semantics. */
export const FLEET_WORKING_GATE_LABELS = {
  lead: "Clankie decides",
  owner: "Ask me",
  time_rule: "Use my time rule",
} as const;

export const FLEET_GATE_CATEGORIES = [
  {
    key: "everydayWork",
    label: "Everyday work",
    description: "Read files, edit code, run checks, and prepare work in the workspace.",
  },
  {
    key: "leavesMac",
    label: "Leaves your Mac",
    description:
      "Send messages, publish content, or send workspace data to another service. Push and release keep their own settings.",
  },
  {
    key: "hardToUndo",
    label: "Hard to undo",
    description:
      "Delete or replace important data, change shared infrastructure, or make another difficult-to-reverse change.",
  },
  {
    key: "moneyAndAccounts",
    label: "Money and accounts",
    description: "Payments, purchases, sign-ins, credentials, and account changes always need the owner.",
  },
] as const satisfies readonly { key: FleetGateCategory; label: string; description: string }[];
export const FleetGatePresetSchema = z.enum(["hands-off", "balanced", "careful"]);
export type FleetGatePreset = z.infer<typeof FleetGatePresetSchema>;
export const FLEET_GATE_PRESETS = {
  "hands-off": {
    label: "Hands-off",
    description:
      "Workers handle everyday work; Clankie decides before outward work and changes that are hard to undo.",
    gates: { everydayWork: "allow", leavesMac: "lead", hardToUndo: "lead", moneyAndAccounts: "owner" },
  },
  balanced: {
    label: "Balanced",
    description:
      "Workers handle everyday work; Clankie handles outward work; you handle changes that are hard to undo.",
    gates: { everydayWork: "allow", leavesMac: "lead", hardToUndo: "owner", moneyAndAccounts: "owner" },
  },
  careful: {
    label: "Careful",
    description:
      "Clankie handles everyday questions; you handle outward work and changes that are hard to undo.",
    gates: { everydayWork: "lead", leavesMac: "owner", hardToUndo: "owner", moneyAndAccounts: "owner" },
  },
} as const satisfies Record<FleetGatePreset, { label: string; description: string; gates: FleetGates }>;

/** Return a copy: choosing a preset changes only category gates, not push or release. */
export function fleetGatePreset(preset: FleetGatePreset): FleetGates {
  return { ...FLEET_GATE_PRESETS[FleetGatePresetSchema.parse(preset)].gates };
}

/** A summary is generated from effective leaves, including custom project choices. */
export function fleetGateSummary(gates: FleetGates): string {
  const parsed = FleetGatesSchema.strip().parse(gates);
  const everyday = {
    allow: "Workers handle everyday work",
    lead: "Clankie decides on everyday work",
    owner: "You approve everyday work",
  }[parsed.everydayWork];
  const outward = {
    allow: "workers handle things that leave your Mac",
    lead: "Clankie decides before anything leaves your Mac",
    owner: "you approve anything that leaves your Mac",
  }[parsed.leavesMac];
  const irreversible = {
    allow: "workers handle changes that are hard to undo",
    lead: "Clankie decides on changes that are hard to undo",
    owner: "you approve changes that are hard to undo",
  }[parsed.hardToUndo];
  return `${everyday}, ${outward}, and ${irreversible}; money and accounts always ask you.`;
}

/** An exact category match; push/release never affect preset detection. */
export function matchingFleetGatePreset(gates: FleetGates): FleetGatePreset | undefined {
  const parsed = FleetGatesSchema.strip().parse(gates);
  return FleetGatePresetSchema.options.find((preset) =>
    FLEET_GATE_FIELDS.every((field) => parsed[field] === FLEET_GATE_PRESETS[preset].gates[field]),
  );
}
