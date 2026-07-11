import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import {
  compileDoctrine,
  decideAction,
  decideCapabilityRequest,
  loadDoctrineFile,
  permitsCapabilityGrant,
  type ActionClassification,
  type CompiledDoctrine,
} from "@sapling/doctrine";
import type { EventStore } from "@sapling/event-store";
import { MissionEngine, WorkerRunConflictError, type MissionSnapshot } from "@sapling/mission-engine";
import { createLogger } from "@sapling/observability";
import {
  ActionResourceSchema,
  ActionRequestSchema,
  MissionPlanSchema,
  WorkerResultSchema,
  assertValidDag,
  type ActionResource,
  type DomainEvent,
  type MissionPlan,
  type Risk,
} from "@sapling/protocol";
import type { WorkerDescriptor } from "@sapling/worker-sdk";
import { Hono, type Context } from "hono";
import { z } from "zod";

const logger = createLogger({ service: "sapling-control-plane", version: "0.1.0" });

interface MissionRecord {
  id: string;
  goal: string;
  context: Record<string, unknown>;
  state: "draft" | "planned" | "running";
  plan?: MissionPlan;
  createdAt: string;
}

export interface ControlPlaneDependencies {
  doctrine: CompiledDoctrine;
  /** Durable mission event log; when provided, mission records are rebuilt from it on startup. */
  eventStore?: EventStore;
  /** Runner-owned audited broker boundary. The control plane never receives its signing key or credentials. */
  capabilityBroker?: CapabilityBroker;
  /** Authenticates the caller using runner/session state outside the request body. */
  authenticateWorker?: WorkerAuthenticator;
  /** Resolves policy facts from authoritative mission/check/approval state, never from the worker body. */
  resolveActionContext?: ActionContextProvider;
  /** Resolves risk from trusted connector metadata, never from the worker request body. */
  classifyConnectorAction?: ConnectorActionClassifier;
  /** Runner-owned privileged connector. Its credential access is not part of this interface. */
  githubConnector?: GithubConnector;
  /** Authenticates the outbound local runner. Missing configuration leaves execution unavailable. */
  authenticateRunner?: RunnerAuthenticator;
  /** Authenticates the captain/operator starting an already validated plan. */
  authenticateCaptain?: CaptainAuthenticator;
  /** Repository path supplied to mission runtime metadata; providers remain runner-owned. */
  workspacePath?: string;
  workerLeaseDurationMs?: number;
  clock?: () => Date;
  idFactory?: () => string;
}

export interface TrustedRunnerIdentity {
  runnerId: string;
}

export type RunnerAuthenticator = (request: Request) => Promise<TrustedRunnerIdentity | undefined>;

export interface TrustedCaptainIdentity {
  captainId: string;
}

export type CaptainAuthenticator = (request: Request) => Promise<TrustedCaptainIdentity | undefined>;

export interface TrustedWorkerIdentity {
  missionId: string;
  workerRunId: string;
  correlationId: string;
  profileHash: string;
  taskId?: string;
}

export type WorkerAuthenticator = (request: Request) => Promise<TrustedWorkerIdentity | undefined>;

export interface CapabilityActionInput {
  id: string;
  action: string;
  resource: ActionResource;
}

export interface TrustedActionContext {
  risk: Risk;
  checksPassed?: boolean;
  humanApprovals?: number;
  changedLines?: number;
  changedPaths?: string[];
  costSoFarUsd?: number;
}

export type ActionContextProvider = (
  identity: TrustedWorkerIdentity,
  request: CapabilityActionInput,
) => Promise<TrustedActionContext | undefined>;

export type ConnectorActionClassifier = (
  request: CapabilityActionInput,
) => ActionClassification | undefined | Promise<ActionClassification | undefined>;

