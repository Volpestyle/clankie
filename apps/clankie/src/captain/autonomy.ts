import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  OperatorWakeSchema,
  type OperatorAutonomyCommand,
  type OperatorAutonomyStatus,
  type OperatorWake,
} from "@clankie/protocol";
import { z } from "zod";

const MAX_TIMER_MS = 2_147_483_647;
const WAKE_RETRY_START_MS = 5_000;
const WAKE_RETRY_MAX_MS = 5 * 60_000;
/**
 * Each attempt is a whole model turn (on 2026-10-07, ~49k tokens of context
 * and a provider request each), so a failing wake gets a few tries and then
 * waits for something to change instead of looping every five minutes.
 */
const WAKE_MAX_ATTEMPTS = 3;

/**
 * A wake whose turn failed for a reason another attempt cannot fix, such as a
 * provider rejecting its credentials. The wake is kept but not retried until
 * the conversation's seat binds or the service restarts.
 */
export class WakeHeldError extends Error {
  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WakeHeldError";
  }
}

const PersistedAutonomySchema = z
  .object({
    schemaVersion: z.literal(1),
    enabled: z.boolean(),
    conversations: z.record(
      z.string(),
      // `goal` is a retired ADR 0130 record (ADR 0264). It is read and dropped so
      // an older file keeps its switch and wakes instead of reading as unreadable.
      z.object({ goal: z.unknown().optional(), wake: OperatorWakeSchema.optional() }).strict(),
    ),
  })
  .strict();

interface PersistedAutonomy {
  schemaVersion: 1;
  enabled: boolean;
  conversations: Record<string, { wake?: OperatorWake }>;
}
/** One turn Clankie asked for. */
type InternalRun = (conversationId: string, prompt: string) => Promise<void>;

/** The master switch for unprompted work plus one replaceable self-wake per operator conversation. */
export class AutonomyStore {
  private readonly path: string;
  private state: PersistedAutonomy;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private run: InternalRun | undefined;
  private firingWakes = false;
  private readonly wakeRetries = new Map<
    string,
    { wake: OperatorWake; failures: number; retryAt: number; held: boolean; released?: true }
  >();
  private stateUnreadable = false;

  public constructor(path: string) {
    this.path = path;
    this.state = this.read();
  }

  public start(run: InternalRun): void {
    this.run = run;
    this.arm();
  }

  /** The master switch for unprompted work; an unreadable state file reads as off. */
  public get enabled(): boolean {
    return this.state.enabled;
  }

  public status(conversationId: string): OperatorAutonomyStatus {
    const record = this.state.conversations[conversationId];
    return {
      enabled: this.state.enabled,
      ...(this.stateUnreadable ? { error: "state_unreadable" as const } : {}),
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
      case "clear_wake":
        this.clearWake(conversationId);
        break;
    }
    return this.status(conversationId);
  }

  /**
   * Whether a queued self-wake prompt is no longer this conversation's pending
   * wake. A run queued behind a stalled conversation must not fire after its
   * wake was replaced or cancelled (VUH-2045). Only this store's own self-wake
   * prompts are judged; other internal wake runs are not its to drop.
   */
  public wakeSuperseded(conversationId: string, prompt: string): boolean {
    if (!prompt.startsWith(SELF_WAKE_HEADER)) return false;
    const wake = this.state.conversations[conversationId]?.wake;
    return wake === undefined || wakePrompt(wake) !== prompt;
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
    this.wakeRetries.delete(conversationId);
    this.save();
    this.arm();
    return wake;
  }

  public cancelWake(conversationId: string): void {
    this.clearWake(conversationId);
  }

  public clearConversation(conversationId: string): void {
    this.wakeRetries.delete(conversationId);
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
    this.arm();
  }

  private clearWake(conversationId: string): void {
    this.wakeRetries.delete(conversationId);
    const record = this.state.conversations[conversationId];
    if (record?.wake === undefined) return;
    delete record.wake;
    this.pruneRecord(conversationId);
    this.save();
    this.arm();
  }

