/**
 * In-memory placeholders for control-plane projections that do not have a
 * live console API yet. Captain conversation state is owned separately by
 * EveCaptainSession; these values must stay empty/honest rather than simulate
 * missions, workers, or approvals.
 */
import type { DashboardState } from "../components/mission-dashboard.ts";

export interface DoctrineSettings {
  granularity: "Micro" | "Small" | "Balanced" | "Batched";
  parallelism: "1" | "2" | "3" | "4" | "6" | "8";
  assurance: "Fast" | "Standard" | "Thorough" | "Audited";
  merge: "Deny" | "Approval" | "Conditional";
  visibility: "Summary" | "Write workers" | "All workers";
}

export interface ApprovalRequest {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly rationale: string;
  readonly evidence: readonly string[];
}

export interface ConsoleState {
  readonly dashboard: DashboardState;
  readonly doctrine: DoctrineSettings;
  approvals: ApprovalRequest[];
}

export function createInitialConsoleState(): ConsoleState {
  return {
    dashboard: {
      connection: "event log unavailable",
      cursor: 0,
      mission: "No active mission",
      doctrine: "control-plane projection unavailable",
      missions: [],
      tasks: [],
      agents: [],
      attention: [],
      timeline: [],
    },
    doctrine: {
      granularity: "Small",
      parallelism: "3",
      assurance: "Thorough",
      merge: "Approval",
      visibility: "Write workers",
    },
    approvals: [],
  };
}

export function pushTimeline(state: ConsoleState, message: string): void {
  state.dashboard.timeline.push(message);
}