export interface CapabilityGrantInput {
  version: 1;
  grantId: string;
  principalId: string;
  missionId: string;
  profileHash: string;
  capabilities: string[];
  resources: string[];
  obligations: string[];
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

export interface CapabilityAuditContext {
  missionId: string;
  workerRunId: string;
  correlationId: string;
  profileHash: string;
  taskId?: string;
}

export interface CapabilityBroker {
  issue(grant: CapabilityGrantInput, context: CapabilityAuditContext): Promise<string>;
  authorizeUse(
    request: { token: string; capability: string; resource?: string },
    context: CapabilityAuditContext,
    nowEpochSeconds?: number,
  ): Promise<{ allowed: boolean; reason: string; grant?: { obligations: string[] } }>;
}

export interface GithubConnectorOperation {
  operationId: string;
  action: string;
  resource: ActionResource;
  missionId: string;
  workerRunId: string;
  correlationId: string;
  obligations: string[];
  taskId?: string;
}

export interface GithubConnector {
  execute(operation: GithubConnectorOperation): Promise<void>;
}

const CapabilityActionSchema = z.object({
  id: z.string().min(1),
  action: z.string().min(1),
  resource: ActionResourceSchema,
});

const CapabilityRequestSchema = z.object({
  request: CapabilityActionSchema,
  ttlSeconds: z
    .number()
    .int()
    .positive()
    .max(15 * 60)
    .default(5 * 60),
});

const ConnectorUseSchema = z.object({
  token: z.string().min(1),
  request: CapabilityActionSchema,
});

const WorkerDescriptorSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  harness: z.enum(["codex", "claude", "pi", "local", "shell", "simulated"]),
  model: z.string().min(1).optional(),
  capabilities: z.object({
    kinds: z.array(
      z.enum([
        "context",
        "planning",
        "research",
        "design",
        "implementation",
        "debugging",
        "verification",
        "review",
        "integration",
        "deployment",
        "evaluation",
      ]),
    ),
    canWrite: z.boolean(),
    supportsStructuredEvents: z.boolean(),
    supportsTerminal: z.boolean(),
    supportsNativeSession: z.boolean(),
  }),
});

const RunnerClaimSchema = z.object({
  claimId: z.string().min(1),
  workers: z.array(WorkerDescriptorSchema).min(1),
});

const RunnerEventSchema = z.object({
  attempt: z.number().int().positive(),
  eventId: z.string().min(1),
  type: z.string().min(1),
  data: z.record(z.string(), z.unknown()).default({}),
});

const RunnerSettleSchema = z.object({
  attempt: z.number().int().positive(),
  result: WorkerResultSchema,
});

const RunnerHeartbeatSchema = z.object({ attempt: z.number().int().positive() });

const ALLOWED_RUNNER_EVENT_TYPES = new Set([
  "worker.native_session.bound",
  "worker.waiting_user",
  "worker.command.completed",
  "worker.file_change.completed",
  "worker.plan.updated",
  "worker.diff.updated",
]);

