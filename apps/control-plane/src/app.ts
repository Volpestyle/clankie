import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  compileDoctrine,
  decideAction,
  decideCapabilityRequest,
  loadDoctrineFile,
  permitsCapabilityGrant,
  type CompiledDoctrine,
} from "@sapling/doctrine";
import type { EventStore } from "@sapling/event-store";
import { createLogger } from "@sapling/observability";
import {
  ActionResourceSchema,
  ActionRequestSchema,
  MissionPlanSchema,
  type ActionResource,
  type DomainEvent,
  type MissionPlan,
  type Risk,
} from "@sapling/protocol";
import { Hono } from "hono";
import { z } from "zod";

const logger = createLogger({ service: "sapling-control-plane", version: "0.1.0" });

interface MissionRecord {
  id: string;
  goal: string;
  context: Record<string, unknown>;
  state: "draft" | "planned";
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
  /** Runner-owned privileged connector. Its credential access is not part of this interface. */
  githubConnector?: GithubConnector;
  clock?: () => Date;
  idFactory?: () => string;
}

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

export async function createControlPlane(dependencies: ControlPlaneDependencies): Promise<Hono> {
  const clock = dependencies.clock ?? (() => new Date());
  const idFactory = dependencies.idFactory ?? randomUUID;
  const missions = new Map<string, MissionRecord>();
  if (dependencies.eventStore) {
    for (const stored of await dependencies.eventStore.readAll()) {
      applyMissionEvent(missions, stored.event);
    }
    logger.info({ missionCount: missions.size }, "mission records rebuilt from event store");
  }

  const recordEvent = async (
    type: string,
    missionId: string,
    occurredAt: string,
    data: Record<string, unknown>,
  ): Promise<void> => {
    if (!dependencies.eventStore) return;
    await dependencies.eventStore.append({
      id: randomUUID(),
      occurredAt,
      missionId,
      correlationId: missionId,
      profileHash: dependencies.doctrine.profileHash,
      type,
      data,
    });
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
    const mission = missions.get(id);
    if (!mission) return context.json({ error: "mission_not_found" }, 404);
    const plan = MissionPlanSchema.parse(await context.req.json());
    if (plan.missionId !== id) return context.json({ error: "mission_id_mismatch" }, 409);
    if (plan.profileHash !== dependencies.doctrine.profileHash) {
      return context.json(
        { error: "doctrine_hash_mismatch", expected: dependencies.doctrine.profileHash },
        409,
      );
    }
    await recordEvent("mission.planned", id, new Date().toISOString(), { plan });
    mission.plan = plan;
    mission.state = "planned";
    logger.info({ missionId: id, taskCount: plan.tasks.length }, "mission planned");
    return context.json(plan);
  });

  app.get("/v1/missions/:id", (context) => {
    const mission = missions.get(context.req.param("id"));
    return mission ? context.json(mission) : context.json({ error: "mission_not_found" }, 404);
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
    const decision = decideCapabilityRequest(dependencies.doctrine, actionRequest);
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
  }
}

export async function loadDefaultDoctrine(): Promise<CompiledDoctrine> {
  const doctrinePath = resolve(process.env.SAPLING_DOCTRINE ?? "doctrine/profiles/self-build-lab.yaml");
  return compileDoctrine([await loadDoctrineFile(doctrinePath)]);
}
