import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  OperatorGoalSchema,
  OperatorWakeSchema,
  type OperatorAutonomyCommand,
  type OperatorAutonomyStatus,
  type OperatorGoal,
  type OperatorGoalStatus,
  type OperatorWake,
} from "@clankie/protocol";
import { z } from "zod";

const MAX_TIMER_MS = 2_147_483_647;

const PersistedAutonomySchema = z
  .object({
    schemaVersion: z.literal(1),
    enabled: z.boolean(),
    conversations: z.record(
      z.string(),
      z.object({ goal: OperatorGoalSchema.optional(), wake: OperatorWakeSchema.optional() }).strict(),
    ),
  })
  .strict();

type PersistedAutonomy = z.infer<typeof PersistedAutonomySchema>;
/** A goal continuation loops until the goal settles; a wake is one turn Clankie asked for. */
type InternalRun = (conversationId: string, prompt: string, origin: "goal" | "wake") => Promise<void>;

const GoalDecisionSchema = z
  .object({
    at: z.string(),
    goalCreatedAt: z.string(),
    decision: z.string().min(1).max(512),
    why: z.string().min(1).max(512),
    evidence: z.string().min(1).max(512).optional(),
    autonomous: z.boolean().optional(),
  })
  .strict();
export type GoalDecision = z.infer<typeof GoalDecisionSchema>;

/** Durable owner-approved goals plus one replaceable self-wake per operator conversation. */
export class AutonomyStore {
  private readonly path: string;
  private state: PersistedAutonomy;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private run: InternalRun | undefined;
  private readonly goalRuns = new Set<string>();
  private firingWakes = false;
  private stateUnreadable = false;

  public constructor(path: string) {
    this.path = path;
    this.state = this.read();
  }

  public start(run: InternalRun): void {
    this.run = run;
    if (!this.state.enabled) return;
    for (const [conversationId, record] of Object.entries(this.state.conversations)) {
      if (record.goal?.status === "active") this.queueGoal(conversationId, record.goal);
    }
    this.arm();
  }

  public status(conversationId: string): OperatorAutonomyStatus {
    const record = this.state.conversations[conversationId];
    return {
      enabled: this.state.enabled,
      ...(this.stateUnreadable ? { error: "state_unreadable" as const } : {}),
      ...(record?.goal === undefined ? {} : { goal: record.goal }),
      ...(record?.wake === undefined ? {} : { wake: record.wake }),
    };
  }

  public command(conversationId: string, command: OperatorAutonomyCommand): OperatorAutonomyStatus {
    switch (command.action) {
      case "status":
        break;
      case "set_enabled":
        this.setEnabled(command.enabled);
        break;
      case "set_goal":
        this.createGoal(conversationId, command.objective, command.tokenBudget);
        this.resumeGoal(conversationId);
        break;
      case "set_goal_status":
        this.setGoalStatus(conversationId, command.status);
        if (command.status === "active") this.resumeGoal(conversationId);
        break;
      case "clear_goal":
        this.clearGoal(conversationId);
        break;
      case "clear_wake":
        this.clearWake(conversationId);
        break;
    }
    return this.status(conversationId);
  }

  public createGoal(conversationId: string, objective: string, tokenBudget?: number): OperatorGoal {
    const existing = this.state.conversations[conversationId]?.goal;
    if (existing !== undefined && existing.status !== "complete") {
      throw new Error("This conversation already has an unfinished goal");
    }
    const now = new Date().toISOString();
    const goal: OperatorGoal = {
      objective: objective.trim(),
      status: "active",
      ...(tokenBudget === undefined ? {} : { tokenBudget }),
      tokensUsed: 0,
      createdAt: now,
      updatedAt: now,
    };
    OperatorGoalSchema.parse(goal);
    this.record(conversationId).goal = goal;
    this.save();
    return goal;
  }

  public getGoal(conversationId: string): OperatorGoal | undefined {
    return this.state.conversations[conversationId]?.goal;
  }

  public updateGoal(
    conversationId: string,
    status: Extract<OperatorGoalStatus, "blocked" | "complete">,
  ): OperatorGoal {
    const goal = this.requireGoal(conversationId);
    if (goal.status !== "active") throw new Error("Only an active goal can be completed or blocked");
    goal.status = status;
    goal.updatedAt = new Date().toISOString();
    this.save();
    return goal;
  }