export async function createControlPlane(dependencies: ControlPlaneDependencies): Promise<Hono> {
  const clock = dependencies.clock ?? (() => new Date());
  const idFactory = dependencies.idFactory ?? randomUUID;
  const missions = new Map<string, MissionRecord>();
  const engines = new Map<string, MissionEngine>();
  const missionLocks = new Map<string, Promise<unknown>>();
  const claimMissions = new Map<string, string>();
  const storedEvents: DomainEvent[] = [];
  if (dependencies.eventStore) {
    for (const stored of await dependencies.eventStore.readAll()) {
      storedEvents.push(stored.event);
      applyMissionEvent(missions, stored.event);
      if (stored.event.type === "worker.leased" && typeof stored.event.data.claimId === "string") {
        claimMissions.set(stored.event.data.claimId, stored.event.missionId);
      }
    }
    logger.info({ missionCount: missions.size }, "mission records rebuilt from event store");
  }

  const recordEvent = async (
    type: string,
    missionId: string,
    occurredAt: string,
    data: Record<string, unknown>,
  ): Promise<DomainEvent> => {
    const event: DomainEvent = {
      id: idFactory(),
      occurredAt,
      missionId,
      correlationId: missionId,
      profileHash: dependencies.doctrine.profileHash,
      type,
      data,
    };
    if (dependencies.eventStore) await dependencies.eventStore.append(event);
    storedEvents.push(event);
    persistedEventIds.add(event.id);
    return event;
  };

  const persistedEventIds = new Set(storedEvents.map((event) => event.id));
  const flushEngine = async (engine: MissionEngine): Promise<void> => {
    for (const event of engine.getEvents()) {
      if (persistedEventIds.has(event.id)) continue;
      if (dependencies.eventStore) await dependencies.eventStore.append(event);
      persistedEventIds.add(event.id);
      storedEvents.push(event);
    }
  };

  for (const mission of missions.values()) {
    if (!mission.plan || mission.state !== "running") continue;
    if (mission.plan.profileHash !== dependencies.doctrine.profileHash) {
      throw new Error(`Cannot restore mission ${mission.id}: doctrine ${mission.plan.profileHash} is stale`);
    }
    const replayEvents = storedEvents.filter(
      (event) =>
        event.missionId === mission.id &&
        !["mission.drafted", "mission.planned", "mission.execution.started"].includes(event.type),
    );
    const engine = new MissionEngine(mission.plan, dependencies.doctrine, {
      workspacePath: dependencies.workspacePath ?? process.cwd(),
      replayEvents,
    });
    engines.set(mission.id, engine);
    await flushEngine(engine);
  }

  const withMissionLock = async <T>(missionId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = missionLocks.get(missionId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    missionLocks.set(missionId, next);
    try {
      return await next;
    } finally {
      if (missionLocks.get(missionId) === next) missionLocks.delete(missionId);
    }
  };

  const app = new Hono();

  app.get("/health", (context) =>
    context.json({
      ok: true,
      service: "sapling-control-plane",
      doctrine: dependencies.doctrine.profile.id,
      profileHash: dependencies.doctrine.profileHash,
    }),
  );

  app.post("/v1/missions", async (context) => {
    const input = z
      .object({ goal: z.string().min(1), context: z.record(z.string(), z.unknown()).default({}) })
      .parse(await context.req.json());
    const id = `mission-${randomUUID().slice(0, 12)}`;
    const createdAt = new Date().toISOString();
    await recordEvent("mission.drafted", id, createdAt, { goal: input.goal, context: input.context });
    missions.set(id, { id, goal: input.goal, context: input.context, state: "draft", createdAt });
    logger.info({ missionId: id }, "mission created");
    return context.json({ missionId: id }, 201);
  });

  app.put("/v1/missions/:id/plan", async (context) => {
    const id = context.req.param("id");
    const body = await readJson(context.req.raw);
    return withMissionLock(id, async () => {
      const mission = missions.get(id);
      if (!mission) return context.json({ error: "mission_not_found" }, 404);
      if (mission.state === "running" || engines.has(id)) {
        return context.json({ error: "mission_plan_immutable_after_start" }, 409);
      }
      const parsedPlan = MissionPlanSchema.safeParse(body);
      if (!parsedPlan.success) return context.json({ error: "invalid_mission_plan" }, 400);
      const plan = parsedPlan.data;
      if (plan.missionId !== id) return context.json({ error: "mission_id_mismatch" }, 409);
      if (plan.profileHash !== dependencies.doctrine.profileHash) {
        return context.json(
          { error: "doctrine_hash_mismatch", expected: dependencies.doctrine.profileHash },
          409,
        );
      }
      try {
        assertValidDag(plan.tasks);
        assertSupportedPullPlan(plan);
      } catch (error) {
        return context.json(
          {
            error: "unsupported_mission_plan",
            message: error instanceof Error ? error.message : String(error),
          },
          400,
        );
      }
      await recordEvent("mission.planned", id, clock().toISOString(), { plan });
      mission.plan = plan;
      mission.state = "planned";
      logger.info({ missionId: id, taskCount: plan.tasks.length }, "mission planned");
      return context.json(plan);
    });
  });

  app.post("/v1/missions/:id/start", async (context) => {
    if (!dependencies.authenticateCaptain) {
      return context.json({ error: "captain_execution_unavailable" }, 503);
    }
    if (!dependencies.authenticateRunner) {
      return context.json({ error: "runner_execution_unavailable" }, 503);
    }
    const captain = await dependencies.authenticateCaptain(context.req.raw);
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    const id = context.req.param("id");
    return withMissionLock(id, async () => {
      const mission = missions.get(id);
      if (!mission) return context.json({ error: "mission_not_found" }, 404);
      if (!mission.plan) return context.json({ error: "mission_plan_required" }, 409);
      const existing = engines.get(id);
      if (existing) return context.json({ missionId: id, snapshot: existing.getSnapshot() });

      let engine: MissionEngine;
      try {
        assertSupportedPullPlan(mission.plan);
        engine = new MissionEngine(mission.plan, dependencies.doctrine, {
          workspacePath: dependencies.workspacePath ?? process.cwd(),
          clock,
          idFactory,
        });
      } catch (error) {
        return context.json(
          { error: "mission_start_invalid", message: error instanceof Error ? error.message : String(error) },
          409,
        );
      }
      const occurredAt = clock().toISOString();
      await flushEngine(engine);
      await recordEvent("mission.execution.started", id, occurredAt, { captainId: captain.captainId });
      mission.state = "running";
      engines.set(id, engine);
      logger.info({ missionId: id, captainId: captain.captainId }, "mission execution started");
      return context.json({ missionId: id, snapshot: engine.getSnapshot() }, 202);
    });
  });

  app.get("/v1/missions/:id", (context) => {
    const mission = missions.get(context.req.param("id"));
    if (!mission) return context.json({ error: "mission_not_found" }, 404);
    const snapshot = engines.get(mission.id)?.getSnapshot();
    return context.json(snapshot ? liveMissionRecord(mission, snapshot) : mission);
  });

  app.post("/v1/runner/claims", async (context) => {
    const runner = await authenticateRunner(context.req.raw, dependencies);
    if (runner === "unavailable") return context.json({ error: "runner_execution_unavailable" }, 503);
    if (!runner) return context.json({ error: "runner_authentication_required" }, 401);
    const parsed = RunnerClaimSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_runner_claim" }, 400);
    const claimId = `${runner.runnerId}:${parsed.data.claimId}`;
    const missionIds = claimMissions.has(claimId)
      ? [claimMissions.get(claimId) as string]
      : [...engines.keys()];
    for (const missionId of missionIds) {
      const assignment = await withMissionLock(missionId, async () => {
        const engine = engines.get(missionId);
        if (!engine) return undefined;
        engine.expireAbandonedWorkerRuns(clock());
        const leased = engine.leaseReadyTask(
          parsed.data.workers as WorkerDescriptor[],
          claimId,
          runner.runnerId,
          dependencies.workerLeaseDurationMs,
        );
        await flushEngine(engine);
        if (leased) claimMissions.set(claimId, missionId);
        return leased;
      });
      if (assignment) {
        logger.info(
          { runnerId: runner.runnerId, missionId: assignment.missionId, workerRunId: assignment.workerRunId },
          "worker task leased",
        );
        return context.json({ assignment });
      }
      if (claimMissions.has(claimId)) break;
    }
    return context.body(null, 204);
  });

  app.post("/v1/runner/workers/:id/events", async (context) => {
    const runner = await authenticateRunner(context.req.raw, dependencies);
    if (runner === "unavailable") return context.json({ error: "runner_execution_unavailable" }, 503);
    if (!runner) return context.json({ error: "runner_authentication_required" }, 401);
    const parsed = RunnerEventSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_worker_event" }, 400);
    if (!ALLOWED_RUNNER_EVENT_TYPES.has(parsed.data.type)) {
      return context.json({ error: "worker_event_type_not_allowed" }, 400);
    }
    const entry = findEngineForWorkerRun(engines, context.req.param("id"));
    if (!entry) return context.json({ error: "unknown_worker_run" }, 404);
    return withMissionLock(entry.missionId, async () => {
      try {
        const event = entry.engine.recordWorkerEvent(
          { workerRunId: context.req.param("id"), ...parsed.data },
          runner.runnerId,
        );
        await flushEngine(entry.engine);
        return context.json({ accepted: true, event });
      } catch (error) {
        return workerConflictResponse(context, error);
      }
    });
  });

  app.post("/v1/runner/workers/:id/settle", async (context) => {
    const runner = await authenticateRunner(context.req.raw, dependencies);
    if (runner === "unavailable") return context.json({ error: "runner_execution_unavailable" }, 503);
    if (!runner) return context.json({ error: "runner_authentication_required" }, 401);
    const parsed = RunnerSettleSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_worker_settlement" }, 400);
    const entry = findEngineForWorkerRun(engines, context.req.param("id"));
    if (!entry) return context.json({ error: "unknown_worker_run" }, 404);
    return withMissionLock(entry.missionId, async () => {
      try {
        const taskId = taskIdForWorkerRun(entry.engine, context.req.param("id"));
        const taskSpec = taskId ? entry.engine.getTask(taskId).spec : undefined;
        if (
          taskSpec?.kind === "verification" &&
          parsed.data.result.status === "succeeded" &&
          !parsed.data.result.evidence.some((evidence) => evidence.kind === "test_report")
        ) {
          return context.json({ error: "verification_evidence_required" }, 409);
        }
        const task = entry.engine.settleWorkerRun(
          context.req.param("id"),
          parsed.data.attempt,
          parsed.data.result,
          runner.runnerId,
        );
        if (
          task.spec.kind === "verification" &&
          task.state === "succeeded" &&
          entry.engine.getSnapshot().state !== "succeeded" &&
          entry.engine.getSnapshot().tasks.every((runtime) => runtime.state === "succeeded")
        ) {
          entry.engine.completeMission("Implementation and deterministic verification succeeded.");
        }
        await flushEngine(entry.engine);
        return context.json({ accepted: true, task, snapshot: entry.engine.getSnapshot() });
      } catch (error) {
        return workerConflictResponse(context, error);
      }
    });
  });

  app.post("/v1/runner/workers/:id/heartbeat", async (context) => {
    const runner = await authenticateRunner(context.req.raw, dependencies);
    if (runner === "unavailable") return context.json({ error: "runner_execution_unavailable" }, 503);
    if (!runner) return context.json({ error: "runner_authentication_required" }, 401);
    const parsed = RunnerHeartbeatSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_worker_heartbeat" }, 400);
    const entry = findEngineForWorkerRun(engines, context.req.param("id"));
    if (!entry) return context.json({ error: "unknown_worker_run" }, 404);
    return withMissionLock(entry.missionId, async () => {
      try {
        const task = entry.engine.heartbeatWorkerRun(
          context.req.param("id"),
          parsed.data.attempt,
          runner.runnerId,
          dependencies.workerLeaseDurationMs,
        );
        await flushEngine(entry.engine);
        return context.json({ accepted: true, leaseExpiresAt: task.leaseExpiresAt });
      } catch (error) {
        return workerConflictResponse(context, error);
      }
    });
  });

  app.post("/v1/actions/decide", async (context) => {
    const request = ActionRequestSchema.parse(await context.req.json());
    if (request.context.profileHash !== dependencies.doctrine.profileHash) {
      return context.json({
        effect: "deny",
        reason: "The action was requested under a stale doctrine hash.",
        matchedPolicyIds: ["stale-doctrine"],
        obligations: [],
      });
    }
    const decision = decideAction(dependencies.doctrine, request);
    logger.info(
      { missionId: request.context.missionId, action: request.action, effect: decision.effect },
      "action decided",
    );
    return context.json(decision);
  });

  app.post("/v1/workers/:id/capabilities", async (context) => {
    if (
      !dependencies.authenticateWorker ||
      !dependencies.resolveActionContext ||
      !dependencies.classifyConnectorAction ||
      !dependencies.capabilityBroker
    ) {
      return context.json({ error: "capability_exchange_unavailable" }, 503);
    }
    const identity = await dependencies.authenticateWorker(context.req.raw);
    if (!identity) return context.json({ error: "worker_authentication_required" }, 401);

    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: "invalid_capability_request" }, 400);
    }
    const parsedInput = CapabilityRequestSchema.safeParse(body);
    if (!parsedInput.success) return context.json({ error: "invalid_capability_request" }, 400);
    const input = parsedInput.data;
    const identityError = validateWorkerBinding(context.req.param("id"), identity, dependencies);
    if (identityError) return context.json({ error: identityError }, 403);
    const trustedContext = await dependencies.resolveActionContext(identity, input.request);
    if (!trustedContext) {
      return context.json({ error: "action_context_unavailable" }, 403);
    }
    const classification = await dependencies.classifyConnectorAction(input.request);
    if (!classification) {
      return context.json({ error: "connector_action_unclassified" }, 403);
    }

    const actionRequest = ActionRequestSchema.parse({
      ...input.request,
      principal: { kind: "worker", id: identity.workerRunId },
      context: {
        ...trustedContext,
        missionId: identity.missionId,
        ...(identity.taskId ? { taskId: identity.taskId } : {}),
        profileHash: identity.profileHash,
      },
    });
    const decision = decideCapabilityRequest(dependencies.doctrine, actionRequest, classification);
    logger.info(
      {
        missionId: identity.missionId,
        workerRunId: identity.workerRunId,
        action: input.request.action,
        effect: decision.effect,
      },
      "worker capability request decided",
    );
    if (!permitsCapabilityGrant(decision)) {
      return context.json({ error: "capability_not_allowed", decision }, 403);
    }

    const issuedAt = Math.floor(clock().getTime() / 1000);
    const resource = connectorResourceKey(input.request.resource);
    const grant: CapabilityGrantInput = {
      version: 1,
      grantId: `grant-${idFactory()}`,
      principalId: identity.workerRunId,
      missionId: identity.missionId,
      profileHash: identity.profileHash,
      capabilities: [input.request.action],
      resources: [resource],
      obligations: decision.obligations,
      issuedAt,
      expiresAt: issuedAt + input.ttlSeconds,
      nonce: idFactory(),
    };
    const token = await dependencies.capabilityBroker.issue(grant, auditContext(identity, dependencies));
    return context.json(
      {
        token,
        grant: {
          grantId: grant.grantId,
          capability: input.request.action,
          resource,
          issuedAt: grant.issuedAt,
          expiresAt: grant.expiresAt,
        },
        decision,
      },
      201,
    );
  });

  app.post("/v1/workers/:id/connectors/github/execute", async (context) => {
    if (!dependencies.authenticateWorker || !dependencies.capabilityBroker) {
      return context.json({ error: "capability_exchange_unavailable" }, 503);
    }
    if (!dependencies.githubConnector) {
      return context.json({ error: "github_connector_unavailable" }, 503);
    }
    const identity = await dependencies.authenticateWorker(context.req.raw);
    if (!identity) return context.json({ error: "worker_authentication_required" }, 401);

    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: "invalid_connector_request" }, 400);
    }
    const parsedInput = ConnectorUseSchema.safeParse(body);
    if (!parsedInput.success) return context.json({ error: "invalid_connector_request" }, 400);
    const input = parsedInput.data;
    const identityError = validateWorkerBinding(context.req.param("id"), identity, dependencies);
    if (identityError) return context.json({ error: identityError }, 403);
    if (!input.request.action.startsWith("github.")) {
      return context.json({ error: "github_action_required" }, 400);
    }
    const use = await dependencies.capabilityBroker.authorizeUse(
      {
        token: input.token,
        capability: input.request.action,
        resource: connectorResourceKey(input.request.resource),
      },
      auditContext(identity, dependencies),
      Math.floor(clock().getTime() / 1000),
    );
    if (!use.allowed) {
      return context.json({ error: "capability_use_denied", reason: use.reason }, 403);
    }
    if (!use.grant) {
      return context.json({ error: "capability_grant_missing" }, 500);
    }

    const operationId = `github-operation-${idFactory()}`;
    const operation: GithubConnectorOperation = {
      operationId,
      action: input.request.action,
      resource: input.request.resource,
      missionId: identity.missionId,
      workerRunId: identity.workerRunId,
      correlationId: identity.correlationId,
      obligations: use.grant.obligations,
      ...(identity.taskId ? { taskId: identity.taskId } : {}),
    };
    const connectorResult: unknown = await dependencies.githubConnector.execute(operation);
    if (connectorResult !== undefined) {
      return context.json({ error: "invalid_connector_result" }, 502);
    }
    logger.info(
      {
        missionId: identity.missionId,
        workerRunId: identity.workerRunId,
        action: input.request.action,
        operationId,
      },
      "privileged GitHub connector operation completed",
    );
    return context.json({ result: { accepted: true, operationId } });
  });

  app.post("/v1/workers/:id/steer", async (context) => {
    const workerRunId = context.req.param("id");
    const input = z.object({ input: z.string().min(1).max(20_000) }).parse(await context.req.json());
    logger.info({ workerRunId, inputLength: input.input.length }, "worker steering accepted by API shell");
    return context.json(
      { accepted: false, reason: "Runner command bus is not connected in the skeleton." },
      501,
    );
  });

  return app;
}

