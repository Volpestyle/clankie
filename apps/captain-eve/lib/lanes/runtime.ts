import { resolve } from "node:path";
import {
  CaptainAdmissionController,
  captainSessionLaneV2Key,
  createAdmittedLanguageModel,
  LocalOperatorConversationService,
  openCaptainLaneRegistry,
  openOperatorConversationRegistry,
  type CaptainIdentity,
  type CaptainLaneRegistry,
  type OperatorConversationRegistry,
  type CaptainRuntimeEvent,
} from "@clankie/captain-runtime";
import type { OperatorConversationEventBody } from "@clankie/protocol";
import {
  ConfiguredModelError,
  loadConfig,
  parseModelRef,
  type ConfiguredLanguageModel,
} from "@clankie/model-provider";
import type { HandleMessageStreamEvent } from "eve/client";
import { captainLaneAddress, type EveChannelLaneContext } from "./context.ts";
import { redactEveStreamEvent } from "./transcript.ts";
import { captainLaneDatabasePath, stableProjectId } from "../session/project-identity.ts";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const MAX_RUNTIME_EVENTS = 512;

export interface CaptainLaneRuntime {
  readonly identity: CaptainIdentity;
  readonly registry: CaptainLaneRegistry;
  readonly conversations: OperatorConversationRegistry;
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
  /**
   * Private continuation token sourced from `ctx.session.continuationToken` (the
   * authored channel's context/metadata may not expose it). Never surfaced in
   * the public conversation contract.
   */
  readonly continuationToken?: string;
  readonly state?: "active" | "waiting" | "completed" | "failed";
}): Promise<void> {
  const runtime = await captainLaneRuntime();
  const address = captainLaneAddress(input.channel, runtime.identity.characterId);
  if (address.lane === "operator") {
    // Resolve the conversation by its Eve session identity first (the service
    // executor binds it), else the channel target. `rebindSession` allows a
    // legitimate self-rotation to a new session id while cross-conversation and
    // cross-token reuse stay fail-closed, so a second turn never fails in the hook.
    const conversationId = runtime.conversations.conversationForSession(input.sessionId) ?? address.targetId;
    if (runtime.conversations.get(conversationId) === undefined) return;
    runtime.conversations.rebindSession({
      conversationId,
      sessionId: input.sessionId,
      ...(input.continuationToken === undefined ? {} : { continuationToken: input.continuationToken }),
      ...(input.state === undefined ? {} : { state: input.state }),
    });
  } else {
    await runtime.registry.bindSession(
      {
        characterId: address.characterId,
        lane: address.lane,
        targetId: address.targetId,
      },
      {
        sessionId: input.sessionId,
        ...(input.channel.continuationToken === undefined
          ? {}
          : { continuationToken: input.channel.continuationToken }),
        ...(input.state === undefined ? {} : { state: input.state }),
      },
    );
  }
}

/**
 * Per-conversation Eve session driver the operator turn executor owns. It is
 * satisfied by the authored `defineChannel` `args.send` adapter (see
 * `agent/channels/operator-conversations.ts`) and by a fake in tests.
 *
 * There is no `AbortSignal`: eve's channel `SendFn` does not accept one, so a
 * turn cannot be cancelled through the caller. Caller-detachment is preserved
 * (the request never owns the run); provider-preemption is the only cancellation
 * path and it settles the admission lease, not the in-flight `SendFn`.
 */
export interface CaptainConversationClient {
  send(input: {
    readonly conversationId: string;
    readonly message: string;
    readonly continuationToken?: string;
  }): Promise<CaptainConversationTurn>;
}
export interface CaptainConversationTurn {
  readonly sessionId: string;
  readonly continuationToken?: string | undefined;
  /** Events for this session from `startIndex` (the private per-conversation stream index). */
  events(startIndex: number): AsyncIterable<HandleMessageStreamEvent>;
}

/** Redacted, bounded, safe projection-error line — never the raw error message. */
export function operatorProjectionErrorLine(
  conversationId: string,
  eventType: string,
  error: unknown,
): string {
  return JSON.stringify({
    service: "captain-eve",
    event: "operator_conversation.projection_error",
    conversationId,
    eventType,
    errorName: error instanceof Error ? error.name.slice(0, 64) : "Error",
    code: "projection_rejected",
  });
}

function reportProjectionError(conversationId: string, eventType: string, error: unknown): void {
  // Observable, bounded, non-fatal; carries only a safe error name/code — never
  // the raw error message, which could echo redaction-bypass content.
  process.stderr.write(`${operatorProjectionErrorLine(conversationId, eventType, error)}\n`);
}