  private arm(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.state.enabled || this.run === undefined || this.firingWakes) return;
    const next = Object.entries(this.state.conversations)
      .flatMap(([id, record]) => (record.wake === undefined ? [] : [this.wakeDueAt(id, record.wake)]))
      .filter((at) => Number.isFinite(at))
      .sort((a, b) => a - b)[0];
    if (next === undefined) return;
    this.timer = setTimeout(
      () => void this.fireDueWakes(),
      Math.min(MAX_TIMER_MS, Math.max(0, next - Date.now())),
    );
    this.timer.unref?.();
  }

  private wakeDueAt(conversationId: string, wake: OperatorWake): number {
    const retry = this.wakeRetries.get(conversationId);
    if (retry?.wake === wake && retry.held) return Number.POSITIVE_INFINITY;
    return Math.max(Date.parse(wake.at), retry?.wake === wake ? retry.retryAt : 0);
  }

  /** Whether this conversation's wake stopped retrying after a terminal or repeated failure. */
  public wakeHeld(conversationId: string): boolean {
    const retry = this.wakeRetries.get(conversationId);
    return retry !== undefined && retry.held && retry.wake === this.state.conversations[conversationId]?.wake;
  }

  /**
   * Something that could change the outcome happened (the seat bound, so the
   * wake can go there instead of a model turn): give a held wake one more try.
   * Only once per wake; after that it waits for a restart or a new wake.
   */
  public releaseHeldWake(conversationId: string): void {
    const retry = this.wakeRetries.get(conversationId);
    if (retry === undefined || !retry.held || retry.released) return;
    this.wakeRetries.set(conversationId, {
      ...retry,
      failures: WAKE_MAX_ATTEMPTS - 1,
      held: false,
      released: true,
      retryAt: Date.now(),
    });
    this.arm();
  }

  private async fireDueWakes(): Promise<void> {
    this.timer = undefined;
    if (!this.state.enabled || this.run === undefined || this.firingWakes) return;
    this.firingWakes = true;
    const now = Date.now();
    const due = Object.entries(this.state.conversations).filter(
      (entry): entry is [string, { wake: OperatorWake }] =>
        entry[1].wake !== undefined && this.wakeDueAt(entry[0], entry[1].wake) <= now,
    );
    for (const [conversationId, record] of due) {
      if (!this.state.enabled) break;
      const wake = record.wake;
      try {
        await this.run(conversationId, wakePrompt(wake));
        if (this.state.conversations[conversationId]?.wake === wake) {
          this.wakeRetries.delete(conversationId);
          delete this.state.conversations[conversationId]!.wake;
          this.pruneRecord(conversationId);
          this.save();
        }
      } catch (error) {
        // Retain the exact wake, but do not repeatedly admit a failed receiver
        // or model turn. Other conversations stay schedulable. A failure no
        // retry can fix, or one that keeps recurring, holds the wake.
        if (this.state.conversations[conversationId]?.wake === wake) {
          const previous = this.wakeRetries.get(conversationId);
          const failures = previous?.wake === wake ? previous.failures + 1 : 1;
          const delay = Math.min(WAKE_RETRY_MAX_MS, WAKE_RETRY_START_MS * 2 ** Math.min(failures - 1, 16));
          this.wakeRetries.set(conversationId, {
            wake,
            failures,
            retryAt: Date.now() + delay,
            held: error instanceof WakeHeldError || failures >= WAKE_MAX_ATTEMPTS,
            ...(previous?.wake === wake && previous.released ? { released: true as const } : {}),
          });
        }
      }
    }
    this.firingWakes = false;
    this.arm();
  }

  private record(conversationId: string): PersistedAutonomy["conversations"][string] {
    return (this.state.conversations[conversationId] ??= {});
  }

  private pruneRecord(conversationId: string): void {
    const record = this.state.conversations[conversationId];
    if (record !== undefined && record.wake === undefined) {
      delete this.state.conversations[conversationId];
    }
  }

  private read(): PersistedAutonomy {
    if (!existsSync(this.path)) return { schemaVersion: 1, enabled: true, conversations: {} };
    try {
      const parsed = PersistedAutonomySchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
      const conversations: PersistedAutonomy["conversations"] = {};
      for (const [id, record] of Object.entries(parsed.conversations))
        if (record.wake !== undefined) conversations[id] = { wake: record.wake };
      return { schemaVersion: 1, enabled: parsed.enabled, conversations };
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

const SELF_WAKE_HEADER = "This is a self-wake you scheduled, not a new instruction from the owner.";

function wakePrompt(wake: OperatorWake): string {
  return [
    SELF_WAKE_HEADER,
    `Reason you recorded: ${wake.reason}`,
    "Review the conversation and decide what is useful now. You may act, report, schedule another wake, or do nothing. Waking grants no additional authority or permissions.",
  ].join("\n\n");
}