  public finishTurn(conversationId: string, tokens: number): void {
    const goal = this.state.conversations[conversationId]?.goal;
    if (goal === undefined) return;
    goal.tokensUsed += Math.max(0, Math.trunc(tokens));
    goal.updatedAt = new Date().toISOString();
    if (goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget) {
      goal.status = "budget_limited";
    }
    this.save();
    if (this.state.enabled && goal.status === "active") this.queueGoal(conversationId, goal);
  }

  /** Append one model-authored decision to the conversation's goal journal (ADR 0132). */
  public noteDecision(
    conversationId: string,
    note: { decision: string; why: string; evidence?: string; autonomous?: boolean },
  ): GoalDecision {
    const goal = this.requireGoal(conversationId);
    const entry: GoalDecision = {
      at: new Date().toISOString(),
      goalCreatedAt: goal.createdAt,
      decision: note.decision.trim(),
      why: note.why.trim(),
      ...(note.evidence === undefined ? {} : { evidence: note.evidence.trim() }),
      ...(note.autonomous === true ? { autonomous: true } : {}),
    };
    GoalDecisionSchema.parse(entry);
    mkdirSync(this.journalDir(), { recursive: true });
    appendFileSync(this.journalPath(conversationId), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return entry;
  }

  /** The current goal's journal tail; entries from earlier goals are filtered out. */
  public recentDecisions(conversationId: string, limit = 20): GoalDecision[] {
    const goal = this.state.conversations[conversationId]?.goal;
    if (goal === undefined) return [];
    let raw: string;
    try {
      raw = readFileSync(this.journalPath(conversationId), "utf8");
    } catch {
      return [];
    }
    return raw
      .split("\n")
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        try {
          const parsed = GoalDecisionSchema.safeParse(JSON.parse(line));
          return parsed.success && parsed.data.goalCreatedAt === goal.createdAt ? [parsed.data] : [];
        } catch {
          return [];
        }
      })
      .slice(-limit);
  }

  public scheduleWake(conversationId: string, at: string, reason: string): OperatorWake {
    const wakeAt = new Date(at);
    if (!Number.isFinite(wakeAt.getTime()) || wakeAt.getTime() <= Date.now()) {
      throw new Error("Wake time must be a valid future ISO timestamp");
    }
    const wake: OperatorWake = {
      at: wakeAt.toISOString(),
      reason: reason.trim(),
      createdAt: new Date().toISOString(),
    };
    OperatorWakeSchema.parse(wake);
    // ponytail: one pending wake per conversation; use a list only when overlapping wakeups are useful.
    this.record(conversationId).wake = wake;
    this.save();
    this.arm();
    return wake;
  }

  public cancelWake(conversationId: string): void {
    this.clearWake(conversationId);
  }

  public clearConversation(conversationId: string): void {
    if (delete this.state.conversations[conversationId]) this.save();
    this.arm();
  }

  public close(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.run = undefined;
  }

  private setEnabled(enabled: boolean): void {
    if (this.state.enabled === enabled) return;
    this.state.enabled = enabled;
    this.save();
    if (!enabled) {
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.timer = undefined;
      return;
    }
    for (const [conversationId, record] of Object.entries(this.state.conversations)) {
      if (record.goal?.status === "active") this.queueGoal(conversationId, record.goal);
    }
    this.arm();
  }

  private setGoalStatus(conversationId: string, status: "active" | "paused"): void {
    const goal = this.requireGoal(conversationId);
    if (goal.status === "complete") throw new Error("A completed goal cannot be resumed");
    if (status === "active" && goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget) {
      throw new Error("This goal has exhausted its token budget");
    }
    goal.status = status;
    goal.updatedAt = new Date().toISOString();
    this.save();
  }

  private clearGoal(conversationId: string): void {
    const record = this.state.conversations[conversationId];
    if (record?.goal === undefined) return;
    delete record.goal;
    this.pruneRecord(conversationId);
    this.save();
  }

  private clearWake(conversationId: string): void {
    const record = this.state.conversations[conversationId];
    if (record?.wake === undefined) return;
    delete record.wake;
    this.pruneRecord(conversationId);
    this.save();
    this.arm();
  }

  private resumeGoal(conversationId: string): void {
    const goal = this.state.conversations[conversationId]?.goal;
    if (this.state.enabled && goal?.status === "active") this.queueGoal(conversationId, goal);
  }

  private queueGoal(conversationId: string, goal: OperatorGoal): void {
    if (this.run === undefined || this.goalRuns.has(conversationId)) return;
    this.goalRuns.add(conversationId);
    void this.run(conversationId, goalPrompt(goal), "goal")
      .then(() => {
        this.goalRuns.delete(conversationId);
        const current = this.state.conversations[conversationId]?.goal;
        if (this.state.enabled && current?.status === "active") this.queueGoal(conversationId, current);
      })
      .catch(() => this.goalRuns.delete(conversationId));
  }

  private arm(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.state.enabled || this.run === undefined || this.firingWakes) return;
    const next = Object.values(this.state.conversations)
      .flatMap((record) => (record.wake === undefined ? [] : [Date.parse(record.wake.at)]))
      .sort((a, b) => a - b)[0];
    if (next === undefined) return;
    this.timer = setTimeout(
      () => void this.fireDueWakes(),
      Math.min(MAX_TIMER_MS, Math.max(0, next - Date.now())),
    );
    this.timer.unref?.();
  }

  private async fireDueWakes(): Promise<void> {
    this.timer = undefined;
    if (!this.state.enabled || this.run === undefined || this.firingWakes) return;
    this.firingWakes = true;
    const now = Date.now();
    const due = Object.entries(this.state.conversations).filter(
      (entry): entry is [string, { goal?: OperatorGoal; wake: OperatorWake }] =>
        entry[1].wake !== undefined && Date.parse(entry[1].wake.at) <= now,
    );
    let admissionFailed = false;
    for (const [conversationId, record] of due) {
      if (!this.state.enabled) break;
      const wake = record.wake;
      try {
        await this.run(conversationId, wakePrompt(wake), "wake");
        if (this.state.conversations[conversationId]?.wake === wake) {
          delete this.state.conversations[conversationId]!.wake;
          this.pruneRecord(conversationId);
          this.save();
        }
      } catch {
        // Keep the wake durable so a later arm or restart can retry admission.
        admissionFailed = true;
      }
    }
    this.firingWakes = false;
    if (admissionFailed && this.state.enabled && this.run !== undefined) {
      this.timer = setTimeout(() => void this.fireDueWakes(), 5_000);
      this.timer.unref?.();
      return;
    }
    this.arm();
  }

  private journalDir(): string {
    return join(dirname(this.path), "goal-journal");
  }

  private journalPath(conversationId: string): string {
    return join(this.journalDir(), `${encodeURIComponent(conversationId)}.jsonl`);
  }

  private requireGoal(conversationId: string): OperatorGoal {
    const goal = this.state.conversations[conversationId]?.goal;
    if (goal === undefined) throw new Error("This conversation has no goal");
    return goal;
  }

  private record(conversationId: string): PersistedAutonomy["conversations"][string] {
    return (this.state.conversations[conversationId] ??= {});
  }

  private pruneRecord(conversationId: string): void {
    const record = this.state.conversations[conversationId];
    if (record !== undefined && record.goal === undefined && record.wake === undefined) {
      delete this.state.conversations[conversationId];
    }
  }

  private read(): PersistedAutonomy {
    if (!existsSync(this.path)) return { schemaVersion: 1, enabled: true, conversations: {} };
    try {
      return PersistedAutonomySchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
    } catch {
      this.stateUnreadable = true;
      return { schemaVersion: 1, enabled: false, conversations: {} };
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${String(process.pid)}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
    this.stateUnreadable = false;
  }
}

function goalPrompt(goal: OperatorGoal): string {
  const budget =
    goal.tokenBudget === undefined
      ? `${String(goal.tokensUsed)} tokens used`
      : `${String(goal.tokensUsed)} / ${String(goal.tokenBudget)} tokens used`;
  return [
    "Continue the active owner-approved goal below.",
    "",
    `<goal objective=${JSON.stringify(goal.objective)} status=${JSON.stringify(goal.status)} budget=${JSON.stringify(budget)} />`,
    "",
    "Keep the objective fixed. Work autonomously, but obey the same permissions and constraints as any operator turn.",
    "Before calling update_goal with complete, audit every part of the objective against concrete evidence. Do not paper over errors, weaken the objective, or declare success because the budget is low.",
    "If the objective genuinely cannot progress, call update_goal with blocked and explain the concrete blocker. Otherwise keep working; the runner will continue the goal after this turn.",
  ].join("\n");
}

function wakePrompt(wake: OperatorWake): string {
  return [
    "This is a self-wake you scheduled, not a new instruction from the owner.",
    `Reason you recorded: ${wake.reason}`,
    "Review the conversation and decide what is useful now. You may act, report, schedule another wake, or do nothing. Waking grants no additional authority or permissions.",
  ].join("\n\n");
}
