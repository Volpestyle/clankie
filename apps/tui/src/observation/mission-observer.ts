import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  DashboardAgent,
  DashboardMission,
  DashboardState,
  DashboardTask,
} from "../components/mission-dashboard.ts";
import type { MissionEventSource, ObservedMissionEvent, SequencedMissionEvent } from "./mission-events.ts";

const CHECKPOINT_VERSION = 1;
const EVENT_TAIL_LENGTH = 12;

type MissionProjection = {
  id: string;
  goal: string;
  state: string;
  profileHash: string;
  updatedSequence: number;
  tasks: DashboardTask[];
  agents: DashboardAgent[];
  timeline: string[];
};

type ObservationCheckpoint = {
  version: 1;
  sourceId: string;
  lastSequence: number;
  selectedMissionId?: string;
  missions: MissionProjection[];
};

export interface MissionObserverOptions {
  readonly source: MissionEventSource;
  readonly checkpointPath: string;
  readonly pollIntervalMs?: number;
}

export class MissionObserver {
  private readonly source: MissionEventSource;
  private readonly checkpointPath: string;
  private readonly pollIntervalMs: number;
  private readonly missions = new Map<string, MissionProjection>();
  private selectedMissionId: string | undefined;
  private lastSequence = 0;
  private connection = "waiting for event log";
  private lastError: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private refreshInFlight: Promise<boolean> | undefined;

  public constructor(options: MissionObserverOptions) {
    this.source = options.source;
    this.checkpointPath = options.checkpointPath;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
  }

  public get dashboard(): DashboardState {
    const missions = this.missionList();
    const selected =
      (this.selectedMissionId === undefined ? undefined : this.missions.get(this.selectedMissionId)) ??
      this.preferredMission();
    const attention: string[] = [];
    if (selected?.state === "failed" || selected?.state === "blocked") {
      attention.push(`Mission is ${selected.state}.`);
    }
    for (const agent of selected?.agents ?? []) {
      if (agent.state === "blocked" || agent.state === "failed" || agent.state === "waiting") {
        attention.push(`${agent.id} is ${agent.state} on ${agent.task}.`);
      }
    }
    if (this.lastError !== undefined) attention.unshift(`Observer: ${this.lastError}`);
    return {
      connection: this.connection,
      cursor: this.lastSequence,
      mission: selected === undefined ? "No observed mission" : `${selected.id} · ${selected.goal}`,
      doctrine: selected?.profileHash ?? "event log unavailable",
      missions,
      tasks: selected?.tasks ?? [],
      agents: selected?.agents ?? [],
      attention,
      timeline: selected?.timeline ?? [],
    };
  }

  public async restore(): Promise<void> {
    let checkpoint: ObservationCheckpoint;
    try {
      checkpoint = parseCheckpoint(JSON.parse(await readFile(this.checkpointPath, "utf8")) as unknown);
    } catch (error) {
      if (isMissingFile(error)) return;
      this.lastError = "saved observation state was invalid; replaying from sequence 0";
      return;
    }
    if (checkpoint.sourceId !== this.source.identity) {
      this.lastError = "observation source changed; replaying from sequence 0";
      return;
    }
    this.lastSequence = checkpoint.lastSequence;
    this.selectedMissionId = checkpoint.selectedMissionId;
    for (const mission of checkpoint.missions) this.missions.set(mission.id, mission);
    this.connection = `restored at sequence ${this.lastSequence.toString()}`;
  }

  public async refresh(): Promise<boolean> {
    if (this.refreshInFlight !== undefined) return this.refreshInFlight;
    const refresh = this.refreshOnce().finally(() => {
      if (this.refreshInFlight === refresh) this.refreshInFlight = undefined;
    });
    this.refreshInFlight = refresh;
    return refresh;
  }