/**
 * Executes an accepted operator turn against the conversation's own durable Eve
 * session. It binds `sessionId`/continuation privately (self-rotation allowed,
 * cross-conversation fail-closed), consumes the session event stream from the
 * private per-conversation stream index (so a re-driven turn never re-projects
 * the transcript), redacts and publishes each event directly into the durable
 * log/tail (no hook target race), advances the stream index, and derives the
 * terminal completed/waiting/failed state. The caller's lifetime is irrelevant.
 */
export async function runCaptainConversationTurn(input: {
  readonly registry: OperatorConversationRegistry;
  readonly client: CaptainConversationClient;
  readonly conversationId: string;
  readonly message: string;
  readonly publish: (body: OperatorConversationEventBody) => void;
}): Promise<void> {
  const priv = input.registry.privateSession(input.conversationId);
  const turn = await input.client.send({
    conversationId: input.conversationId,
    message: input.message,
    ...(priv.continuationToken === undefined ? {} : { continuationToken: priv.continuationToken }),
  });
  const rebind = (state: "active" | "waiting" | "completed" | "failed"): void => {
    input.registry.rebindSession({
      conversationId: input.conversationId,
      sessionId: turn.sessionId,
      ...(turn.continuationToken === undefined ? {} : { continuationToken: turn.continuationToken }),
      state,
    });
  };
  // Bind early (self-rotation-aware) so the reconcile hook resolves this session
  // to THIS conversation and rotation resets the stream index before we resume.
  rebind("active");
  let index = input.registry.eveStreamIndex(input.conversationId);
  let status: "completed" | "waiting" | "failed" = "failed";
  for await (const event of turn.events(index)) {
    for (const body of redactEveStreamEvent(event)) {
      try {
        input.publish(body);
      } catch (error) {
        reportProjectionError(input.conversationId, event.type, error);
      }
    }
    index += 1;
    input.registry.advanceEveStreamIndex(input.conversationId, index);
    if (event.type === "session.completed") status = "completed";
    else if (event.type === "session.waiting") status = "waiting";
    else if (event.type === "session.failed") status = "failed";
  }
  rebind(status);
  if (status === "failed") throw new Error(`Captain turn failed for conversation ${input.conversationId}`);
}

/**
 * Builds the request-local operator conversation service the authenticated
 * channel route mounts per request: read/select ops (list/get/create/replay/
 * tail) plus `send`, whose executor runs the accepted turn through the given
 * per-conversation Eve driver. This is the callable boundary VUH-864 relays.
 */
export async function buildOperatorConversationService(
  client: CaptainConversationClient,
): Promise<LocalOperatorConversationService> {
  const runtime = await captainLaneRuntime();
  return new LocalOperatorConversationService(runtime.conversations, runtime.admission, (turn, ctx) =>
    runCaptainConversationTurn({
      registry: runtime.conversations,
      client,
      conversationId: turn.conversationId,
      message: turn.message,
      publish: ctx.publish,
    }),
  );
}

/** Adapts an eve channel `Session` event stream into an `AsyncIterable`. */
export async function* eveSessionEvents(
  stream: Promise<ReadableStream<HandleMessageStreamEvent>>,
): AsyncIterable<HandleMessageStreamEvent> {
  const reader = (await stream).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
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
  if (address.lane === "operator" && runtime.conversations.get(address.targetId) === undefined) {
    throw new Error(`Unknown operator conversation ${address.targetId}`);
  }
  const laneKey =
    address.lane === "operator"
      ? captainSessionLaneV2Key(address)
      : (
          await runtime.registry.register({
            characterId: address.characterId,
            lane: address.lane,
            targetId: address.targetId,
          })
        ).key;
  return typeof input.selected.model === "string"
    ? input.selected.model
    : createAdmittedLanguageModel(input.selected.model, {
        admission: runtime.admission,
        laneKey,
        lane: address.lane,
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
  const databasePath = captainLaneDatabasePath(projectId);
  const registry = await openCaptainLaneRegistry(databasePath, {
    identity,
    events: record,
  });
  const conversations = await openOperatorConversationRegistry(databasePath, { identity });
  const admission = new CaptainAdmissionController({
    capacity: configuredPositiveInteger("CLANKIE_CAPTAIN_MODEL_CONCURRENCY", 2),
    maxQueuedPerLane: configuredPositiveInteger("CLANKIE_CAPTAIN_LANE_QUEUE_LIMIT", 8),
    events: record,
  });
  return { identity, registry, conversations, admission, events: () => [...runtimeEvents] };
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
