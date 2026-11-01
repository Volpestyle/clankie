import { z } from "zod";
import {
  ClosedWorkerPaneSchema,
  OPERATOR_FLEET_ROSTER_MAX,
  OperatorAgentStarterSchema,
  OperatorFleetReadWarningsSchema,
} from "./operator-conversations.ts";

export const FLEET_ROSTER_PATH = "/v1/fleet/roster";
/** Opt-in because shipped v1 clients reject unknown row fields. */
export const FLEET_ROSTER_WORK_PATH = `${FLEET_ROSTER_PATH}?includeWork=true`;
/** Work plus who started each agent (ADR 0321); opt-in for the same reason. */
export const FLEET_ROSTER_STARTERS_PATH = `${FLEET_ROSTER_WORK_PATH}&includeStarters=true`;
export const FLEET_ROSTER_RETIRE_PATH = "/v1/fleet/roster/retire";
export const FLEET_ROSTER_UNDO_PATH = "/v1/fleet/roster/undo";
const Ref = z.string().min(1).max(512);
export const FleetRosterStatusSchema = z.enum(["working", "waiting", "idle", "finished", "unknown"]);
export const FleetRosterCountsSchema = z
  .object({
    total: z.number().int().nonnegative(),
    working: z.number().int().nonnegative(),
    waiting: z.number().int().nonnegative(),
    idle: z.number().int().nonnegative(),
    finished: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
    stale: z.number().int().nonnegative(),
  })
  .strict();
/**
 * Who started an agent (ADR 0321): the owner by hand or from their app, Clankie on his own,
 * a connected app through start_agent, or another agent. No starter outranks another.
 */
export const FleetRosterStarterSchema = OperatorAgentStarterSchema;
export const FleetRosterAgentSchema = z
  .object({
    seatId: Ref,
    occupantId: Ref,
    personaId: Ref,
    name: z.string().max(256),
    status: FleetRosterStatusSchema,
    nativeStatus: z.string().max(128),
    machineId: Ref,
    machine: z.string().max(256),
    leadId: Ref.optional(),
    lead: z.string().max(256).optional(),
    issue: z.string().max(256).optional(),
    /** Absent on older hosts/legacy reads; null means not confirmed. */
    project: z
      .object({ id: Ref, name: z.string().max(256) })
      .strict()
      .nullable()
      .optional(),
    task: z
      .object({ issue: z.string().min(1).max(512), title: z.string().max(4000).nullable() })
      .strict()
      .nullable()
      .optional(),
    /** owner = hand-started, subsequently adopted; no claim means unowned. */
    ownership: z.enum(["hired", "owner", "unowned"]).optional(),
    /** Only with includeStarters: who started this agent. */
    startedBy: FleetRosterStarterSchema.optional(),
    summary: z.string().max(4000).optional(),
    lastProgressAt: z.string().datetime().optional(),
    inactiveSince: z.string().datetime().optional(),
    pending: z.boolean(),
    stale: z.boolean(),
    retireEligible: z.boolean(),
  })
  .strict();
const Group = z.object({ id: Ref, name: z.string().max(256), counts: FleetRosterCountsSchema }).strict();
export const FleetRosterSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    observedAt: z.string().datetime(),
    complete: z.boolean(),
    readWarnings: OperatorFleetReadWarningsSchema.optional(),
    counts: FleetRosterCountsSchema,
    machines: z.array(Group).max(OPERATOR_FLEET_ROSTER_MAX),
    leads: z.array(Group).max(OPERATOR_FLEET_ROSTER_MAX),
    agents: z.array(FleetRosterAgentSchema).max(OPERATOR_FLEET_ROSTER_MAX),
  })
  .strict();
export const RetireFleetAgentSchema = z.object({ seatId: Ref, occupantId: Ref }).strict();
export const UndoFleetAgentSchema = z.object({ id: z.string().uuid() }).strict();
/** A refusal is a settled answer. Transport loss is uncertain and must never be retried automatically. */
export const FleetRosterActionResultSchema = z.union([
  z.object({ outcome: z.enum(["closed", "reopened"]), entry: ClosedWorkerPaneSchema }).strict(),
  z
    .object({
      outcome: z.enum(["refused", "failed"]),
      reason: z.string().min(1).max(128),
      detail: z.string().max(2000).optional(),
    })
    .strict(),
]);
export type FleetRosterSnapshot = z.infer<typeof FleetRosterSnapshotSchema>;
export type FleetRosterAgent = z.infer<typeof FleetRosterAgentSchema>;
export type FleetRosterStarter = z.infer<typeof FleetRosterStarterSchema>;
export type FleetRosterCounts = z.infer<typeof FleetRosterCountsSchema>;
export type FleetRosterActionResult = z.infer<typeof FleetRosterActionResultSchema>;
export type RetireFleetAgent = z.infer<typeof RetireFleetAgentSchema>;
