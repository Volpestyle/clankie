import type { WorkerSteerCommand } from "@clankie/worker-sdk";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type WorkerSteerOutcomeCode =
  | "delivered"
  | "stale_attempt"
  | "wrong_runner"
  | "worker_terminal"
  | "lease_expired"
  | "unsupported_adapter"
  | "human_control_active"
  | "delivery_failed";

export interface WorkerSteerOutcome {
  code: WorkerSteerOutcomeCode;
  message: string;
}

export interface StoredWorkerSteerCommand extends WorkerSteerCommand {
  runnerId: string;
  leaseExpiresAt: string;
  inputSha256: string;
  inputLength: number;
  requestedAt: string;
  status: "pending" | "delivering" | "settled";
  deliveryCount: number;
  outcome?: WorkerSteerOutcome;
}

export interface WorkerSteeringStore {
  get(commandId: string): Promise<StoredWorkerSteerCommand | undefined>;
  put(command: StoredWorkerSteerCommand): Promise<void>;
  claim(input: {
    runnerId: string;
    workerRunId: string;
    attempt: number;
  }): Promise<StoredWorkerSteerCommand | undefined>;
  settle(commandId: string, outcome: WorkerSteerOutcome): Promise<StoredWorkerSteerCommand | undefined>;
}

/**
 * Reference store used by the scaffold and tests. Production can inject a
 * durable implementation without changing the command protocol. Keeping the
 * payload out of mission events prevents steering text from entering audit,
 * tracker, or support-bundle logs.
 */
export class InMemoryWorkerSteeringStore implements WorkerSteeringStore {
  private readonly commands = new Map<string, StoredWorkerSteerCommand>();
  private operation: Promise<unknown> = Promise.resolve();

  public get(commandId: string): Promise<StoredWorkerSteerCommand | undefined> {
    return this.serialized(() => clone(this.commands.get(commandId)));
  }

  public put(command: StoredWorkerSteerCommand): Promise<void> {
    return this.serialized(() => {
      if (this.commands.has(command.commandId)) throw new Error("duplicate_command_id");
      this.commands.set(command.commandId, structuredClone(command));
    });
  }

  public claim(input: {
    runnerId: string;
    workerRunId: string;
    attempt: number;
  }): Promise<StoredWorkerSteerCommand | undefined> {
    return this.serialized(() => {
      const command = [...this.commands.values()]
        .filter(
          (candidate) =>
            candidate.runnerId === input.runnerId &&
            candidate.workerRunId === input.workerRunId &&
            candidate.attempt === input.attempt &&
            candidate.status === "pending",
        )
        .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt))[0];
      if (!command) return undefined;
      command.status = "delivering";
      command.deliveryCount += 1;
      return clone(command);
    });
  }

  public settle(
    commandId: string,
    outcome: WorkerSteerOutcome,
  ): Promise<StoredWorkerSteerCommand | undefined> {
    return this.serialized(() => {
      const command = this.commands.get(commandId);
      if (!command) return undefined;
      if (command.status === "settled") {
        if (command.outcome?.code !== outcome.code) throw new Error("conflicting_command_outcome");
        return clone(command);
      }
      command.status = "settled";
      command.outcome = { ...outcome };
      return clone(command);
    });
  }

  private serialized<T>(operation: () => T | Promise<T>): Promise<T> {
    const next = this.operation.then(operation, operation);
    this.operation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  public list(): Promise<StoredWorkerSteerCommand[]> {
    return this.serialized(() => [...this.commands.values()].map((command) => structuredClone(command)));
  }
}

/** Atomic mode-0600 persistence for the private command payload plane. */
export class FileWorkerSteeringStore implements WorkerSteeringStore {
  private readonly delegate = new InMemoryWorkerSteeringStore();
  private readonly ready: Promise<void>;
  private operation: Promise<unknown> = Promise.resolve();
  private readonly path: string;

