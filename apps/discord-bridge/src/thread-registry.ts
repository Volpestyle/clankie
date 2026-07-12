import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stripControlBytes } from "./mission-state.ts";

const THREAD_PREFIX = "clankie-";
const LEGACY_GUILD_SCOPE = "local-test-scope";

export const ZERO_RETENTION_STATUS =
  "Discord transcript retention is **off**. The bridge does not request message-content access, " +
  "capture channel transcripts, infer speaker memory, or retain slash-command text after forwarding it. " +
  "It keeps only a thread-to-mission correlation and projected lifecycle counters while the thread is bound.";

export interface MissionThreadBinding {
  readonly guildId: string;
  readonly threadId: string;
  readonly missionId: string;
  readonly interactionId?: string;
}

export interface MissionCreationRecord {
  readonly guildId: string;
  readonly interactionId: string;
  readonly missionId?: string;
}

interface PersistedRegistryState {
  readonly schemaVersion: 1;
  readonly bindings: readonly MissionThreadBinding[];
  readonly creations: readonly MissionCreationRecord[];
  readonly projectionFingerprints: readonly {
    guildId: string;
    threadId: string;
    missionId: string;
    fingerprint: string;
  }[];
}

export interface MissionThreadRegistryOptions {
  readonly statePath?: string;
}

export class MissionThreadRegistry {
  private readonly bindingByThread = new Map<string, MissionThreadBinding>();
  private readonly bindingByMission = new Map<string, MissionThreadBinding>();
  private readonly creationByInteraction = new Map<string, MissionCreationRecord>();
  private readonly projectionByThread = new Map<string, string>();
  private readonly statePath: string | undefined;
  private loading = false;

  public constructor(options: MissionThreadRegistryOptions = {}) {
    this.statePath = options.statePath;
    if (this.statePath) {
      this.loading = true;
      try {
        this.load();
      } finally {
        this.loading = false;
      }
    }
  }

  public bind(
    threadId: string,
    missionId: string,
    guildId = LEGACY_GUILD_SCOPE,
    interactionId?: string,
  ): MissionThreadBinding {
    const existingMission = this.bindingByMission.get(missionId);
    if (existingMission) return existingMission;

    const threadKey = scopedKey(guildId, threadId);
    const existingThread = this.bindingByThread.get(threadKey);
    if (existingThread) {
      if (existingThread.missionId !== missionId) {
        throw new Error(`Discord thread ${threadId} is already bound to another mission`);
      }
      return existingThread;
    }

    const binding: MissionThreadBinding = {
      guildId,
      threadId,
      missionId,
      ...(interactionId ? { interactionId } : {}),
    };
    this.bindingByThread.set(threadKey, binding);
    this.bindingByMission.set(missionId, binding);
    this.persist();
    return binding;
  }

  /** A Discord-controlled thread name is presentation only and never restores authority. */
  public restoreFromThreadName(_threadId: string, _threadName: string): undefined {
    return undefined;
  }

  public missionId(threadId: string, guildId = LEGACY_GUILD_SCOPE): string | undefined {
    return this.bindingByThread.get(scopedKey(guildId, threadId))?.missionId;
  }

  public bindingForMission(missionId: string): MissionThreadBinding | undefined {
    return this.bindingByMission.get(missionId);
  }

  public bindings(): readonly MissionThreadBinding[] {
    return [...this.bindingByThread.values()];
  }

  public recordCreation(guildId: string, interactionId: string, missionId: string): MissionCreationRecord {
    this.beginCreation(guildId, interactionId);
    return this.completeCreation(guildId, interactionId, missionId);
  }

  public beginCreation(guildId: string, interactionId: string): MissionCreationRecord {
    const key = scopedKey(guildId, interactionId);
    const existing = this.creationByInteraction.get(key);
    if (existing) return existing;
    const creation = { guildId, interactionId };
    this.creationByInteraction.set(key, creation);
    this.persist();
    return creation;
  }

  public completeCreation(guildId: string, interactionId: string, missionId: string): MissionCreationRecord {
    const key = scopedKey(guildId, interactionId);
    const existing = this.creationByInteraction.get(key);
    if (existing?.missionId && existing.missionId !== missionId) {
      throw new Error(`Discord interaction ${interactionId} is already bound to another mission`);
    }
    const creation = { guildId, interactionId, missionId };
    this.creationByInteraction.set(key, creation);
    this.persist();
    return creation;
  }

  public creationForInteraction(guildId: string, interactionId: string): MissionCreationRecord | undefined {
    return this.creationByInteraction.get(scopedKey(guildId, interactionId));
  }

  public forget(threadId: string, guildId = LEGACY_GUILD_SCOPE): boolean {
    const key = scopedKey(guildId, threadId);
    const binding = this.bindingByThread.get(key);
    if (!binding) return false;
    this.bindingByThread.delete(key);
    this.bindingByMission.delete(binding.missionId);
    this.projectionByThread.delete(key);
    for (const [creationKey, creation] of this.creationByInteraction) {
      if (creation.guildId === guildId && creation.missionId === binding.missionId) {
        this.creationByInteraction.delete(creationKey);
      }
    }
    this.persist();
    return true;
  }

