import { resolve } from "node:path";
import {
  CaptainAdmissionController,
  createAdmittedLanguageModel,
  openCaptainLaneRegistry,
  type CaptainIdentity,
  type CaptainLaneRegistry,
  type CaptainRuntimeEvent,
} from "@clankie/captain-runtime";
import {
  ConfiguredModelError,
  loadConfig,
  parseModelRef,
  type ConfiguredLanguageModel,
} from "@clankie/model-provider";
import { captainLaneAddress, type EveChannelLaneContext } from "./context.ts";
import { captainLaneDatabasePath, stableProjectId } from "../session/project-identity.ts";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const MAX_RUNTIME_EVENTS = 512;

export interface CaptainLaneRuntime {
  readonly identity: CaptainIdentity;
  readonly registry: CaptainLaneRegistry;
  readonly admission: CaptainAdmissionController;
  events(): readonly CaptainRuntimeEvent[];
}

let runtimePromise: Promise<CaptainLaneRuntime> | undefined;

export function captainLaneRuntime(): Promise<CaptainLaneRuntime> {
  runtimePromise ??= createRuntime();
  return runtimePromise;
}

export async function reconcileEveLaneSession(input: {
  readonly channel: EveChannelLaneContext;
  readonly sessionId: string;
  readonly state?: "active" | "waiting" | "completed" | "failed";
}): Promise<void> {
  const runtime = await captainLaneRuntime();
  const address = captainLaneAddress(input.channel, runtime.identity.characterId);
  await runtime.registry.bindSession(address, {
    sessionId: input.sessionId,
    ...(input.channel.continuationToken === undefined
      ? {}
      : { continuationToken: input.channel.continuationToken }),
    ...(input.state === undefined ? {} : { state: input.state }),
  });
}

export async function admittedCaptainModel(input: {
  readonly selected: ConfiguredLanguageModel;
  readonly channel: EveChannelLaneContext;
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepIndex: number;
}): Promise<ConfiguredLanguageModel["model"]> {
  const runtime = await captainLaneRuntime();
  if (input.selected.providerId !== runtime.identity.providerId) {
    throw new ConfiguredModelError(
      `Captain provider changed from ${runtime.identity.providerId} to ${input.selected.providerId}; restart the captain before opening lanes`,
    );
  }
  const address = captainLaneAddress(input.channel, runtime.identity.characterId);
  const lane = await runtime.registry.register(address);
  return typeof input.selected.model === "string"
    ? input.selected.model
    : createAdmittedLanguageModel(input.selected.model, {
        admission: runtime.admission,
        laneKey: lane.key,
        lane: lane.lane,
        requestId: `model:${input.sessionId}:${input.turnId}:${String(input.stepIndex)}`,
        isProviderPressure,
      });
}

async function createRuntime(): Promise<CaptainLaneRuntime> {
  const [projectId, identity] = await Promise.all([stableProjectId(repoRoot), configuredIdentity()]);
  const runtimeEvents: CaptainRuntimeEvent[] = [];
  const record = (event: CaptainRuntimeEvent): void => {
    runtimeEvents.push(event);
    if (runtimeEvents.length > MAX_RUNTIME_EVENTS)
      runtimeEvents.splice(0, runtimeEvents.length - MAX_RUNTIME_EVENTS);
  };
  const registry = await openCaptainLaneRegistry(captainLaneDatabasePath(projectId), {
    identity,
    events: record,
  });
  const admission = new CaptainAdmissionController({
    capacity: configuredPositiveInteger("CLANKIE_CAPTAIN_MODEL_CONCURRENCY", 2),
    tuiReservation: 1,
    maxQueuedPerLane: configuredPositiveInteger("CLANKIE_CAPTAIN_LANE_QUEUE_LIMIT", 8),
    events: record,
  });
  return { identity, registry, admission, events: () => [...runtimeEvents] };
}

async function configuredIdentity(): Promise<CaptainIdentity> {
  const testModel = process.env.NODE_ENV === "test" ? process.env.CAPTAIN_TEST_MODEL?.trim() : undefined;
  const configured = await loadConfig({ cwd: repoRoot });
  const ref = parseModelRef(testModel || configured.config.model || "");
  if (ref === undefined)
    throw new ConfiguredModelError("Cannot create captain lanes without a model provider");
  return {
    agentDefinitionId: "captain-eve:v1",
    soulId: "clankie-captain",
    providerId: ref.providerId,
    characterId: process.env.CLANKIE_CHARACTER_ID?.trim() || "clankie",
  };
}

function configuredPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}

function isProviderPressure(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  if ([429, 529].includes(Number(record.status ?? record.statusCode))) return true;
  return error instanceof Error && /rate.?limit|overloaded|capacity/iu.test(error.message);
}