function auditContext(
  identity: TrustedWorkerIdentity,
  dependencies: ControlPlaneDependencies,
): CapabilityAuditContext {
  return {
    missionId: identity.missionId,
    workerRunId: identity.workerRunId,
    correlationId: identity.correlationId,
    profileHash: dependencies.doctrine.profileHash,
    ...(identity.taskId ? { taskId: identity.taskId } : {}),
  };
}

function validateWorkerBinding(
  routeWorkerRunId: string,
  identity: TrustedWorkerIdentity,
  dependencies: ControlPlaneDependencies,
): string | undefined {
  if (routeWorkerRunId !== identity.workerRunId) return "worker_route_mismatch";
  if (identity.profileHash !== dependencies.doctrine.profileHash) return "stale_doctrine";
  return undefined;
}

function connectorResourceKey(resource: ActionResource): string {
  return JSON.stringify([
    resource.type,
    resource.id,
    resource.repository ?? null,
    resource.environment ?? null,
  ]);
}

async function authenticateRunner(
  request: Request,
  dependencies: ControlPlaneDependencies,
): Promise<TrustedRunnerIdentity | "unavailable" | undefined> {
  if (!dependencies.authenticateRunner) return "unavailable";
  return dependencies.authenticateRunner(request);
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function findEngineForWorkerRun(
  engines: ReadonlyMap<string, MissionEngine>,
  workerRunId: string,
): { missionId: string; engine: MissionEngine } | undefined {
  for (const [missionId, engine] of engines) {
    const leased = engine
      .getEvents()
      .find((event) => event.type === "worker.leased" && event.workerRunId === workerRunId);
    if (leased) return { missionId, engine };
  }
  return undefined;
}

function taskIdForWorkerRun(engine: MissionEngine, workerRunId: string): string | undefined {
  return engine
    .getEvents()
    .find((event) => event.type === "worker.leased" && event.workerRunId === workerRunId)?.taskId;
}

function workerConflictResponse(context: Context, error: unknown): Response {
  if (!(error instanceof WorkerRunConflictError)) throw error;
  const status = error.code === "unknown_worker_run" ? 404 : 409;
  return context.json({ error: error.code, message: error.message }, status);
}

function liveMissionRecord(mission: MissionRecord, snapshot: MissionSnapshot): Record<string, unknown> {
  return {
    ...mission,
    state: snapshot.state,
    tasks: snapshot.tasks,
    approvals: snapshot.approvals,
    eventCount: snapshot.eventCount,
    snapshot,
  };
}

function assertSupportedPullPlan(plan: MissionPlan): void {
  if (plan.tasks.length !== 2) {
    throw new Error("Runner pull execution currently requires exactly implementation + verification tasks");
  }
  const implementation = plan.tasks.find((task) => task.kind === "implementation");
  const verification = plan.tasks.find((task) => task.kind === "verification");
  if (!implementation || !verification) {
    throw new Error("Runner pull execution requires one implementation and one verification task");
  }
  if (
    implementation.role !== "implementer" ||
    implementation.dependsOn.length !== 0 ||
    implementation.writeScope.length === 0
  ) {
    throw new Error(
      "The implementation task must use the implementer role, be the root, and declare a non-empty write scope",
    );
  }
  if (
    verification.role !== "verifier" ||
    verification.writeScope.length !== 0 ||
    verification.dependsOn.length !== 1 ||
    verification.dependsOn[0] !== implementation.id
  ) {
    throw new Error("The read-only verifier must depend only on the implementation candidate");
  }
}

export function createBearerAuthenticator<T>(
  token: string,
  identity: T,
): (request: Request) => Promise<T | undefined> {
  if (token.length === 0) throw new Error("Authentication token must not be empty");
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  return (request) => {
    const actual = createHash("sha256")
      .update(request.headers.get("authorization") ?? "")
      .digest();
    return Promise.resolve(timingSafeEqual(actual, expected) ? identity : undefined);
  };
}

function applyMissionEvent(missions: Map<string, MissionRecord>, event: DomainEvent): void {
  if (event.type === "mission.drafted") {
    const data = z
      .object({ goal: z.string().min(1), context: z.record(z.string(), z.unknown()).default({}) })
      .parse(event.data);
    missions.set(event.missionId, {
      id: event.missionId,
      goal: data.goal,
      context: data.context,
      state: "draft",
      createdAt: event.occurredAt,
    });
    return;
  }
  if (event.type === "mission.planned") {
    const mission = missions.get(event.missionId);
    if (!mission) {
      logger.warn({ missionId: event.missionId }, "mission.planned event without a drafted mission");
      return;
    }
    mission.plan = MissionPlanSchema.parse(event.data.plan);
    mission.state = "planned";
    return;
  }
  if (event.type === "mission.execution.started") {
    const mission = missions.get(event.missionId);
    if (mission) mission.state = "running";
  }
}

export async function loadDefaultDoctrine(): Promise<CompiledDoctrine> {
  const doctrinePath = resolve(process.env.SAPLING_DOCTRINE ?? "doctrine/profiles/self-build-lab.yaml");
  return compileDoctrine([await loadDoctrineFile(doctrinePath)]);
}