  public entries(): readonly (readonly [threadId: string, missionId: string])[] {
    return this.bindings().map((binding) => [binding.threadId, binding.missionId] as const);
  }

  public projectionFingerprint(threadId: string, missionId: string): string | undefined {
    const binding = this.bindingByMission.get(missionId);
    if (!binding || binding.threadId !== threadId) return undefined;
    return this.projectionByThread.get(scopedKey(binding.guildId, threadId));
  }

  public recordProjectionFingerprint(threadId: string, missionId: string, fingerprint: string): void {
    const binding = this.bindingByMission.get(missionId);
    if (!binding || binding.threadId !== threadId) {
      throw new Error(`Cannot record a projection cursor for unbound thread ${threadId}`);
    }
    this.projectionByThread.set(scopedKey(binding.guildId, threadId), fingerprint);
    this.persist();
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.statePath as string, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }
    const state = parsePersistedState(JSON.parse(raw) as unknown);
    for (const binding of state.bindings) {
      const restored = this.bind(binding.threadId, binding.missionId, binding.guildId, binding.interactionId);
      if (restored.threadId !== binding.threadId || restored.guildId !== binding.guildId) {
        throw new Error(`Duplicate persisted Discord mission binding for ${binding.missionId}`);
      }
    }
    for (const creation of state.creations) {
      this.beginCreation(creation.guildId, creation.interactionId);
      if (creation.missionId) {
        this.completeCreation(creation.guildId, creation.interactionId, creation.missionId);
      }
    }
    for (const projection of state.projectionFingerprints) {
      const binding = this.bindingByMission.get(projection.missionId);
      if (!binding || binding.guildId !== projection.guildId || binding.threadId !== projection.threadId) {
        throw new Error(`Persisted projection cursor has no trusted mission binding`);
      }
      this.projectionByThread.set(scopedKey(projection.guildId, projection.threadId), projection.fingerprint);
    }
  }

  private persist(): void {
    if (!this.statePath || this.loading) return;
    const state: PersistedRegistryState = {
      schemaVersion: 1,
      bindings: this.bindings(),
      creations: [...this.creationByInteraction.values()],
      projectionFingerprints: this.bindings().flatMap((binding) => {
        const fingerprint = this.projectionByThread.get(scopedKey(binding.guildId, binding.threadId));
        return fingerprint ? [{ ...binding, fingerprint }] : [];
      }),
    };
    mkdirSync(dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.${String(process.pid)}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.statePath);
  }
}

export function threadNameForMission(missionId: string): string {
  const safeMissionId = stripControlBytes(missionId).replace(/[^a-zA-Z0-9_-]/gu, "-");
  return `${THREAD_PREFIX}${safeMissionId}`.slice(0, 100);
}

function parsePersistedState(value: unknown): PersistedRegistryState {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error("Invalid Discord bridge state schema");
  return {
    schemaVersion: 1,
    bindings: parseArray(value.bindings, "bindings", (entry) => {
      const interactionId = optionalString(entry, "interactionId");
      return {
        guildId: requiredString(entry, "guildId"),
        threadId: requiredString(entry, "threadId"),
        missionId: requiredString(entry, "missionId"),
        ...(interactionId ? { interactionId } : {}),
      };
    }),
    creations: parseArray(value.creations, "creations", (entry) => {
      const missionId = optionalString(entry, "missionId");
      return {
        guildId: requiredString(entry, "guildId"),
        interactionId: requiredString(entry, "interactionId"),
        ...(missionId ? { missionId } : {}),
      };
    }),
    projectionFingerprints: parseArray(value.projectionFingerprints, "projectionFingerprints", (entry) => ({
      guildId: requiredString(entry, "guildId"),
      threadId: requiredString(entry, "threadId"),
      missionId: requiredString(entry, "missionId"),
      fingerprint: requiredString(entry, "fingerprint"),
    })),
  };
}

function parseArray<T>(value: unknown, field: string, parse: (entry: Record<string, unknown>) => T): T[] {
  if (!Array.isArray(value)) throw new Error(`Invalid Discord bridge state ${field}`);
  return value.map((entry) => {
    if (!isRecord(entry)) throw new Error(`Invalid Discord bridge state ${field} entry`);
    return parse(entry);
  });
}

function requiredString(value: Record<string, unknown>, field: string): string {
  const item = value[field];
  if (typeof item !== "string" || item.length === 0) {
    throw new Error(`Invalid Discord bridge state field ${field}`);
  }
  return item;
}

function optionalString(value: Record<string, unknown>, field: string): string | undefined {
  const item = value[field];
  if (item === undefined) return undefined;
  if (typeof item !== "string" || item.length === 0) {
    throw new Error(`Invalid Discord bridge state field ${field}`);
  }
  return item;
}

function scopedKey(guildId: string, entityId: string): string {
  return `${guildId}\0${entityId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