  public start(onChange: () => void, onError?: (error: Error) => void): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.refresh()
        .then((changed) => {
          if (changed) onChange();
        })
        .catch((error: unknown) => {
          const normalized = error instanceof Error ? error : new Error(String(error));
          const safeError = new Error(sanitize(normalized.message));
          this.connection = "event replay unavailable";
          this.lastError = safeError.message;
          onError?.(safeError);
          onChange();
        });
    }, this.pollIntervalMs);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  public async selectMission(selector: string): Promise<boolean> {
    const missions = this.missionList();
    if (missions.length === 0) return false;
    const currentIndex = Math.max(
      0,
      missions.findIndex((mission) => mission.selected),
    );
    const selected =
      selector === "next"
        ? missions[(currentIndex + 1) % missions.length]
        : selector === "prev" || selector === "previous"
          ? missions[(currentIndex - 1 + missions.length) % missions.length]
          : missions.find((mission) => mission.id === selector);
    if (selected === undefined) return false;
    this.selectedMissionId = selected.id;
    await this.writeCheckpoint();
    return true;
  }

  private async refreshOnce(): Promise<boolean> {
    let batch = await this.source.readAfter(this.lastSequence);
    if (batch.throughSequence < this.lastSequence || hasSequenceGap(batch.events, this.lastSequence)) {
      this.missions.clear();
      this.lastSequence = 0;
      this.selectedMissionId = undefined;
      batch = await this.source.readAfter(0);
      if (hasSequenceGap(batch.events, 0)) {
        throw new Error("Mission event replay contains a sequence gap");
      }
    }
    if (batch.events.length === 0) {
      this.connection = `live at sequence ${this.lastSequence.toString()}`;
      this.lastError = undefined;
      return false;
    }
    for (const entry of batch.events) this.apply(entry);
    this.lastSequence = batch.events.at(-1)?.sequence ?? this.lastSequence;
    this.chooseDefaultMission();
    this.connection = `live at sequence ${this.lastSequence.toString()}`;
    this.lastError = undefined;
    await this.writeCheckpoint();
    return true;
  }

  private apply(entry: SequencedMissionEvent): void {
    const event = entry.event;
    const mission = this.missions.get(event.missionId) ?? createMission(event, entry.sequence);
    mission.profileHash = sanitize(event.profileHash);
    mission.updatedSequence = entry.sequence;
    applyMissionLifecycle(mission, event);
    applyDiscordPresenceLifecycle(mission, event);
    applyTaskLifecycle(mission, event);
    applyWorkerLifecycle(mission, event);
    mission.timeline.push(summarizeEvent(entry));
    mission.timeline.splice(0, Math.max(0, mission.timeline.length - EVENT_TAIL_LENGTH));
    this.missions.set(mission.id, mission);
  }

  private missionList(): DashboardMission[] {
    const selectedId = this.selectedMissionId ?? this.preferredMission()?.id;
    return [...this.missions.values()]
      .sort((left, right) => right.updatedSequence - left.updatedSequence)
      .map((mission) => ({
        id: mission.id,
        goal: mission.goal,
        state: mission.state,
        selected: mission.id === selectedId,
      }));
  }

  private preferredMission(): MissionProjection | undefined {
    return [...this.missions.values()].sort((left, right) => {
      const leftActive = isActiveMission(left.state) ? 1 : 0;
      const rightActive = isActiveMission(right.state) ? 1 : 0;
      return rightActive - leftActive || right.updatedSequence - left.updatedSequence;
    })[0];
  }

  private chooseDefaultMission(): void {
    if (this.selectedMissionId !== undefined && this.missions.has(this.selectedMissionId)) return;
    this.selectedMissionId = this.preferredMission()?.id;
  }

  private async writeCheckpoint(): Promise<void> {
    const checkpoint: ObservationCheckpoint = {
      version: CHECKPOINT_VERSION,
      sourceId: this.source.identity,
      lastSequence: this.lastSequence,
      ...(this.selectedMissionId === undefined ? {} : { selectedMissionId: this.selectedMissionId }),
      missions: [...this.missions.values()],
    };
    const directory = dirname(this.checkpointPath);
    const temporaryPath = join(directory, `.${process.pid.toString()}-mission-observer.tmp`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await writeFile(temporaryPath, `${JSON.stringify(checkpoint, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.checkpointPath);
    await chmod(this.checkpointPath, 0o600);
  }
}

function createMission(event: ObservedMissionEvent, sequence: number): MissionProjection {
  return {
    id: sanitize(event.missionId),
    goal: "Mission goal pending",
    state: "draft",
    profileHash: sanitize(event.profileHash),
    updatedSequence: sequence,
    tasks: [],
    agents: [],
    timeline: [],
  };
}

function applyMissionLifecycle(mission: MissionProjection, event: ObservedMissionEvent): void {
  if (event.type === "mission.drafted" || event.type === "mission.created") {
    mission.goal = stringData(event.data, "goal") ?? mission.goal;
  }
  if (event.type === "mission.planned") {
    const plan = recordData(event.data, "plan");
    mission.goal = stringData(plan, "goal") ?? mission.goal;
    const tasks = arrayData(plan, "tasks");
    if (tasks !== undefined) mission.tasks = tasks.map(parsePlannedTask).filter(isDefined);
    mission.state = "planned";
  }
  if (event.type === "mission.execution.started" || event.type === "mission.started") {
    mission.state = "running";
  } else if (event.type === "mission.succeeded") mission.state = "succeeded";
  else if (event.type === "mission.failed") mission.state = "failed";
  else if (event.type === "mission.cancelled") mission.state = "cancelled";
}

function applyDiscordPresenceLifecycle(mission: MissionProjection, event: ObservedMissionEvent): void {
  if (event.type !== "discord.presence.session.phase_changed") return;
  const session = recordData(event.data, "session");
  const sessionId = stringData(session, "sessionId");
  const phase = stringData(event.data, "phase");
  mission.goal = sessionId === undefined ? "Discord presence" : `Discord presence · ${sessionId}`;
  if (phase !== undefined) mission.state = phase;
}

function applyTaskLifecycle(mission: MissionProjection, event: ObservedMissionEvent): void {
  if (event.taskId === undefined || !event.type.startsWith("task.")) return;
  const taskId = sanitize(event.taskId);
  let task = mission.tasks.find((candidate) => candidate.id === taskId);
  if (task === undefined) {
    task = {
      id: taskId,
      title: stringData(event.data, "title") ?? taskId,
      state: "queued",
      dependsOn: [],
    };
    mission.tasks.push(task);
  }
  task.state = taskState(event.type);
  if (isTerminalMission(mission.state)) return;
  if (task.state === "running" || task.state === "leased") mission.state = "running";
  else if (task.state === "blocked" || task.state === "waiting_user") mission.state = "blocked";
  else if (task.state === "failed") mission.state = "failed";
  else if (mission.tasks.length > 0 && mission.tasks.every((candidate) => candidate.state === "succeeded")) {
    mission.state = "verifying";
  }
}

function applyWorkerLifecycle(mission: MissionProjection, event: ObservedMissionEvent): void {
  if (event.workerRunId === undefined) return;
  const workerRunId = sanitize(event.workerRunId);
  const worker = recordData(event.data, "worker");
  let agent = mission.agents.find((candidate) => candidate.id === workerRunId);
  if (agent === undefined) {
    agent = {
      id: workerRunId,
      harness: stringData(worker, "harness") ?? "unknown",
      state: "working",
      task: event.taskId === undefined ? "unassigned" : sanitize(event.taskId),
    };
    mission.agents.push(agent);
  }
  const harness = stringData(worker, "harness");
  if (harness !== undefined) agent.harness = harness;
  if (event.taskId !== undefined) agent.task = sanitize(event.taskId);
  if (event.type === "worker.waiting_user") agent.state = "waiting";
  else if (event.type === "worker.crashed" || event.type === "worker.failed") agent.state = "failed";
  else if (event.type === "worker.settled") {
    const result = recordData(event.data, "result");
    const status = stringData(result, "status");
    agent.state = status === "failed" ? "failed" : status === "blocked" ? "blocked" : "completed";
  } else if (event.type === "task.blocked") agent.state = "blocked";
  else if (event.type === "task.failed") agent.state = "failed";
  else if (event.type === "task.succeeded") agent.state = "completed";
}

function parsePlannedTask(value: unknown): DashboardTask | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? sanitize(record.id) : undefined;
  if (id === undefined || id.length === 0) return undefined;
  return {
    id,
    title: typeof record.title === "string" ? sanitize(record.title) : id,
    state: "queued",
    dependsOn: Array.isArray(record.dependsOn)
      ? record.dependsOn.filter((item): item is string => typeof item === "string").map(sanitize)
      : [],
  };
}

function taskState(type: string): string {
  const state = type.slice("task.".length);
  if (state === "started") return "running";
  if (state === "added" || state === "requeued") return "queued";
  return sanitize(state);
}

function summarizeEvent(entry: SequencedMissionEvent): string {
  const { event, sequence } = entry;
  if (event.type === "discord.presence.session.phase_changed") {
    const previous = stringData(event.data, "previousPhase") ?? "unknown";
    const phase = stringData(event.data, "phase") ?? "unknown";
    const reason = stringData(event.data, "reason") ?? "unspecified";
    return `#${sequence.toString()} discord presence ${previous} → ${phase} · ${reason}`;
  }
  const scope = [event.taskId, event.workerRunId].filter(isDefined).map(sanitize).join(" · ");
  return `#${sequence.toString()} ${sanitize(event.type)}${scope.length === 0 ? "" : ` · ${scope}`}`;
}

function stringData(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? sanitize(value) : undefined;
}

function recordData(
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = record?.[key];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function arrayData(record: Record<string, unknown> | undefined, key: string): unknown[] | undefined {
  const value = record?.[key];
  return Array.isArray(value) ? value : undefined;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function isActiveMission(state: string): boolean {
  return !isTerminalMission(state);
}

function isTerminalMission(state: string): boolean {
  return ["succeeded", "failed", "cancelled"].includes(state);
}

function hasSequenceGap(events: readonly SequencedMissionEvent[], cursor: number): boolean {
  let expected = cursor + 1;
  for (const entry of events) {
    if (entry.sequence !== expected) return true;
    expected += 1;
  }
  return false;
}

function sanitize(text: string): string {
  return Array.from(text.replace(/\r\n?/gu, " "), (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || (code >= 127 && code <= 159) ? "" : character;
  }).join("");
}

function parseCheckpoint(value: unknown): ObservationCheckpoint {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Mission observation checkpoint must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== CHECKPOINT_VERSION) throw new Error("Unsupported observation checkpoint");
  if (typeof record.sourceId !== "string" || record.sourceId.length === 0) {
    throw new Error("Invalid observation checkpoint source");
  }
  if (!Number.isSafeInteger(record.lastSequence) || Number(record.lastSequence) < 0) {
    throw new Error("Invalid observation checkpoint cursor");
  }
  if (!Array.isArray(record.missions)) throw new Error("Invalid observation checkpoint missions");
  const selectedMissionId =
    record.selectedMissionId === undefined
      ? undefined
      : typeof record.selectedMissionId === "string" && record.selectedMissionId.length > 0
        ? sanitize(record.selectedMissionId)
        : (() => {
            throw new Error("Invalid selected mission in observation checkpoint");
          })();
  return {
    version: CHECKPOINT_VERSION,
    sourceId: record.sourceId,
    lastSequence: Number(record.lastSequence),
    ...(selectedMissionId === undefined ? {} : { selectedMissionId }),
    missions: record.missions.map(parseCheckpointMission),
  };
}

function parseCheckpointMission(value: unknown): MissionProjection {
  const record = checkpointRecord(value, "mission");
  if (!Array.isArray(record.tasks) || !Array.isArray(record.agents) || !Array.isArray(record.timeline)) {
    throw new Error("Invalid mission projection in observation checkpoint");
  }
  if (!Number.isSafeInteger(record.updatedSequence) || Number(record.updatedSequence) < 0) {
    throw new Error("Invalid mission projection sequence in observation checkpoint");
  }
  return {
    id: checkpointString(record, "id"),
    goal: checkpointString(record, "goal"),
    state: checkpointString(record, "state"),
    profileHash: checkpointString(record, "profileHash"),
    updatedSequence: Number(record.updatedSequence),
    tasks: record.tasks.map((task) => {
      const taskRecord = checkpointRecord(task, "task");
      if (!Array.isArray(taskRecord.dependsOn)) {
        throw new Error("Invalid task dependencies in observation checkpoint");
      }
      return {
        id: checkpointString(taskRecord, "id"),
        title: checkpointString(taskRecord, "title"),
        state: checkpointString(taskRecord, "state"),
        dependsOn: taskRecord.dependsOn.map((dependency) => {
          if (typeof dependency !== "string" || dependency.length === 0) {
            throw new Error("Invalid task dependency in observation checkpoint");
          }
          return sanitize(dependency);
        }),
      };
    }),
    agents: record.agents.map((agent) => {
      const agentRecord = checkpointRecord(agent, "agent");
      const state = checkpointString(agentRecord, "state");
      if (!["working", "waiting", "blocked", "failed", "completed"].includes(state)) {
        throw new Error("Invalid worker state in observation checkpoint");
      }
      return {
        id: checkpointString(agentRecord, "id"),
        harness: checkpointString(agentRecord, "harness"),
        state: state as DashboardAgent["state"],
        task: checkpointString(agentRecord, "task"),
      };
    }),
    timeline: record.timeline.map((line) => {
      if (typeof line !== "string") throw new Error("Invalid event tail in observation checkpoint");
      return sanitize(line);
    }),
  };
}

function checkpointRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label} in observation checkpoint`);
  }
  return value as Record<string, unknown>;
}

function checkpointString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${key} in observation checkpoint`);
  }
  return sanitize(value);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
