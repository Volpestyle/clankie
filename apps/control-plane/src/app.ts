import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { compileDoctrine, decideAction, loadDoctrineFile, type CompiledDoctrine } from "@sapling/doctrine";
import type { EventStore } from "@sapling/event-store";
import { createLogger } from "@sapling/observability";
import {
  ActionRequestSchema,
  MissionPlanSchema,
  type DomainEvent,
  type MissionPlan,
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
}

export async function createControlPlane(dependencies: ControlPlaneDependencies): Promise<Hono> {
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