  public constructor(path: string) {
    this.path = path;
    this.ready = this.load();
  }

  public get(commandId: string): Promise<StoredWorkerSteerCommand | undefined> {
    return this.serialized(() => this.delegate.get(commandId));
  }

  public put(command: StoredWorkerSteerCommand): Promise<void> {
    return this.serialized(async () => {
      await this.delegate.put(command);
      await this.persist();
    });
  }

  public claim(input: {
    runnerId: string;
    workerRunId: string;
    attempt: number;
  }): Promise<StoredWorkerSteerCommand | undefined> {
    return this.serialized(async () => {
      const command = await this.delegate.claim(input);
      if (command) await this.persist();
      return command;
    });
  }

  public settle(
    commandId: string,
    outcome: WorkerSteerOutcome,
  ): Promise<StoredWorkerSteerCommand | undefined> {
    return this.serialized(async () => {
      const command = await this.delegate.settle(commandId, outcome);
      if (command) await this.persist();
      return command;
    });
  }

  private async load(): Promise<void> {
    let stored: unknown;
    try {
      stored = JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!Array.isArray(stored)) throw new Error("Invalid worker steering store");
    let reconciled = false;
    for (const value of stored) {
      if (!isStoredWorkerSteerCommand(value)) throw new Error("Invalid worker steering store");
      const command = structuredClone(value);
      if (command.status === "delivering") {
        command.status = "settled";
        command.outcome = {
          code: "delivery_failed",
          message:
            "Delivery acknowledgement was not recorded before control-plane restart; the command was not replayed.",
        };
        reconciled = true;
      }
      await this.delegate.put(command);
    }
    if (reconciled) await this.persist();
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(await this.delegate.list())}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }

  private serialized<T>(operation: () => T | Promise<T>): Promise<T> {
    const next = this.operation.then(async () => {
      await this.ready;
      return operation();
    });
    this.operation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function clone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}

function isStoredWorkerSteerCommand(value: unknown): value is StoredWorkerSteerCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const command = value as Partial<StoredWorkerSteerCommand>;
  return (
    command.schemaVersion === 1 &&
    typeof command.commandId === "string" &&
    typeof command.workerRunId === "string" &&
    Number.isInteger(command.attempt) &&
    typeof command.runnerId === "string" &&
    typeof command.leaseExpiresAt === "string" &&
    typeof command.correlationId === "string" &&
    typeof command.missionId === "string" &&
    typeof command.taskId === "string" &&
    typeof command.profileHash === "string" &&
    typeof command.input === "string" &&
    typeof command.inputSha256 === "string" &&
    typeof command.inputLength === "number" &&
    typeof command.requestedAt === "string" &&
    (command.status === "pending" || command.status === "delivering" || command.status === "settled") &&
    typeof command.deliveryCount === "number" &&
    !!command.principal &&
    (command.principal.kind === "captain" || command.principal.kind === "operator") &&
    typeof command.principal.id === "string" &&
    isWorkerSteerIntent(command.intent) &&
    (command.sourceLane === "tui" ||
      command.sourceLane === "discord_text" ||
      command.sourceLane === "discord_voice" ||
      command.sourceLane === "api") &&
    (command.outcome === undefined ||
      (typeof command.outcome.message === "string" &&
        [
          "delivered",
          "stale_attempt",
          "wrong_runner",
          "worker_terminal",
          "lease_expired",
          "unsupported_adapter",
          "human_control_active",
          "delivery_failed",
        ].includes(command.outcome.code)))
  );
}

function isWorkerSteerIntent(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const intent = value as { type?: unknown; target?: unknown };
  if (intent.type === "focus") {
    return ["current_task", "failing_test", "acceptance_criteria", "scope", "diagnosis"].includes(
      String(intent.target),
    );
  }
  return (
    intent.type === "continue" || intent.type === "retry_last_step" || intent.type === "summarize_status"
  );
}
