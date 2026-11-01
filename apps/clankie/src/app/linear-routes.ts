import { createHash } from "node:crypto";
import { LinearWakeUpdateSchema, LinearFollowUpdateSchema } from "@clankie/protocol/linear-settings";
import { LINEAR_WEBHOOK_PATH } from "@clankie/protocol/public-gateway";
import { linearFollowStatus, linearWakeMatches, LinearWebhookSettingsSchema } from "@clankie/settings";
import { Hono } from "hono";
import { z } from "zod";
import {
  classifyLinearDelivery,
  linearArrival,
  linearReplyTo,
  linearActivityWakeTypes,
  linearActivityProject,
  linearTrackerActivity,
  type LinearActivityEvent,
  type LinearWriteReceipts,
} from "../linear-webhook.ts";
import { linearMirrorEvent } from "../linear-mirror.ts";
import { CutoverRequestSchema } from "../linear-cutover.ts";
import { readJson } from "./http-auth.ts";
import { logger } from "./log.ts";
import type { ExtensionRouteHost, ExtensionRoutes } from "../ports/routes.ts";
import {
  LINEAR_REQUEST_BUDGET_PATH,
  LinearRequestBudgetReportSchema,
} from "@clankie/protocol/linear-request-budget";

/** What Linear's routes are handed by the composition root (ADR 0328). */
export interface LinearRouteParts {
  /**
   * The broker-held Linear webhook signing secret (ADR 0165). Absent means no
   * webhook is configured and the route reports itself unavailable; the wake it
   * leads to belongs to the captain.
   */
  readonly linearWebhook?: {
    secret(): Promise<string | undefined>;
    writes?: LinearWriteReceipts;
    recordActivity?(activity: LinearActivityEvent): void;
    /** His own verified Linear identity; activity it authors is kept without a wake. */
    ownAccount?(): Promise<{ userId: string; workspaceId: string } | undefined>;
    /** Bounded read of missing issue context through the verified connected account. */
    issueContext?(activity: LinearActivityEvent): Promise<LinearActivityEvent["issueContext"]>;
    projectContext?(activity: LinearActivityEvent): Promise<LinearActivityEvent["projectContext"]>;
    /** Owner-enabled Linear mirrors (VUH-1965): applied after the response, never gating a wake. */
    mirror?(event: import("@clankie/work-items").LinearMirrorEvent): void;
  };
  readonly linearRequestBudget?: Pick<import("../linear-request-budget.ts").LinearRequestBudget, "report">;
  /** Owner command for a scratch store's webhook mirror (VUH-1965). */
  readonly linearMirrors?: Pick<import("../linear-mirror.ts").LinearMirrors, "configure">;
  /** Mirror 3 (VUH-1987): owner-run cutover from Linear and its switch-back. */
  readonly linearCutover?: Pick<import("../linear-cutover.ts").LinearCutover, "run">;
}

/** Linear's webhook, wake and settings routes, mounted by the core where they always were. */
export function linearRoutes(parts: LinearRouteParts = {}): ExtensionRoutes {
  return {
    place: "tracker",
    register: (app, host) =>
      registerLinearRoutes({
        app,
        dependencies: { ...parts, captain: host.trackerWakes },
        operator: (request) => host.operator(request),
        settingsSource: host.settings,
        clock: host.clock,
        authorizeOwnerSettings: (request) => host.ownerSettings(request),
      }),
  };
}

export interface RegisterLinearRoutesContext {
  readonly app: Hono;
  readonly dependencies: LinearRouteParts & { readonly captain: ExtensionRouteHost["trackerWakes"] };
  /** Absent means operator authentication is unavailable. */
  readonly operator?: ExtensionRouteHost["operator"];
  readonly settingsSource: ExtensionRouteHost["settings"];
  readonly clock: () => Date;
  readonly authorizeOwnerSettings?: ExtensionRouteHost["ownerSettings"];
}

export function registerLinearRoutes(ctx: RegisterLinearRoutesContext) {
  const operatorOf = ctx.operator ?? (async () => "unavailable" as const);
  // Mirror 2 (VUH-1965): the owner turns a scratch import's webhook mirror on or off.
  ctx.app.post("/v1/tracker/mirror/linear", async (context) => {
    const identity = await operatorOf(context.req.raw);
    if (!identity || identity === "unavailable") return context.json({ error: "operator_required" }, 401);
    const parsed = z
      .object({
        projectId: z.string().uuid(),
        scratch: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/u),
        action: z.enum(["enable", "disable", "status"]),
      })
      .strict()
      .safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
    if (!ctx.dependencies.linearMirrors) return context.json({ error: "mirror_unavailable" }, 503);
    try {
      return context.json(
        await ctx.dependencies.linearMirrors.configure(
          parsed.data.scratch,
          parsed.data.projectId,
          parsed.data.action,
        ),
      );
    } catch (error) {
      return context.json(
        { error: "linear_mirror_refused", detail: error instanceof Error ? error.message : String(error) },
        409,
      );
    }
  });
  // Mirror 3 (VUH-1987): the owner cuts a World project over to the built-in tracker,
  // or switches it back. A dry run reads only (Linear included) and prints every change.
  ctx.app.post("/v1/tracker/cutover/linear", async (context) => {
    const identity = await operatorOf(context.req.raw);
    if (!identity || identity === "unavailable") return context.json({ error: "operator_required" }, 401);
    const parsed = CutoverRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
    if (!ctx.dependencies.linearCutover) return context.json({ error: "cutover_unavailable" }, 503);
    try {
      const result = (await ctx.dependencies.linearCutover.run(parsed.data)) as { ready: boolean };
      return context.json(result, result.ready || parsed.data.dryRun ? 200 : 409);
    } catch (error) {
      return context.json(
        { error: "linear_cutover_failed", detail: error instanceof Error ? error.message : String(error) },
        422,
      );
    }
  });
  ctx.app.on(["GET", "PUT"], "/v1/linear/routes", async (context) => {
    const operator = await operatorOf(context.req.raw);
    if (operator === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    let current;
    if (context.req.method === "PUT") {
      const input = z
        .object({ projectChats: LinearWebhookSettingsSchema.shape.projectChats })
        .strict()
        .safeParse(await readJson(context.req.raw));
      if (!input.success) return context.json({ error: "malformed" }, 400);
      if (
        input.data.projectChats.some(
          (route) => !ctx.dependencies.captain.trackerWakeTargetAllowed(route.conversationId),
        )
      )
        return context.json({ error: "linear_wake_target_unavailable" }, 409);
      if (!ctx.settingsSource.update) return context.json({ error: "settings_unavailable" }, 503);
      current = await ctx.settingsSource.update((value) => ({
        ...value,
        linearWebhook: { ...value.linearWebhook, projectChats: input.data.projectChats },
      }));
    } else current = await ctx.settingsSource.load();
    return context.json({ schemaVersion: 1, projectChats: current.linearWebhook.projectChats });
  });
  ctx.app.get("/v1/linear/deliveries", async (context) => {
    const operator = await operatorOf(context.req.raw);
    if (operator === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    return context.json({
      schemaVersion: 1,
      deliveries: ctx.dependencies.captain.trackerWakeDeliveries?.() ?? [],
      recoveries: ctx.dependencies.captain.trackerWakeRecoveries?.() ?? [],
    });
  });
  ctx.app.get(LINEAR_REQUEST_BUDGET_PATH, async (context) => {
    const operator = await operatorOf(context.req.raw);
    if (operator === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    if (!ctx.dependencies.linearRequestBudget)
      return context.json({ error: "linear_request_budget_unavailable" }, 503);
    return context.json(LinearRequestBudgetReportSchema.parse(ctx.dependencies.linearRequestBudget.report()));
  });

  const revision = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const owner = async (request: Request) =>
    ctx.authorizeOwnerSettings ? ctx.authorizeOwnerSettings(request) : ("forbidden" as const);
  for (const path of ["/v1/linear/wake", "/v1/linear/follow"])
    ctx.app.use(path, async (context, next) => {
      context.header("cache-control", "no-store");
      const authority = await owner(context.req.raw);
      if (authority !== true)
        return context.json({ error: authority }, authority === "forbidden" ? 403 : 401);
      await next();
    });
  ctx.app.on(["GET", "POST", "PUT"], "/v1/linear/wake", async (context) => {
    let current;
    if (context.req.method !== "GET") {
      const parsed = LinearWakeUpdateSchema.safeParse(await readJson(context.req.raw));
      if (!parsed.success) return context.json({ error: "malformed" }, 400);
      if (!ctx.settingsSource.update) return context.json({ error: "settings_unavailable" }, 503);
      let before: string | undefined;
      try {
        current = await ctx.settingsSource.update(
          (value) => {
            before = JSON.stringify(value);
            if (revision(value.linearWebhook.wake) !== parsed.data.expectedRevision)
              throw new Error("settings_revision_conflict");
            return { ...value, linearWebhook: { ...value.linearWebhook, wake: parsed.data.wake } };
          },
          async () => {
            if ((await owner(context.req.raw)) !== true) throw new Error("owner_revoked");
            if (JSON.stringify(await ctx.settingsSource.load()) !== before)
              throw new Error("settings_revision_conflict");
          },
        );
      } catch {
        return context.json({ error: "settings_revision_conflict" }, 409);
      }
    } else current = await ctx.settingsSource.load();
    if ((await owner(context.req.raw)) !== true) return context.json({ error: "forbidden" }, 403);
    return context.json({
      schemaVersion: 1,
      revision: revision(current.linearWebhook.wake),
      wake: current.linearWebhook.wake,
    });
  });

  ctx.app.on(["GET", "PUT"], "/v1/linear/target", async (context) => {
    const operator = await operatorOf(context.req.raw);
    if (operator === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    let current;
    if (context.req.method === "PUT") {
      const input = z
        .object({
          conversationId: z
            .string()
            .regex(/^[a-zA-Z0-9_-]+$/u)
            .max(256),
        })
        .strict()
        .safeParse(await readJson(context.req.raw));
      if (!input.success) return context.json({ error: "malformed" }, 400);
      // Use the same ordinary-chat guard as the captain's settings tool.
      if (!ctx.dependencies.captain.trackerWakeTargetAllowed(input.data.conversationId))
        return context.json({ error: "linear_wake_target_unavailable" }, 409);
      if (!ctx.settingsSource.update) return context.json({ error: "settings_unavailable" }, 503);
      current = await ctx.settingsSource.update((value) => ({
        ...value,
        linearWebhook: { ...value.linearWebhook, wakeConversationId: input.data.conversationId },
      }));
    } else current = await ctx.settingsSource.load();
    return context.json({ schemaVersion: 1, wakeConversationId: current.linearWebhook.wakeConversationId });
  });

  ctx.app.on(["GET", "POST", "PUT"], "/v1/linear/follow", async (context) => {
    const secret = await ctx.dependencies.linearWebhook?.secret();
    const secretPresent = secret !== undefined && secret.trim().length > 0;
    let current;
    if (context.req.method !== "GET") {
      const parsed = LinearFollowUpdateSchema.safeParse(await readJson(context.req.raw));
      if (!parsed.success) return context.json({ error: "malformed" }, 400);
      if (!ctx.settingsSource.update) return context.json({ error: "settings_unavailable" }, 503);
      let before: string | undefined;
      try {
        current = await ctx.settingsSource.update(
          (value) => {
            before = JSON.stringify(value);
            if (revision(value.linearWebhook) !== parsed.data.expectedRevision)
              throw new Error("settings_revision_conflict");
            if (
              parsed.data.following &&
              !linearFollowStatus(value.linearWebhook, secretPresent).webhookConfigured
            )
              throw new Error("linear_webhook_required");
            return { ...value, linearWebhook: { ...value.linearWebhook, following: parsed.data.following } };
          },
          async () => {
            if ((await owner(context.req.raw)) !== true) throw new Error("owner_revoked");
            if (JSON.stringify(await ctx.settingsSource.load()) !== before)
              throw new Error("settings_revision_conflict");
          },
        );
      } catch (error) {
        return context.json(
          { error: error instanceof Error ? error.message : "settings_revision_conflict" },
          409,
        );
      }
    } else current = await ctx.settingsSource.load();
    if ((await owner(context.req.raw)) !== true) return context.json({ error: "forbidden" }, 403);
    return context.json({
      schemaVersion: 1,
      revision: revision(current.linearWebhook),
      ...linearFollowStatus(current.linearWebhook, secretPresent),
      wakeConversationId: current.linearWebhook.wakeConversationId,
    });
  });

  // Linear authenticates with an HMAC over the raw body, not our operator bearer.
  // Authentic deliveries receive 200 even when follow mode is off.

  ctx.app.post(LINEAR_WEBHOOK_PATH, async (context) => {
    const hook = ctx.dependencies.linearWebhook;
    if (hook === undefined) return context.json({ error: "linear_webhook_unavailable" }, 503);
    const secret = await hook.secret();
    if (secret === undefined || secret.length === 0) {
      return context.json({ error: "linear_webhook_unavailable" }, 503);
    }
    // The raw bytes, before any parse: the signature covers what Linear sent,
    // and `readJson` would throw exactly those bytes away.
    const rawBody = new Uint8Array(await context.req.raw.arrayBuffer());
    const outcome = classifyLinearDelivery({
      rawBody,
      headers: {
        signature: context.req.header("linear-signature"),
        delivery: context.req.header("linear-delivery"),
        event: context.req.header("linear-event"),
      },
      secret,
      now: ctx.clock(),
      ...(hook.writes === undefined ? {} : { writes: hook.writes }),
      recordActivity: hook.recordActivity,
    });

    if (outcome.kind === "rejected") {
      logger.warn({ reason: outcome.reason }, "linear webhook rejected");
      return context.json(
        { error: outcome.reason === "malformed" ? "malformed" : "invalid_signature" },
        outcome.reason === "malformed" ? 400 : 401,
      );
    }
    // Mirrors see every accepted change, including his own writes' echoes, but never steer wakes.
    const mirror = (activity: LinearActivityEvent) => {
      try {
        const event = linearMirrorEvent({ ...activity, projectId: linearActivityProject(activity)?.id });
        if (event) hook.mirror?.(event);
      } catch (error) {
        logger.warn({ error: String(error) }, "linear mirror hand-off failed");
      }
    };
    if (outcome.kind === "ignored") {
      if (outcome.reason === "self_echo" && outcome.activity) mirror(outcome.activity);
      const current = await ctx.settingsSource.load();
      logger.info(
        {
          event: "linear.webhook",
          eventId: outcome.activity?.eventId,
          deliveryId: outcome.activity?.deliveryId,
          type: outcome.activity?.type,
          action: outcome.activity?.action,
          issueId: outcome.activity?.issueId,
          target: current.linearWebhook.wakeConversationId,
          ingested: false,
          decision: outcome.reason,
        },
        "linear webhook ignored",
      );
      return context.json({ schemaVersion: 1 as const, ingested: false as const });
    }

    const current = await ctx.settingsSource.load();
    const own = await hook.ownAccount?.().catch(() => undefined);
    const replyTo = linearReplyTo(outcome.activity, own, hook.writes, ctx.clock());
    let activity = replyTo ? { ...outcome.activity, replyTo } : outcome.activity;
    const identityUnavailable = hook.ownAccount !== undefined && own === undefined;
    const workspaceMismatch = own !== undefined && own.workspaceId !== activity.organizationId;
    const signedIssue = activity.type === "Issue" ? activity.data : activity.data.issue;
    if (
      activity.issueId &&
      !identityUnavailable &&
      !workspaceMismatch &&
      !(
        linearActivityProject(activity) &&
        signedIssue &&
        typeof signedIssue === "object" &&
        "title" in signedIssue &&
        typeof signedIssue.title === "string"
      )
    ) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const context = await Promise.race([
        hook.issueContext?.(activity).catch(() => undefined),
        new Promise<undefined>((resolve) => {
          timeout = setTimeout(() => resolve(undefined), 1_000);
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
      if (context?.id.toLowerCase() === activity.issueId.toLowerCase())
        activity = { ...activity, issueContext: context };
    }
    if (!identityUnavailable && !workspaceMismatch && !linearActivityProject(activity)?.name) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const projectContext = await Promise.race([
        hook.projectContext?.(activity).catch(() => undefined),
        new Promise<undefined>((resolve) => {
          timeout = setTimeout(() => resolve(undefined), 1_000);
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
      if (projectContext) activity = { ...activity, projectContext };
    }
    const ownActor =
      own !== undefined && own.workspaceId === activity.organizationId && own.userId === activity.actorId;
    const ownWorker = activity.worker !== undefined;
    const types = linearActivityWakeTypes(activity, own, hook.writes, ctx.clock());
    const matches =
      !types.some((type) => current.linearWebhook.wake.excludedNotificationTypes.includes(type)) &&
      types.some((type) =>
        linearWakeMatches(
          current.linearWebhook.wake,
          type,
          activity.actorId
            ? {
                id: activity.actorId,
                type: activity.actorType,
                email: activity.actorEmail,
                worker: activity.worker,
              }
            : undefined,
          own !== undefined && own.workspaceId === activity.organizationId ? own.userId : "",
        ),
      );
    const project = linearActivityProject(activity);
    const route =
      project &&
      current.linearWebhook.projectChats.find((route) => route.projectId.toLowerCase() === project.id);
    const leadAvailable = route && ctx.dependencies.captain.trackerWakeTargetAllowed(route.conversationId);
    const target = leadAvailable
      ? route.conversationId
      : project
        ? "global-default"
        : current.linearWebhook.wakeConversationId;
    const reason = leadAvailable
      ? ("project_lead" as const)
      : project
        ? ("project_fallback" as const)
        : ("default" as const);
    activity = {
      ...activity,
      ...(project
        ? {
            projectContext: {
              id: project.id,
              name: project.name ?? (route ? route.name : `Project ${project.id}`),
            },
          }
        : {}),
      routing: { conversationId: target, reason },
      ...(own && !workspaceMismatch
        ? {
            notificationReceiver: { userId: own.userId, workspaceId: own.workspaceId },
            notificationTypes: types,
          }
        : {}),
    };
    const targetAllowed = ctx.dependencies.captain.trackerWakeTargetAllowed(target);
    const following =
      current.linearWebhook.following &&
      !identityUnavailable &&
      !workspaceMismatch &&
      !ownActor &&
      !ownWorker &&
      matches;
    const ingested =
      targetAllowed &&
      ctx.dependencies.captain.receiveTrackerActivity(linearTrackerActivity(activity), following, target);
    // Only what woke him arrives in the room, once: a replayed event is not ingested again.
    const sourceId = activity.eventId ?? activity.deliveryId;
    if (following && ingested !== false && sourceId !== undefined) {
      const rules = current.linearWebhook.wake;
      const owner =
        activity.actorType === "user" &&
        activity.actorId !== undefined &&
        (rules.ownerUserIds.includes(activity.actorId) ||
          (activity.actorEmail !== undefined &&
            rules.ownerUserEmails.some(
              (email) => email.toLowerCase() === activity.actorEmail!.toLowerCase(),
            )));
      ctx.dependencies.captain.recordInbound?.({
        channel: "linear",
        sourceId,
        at: ctx.clock().toISOString(),
        actor: { label: activity.actorName ?? "Linear", owner },
        ...linearArrival(activity),
        ...(activity.url === undefined ? {} : { url: activity.url }),
        conversationId: target,
      });
    }
    mirror(activity);
    logger.info(
      {
        event: "linear.webhook",
        eventId: activity.eventId,
        deliveryId: activity.deliveryId,
        type: activity.type,
        action: activity.action,
        issueId: activity.issueId,
        target,
        route: reason,
        projectId: project?.id,
        projectName: activity.projectContext?.name,
        ingested: ingested !== false,
        decision: !targetAllowed
          ? "target_unavailable"
          : ingested === false
            ? "deduped"
            : identityUnavailable
              ? "identity_unavailable"
              : workspaceMismatch
                ? "account_workspace_mismatch"
                : ownActor
                  ? "own_actor"
                  : ownWorker
                    ? "own_worker"
                    : !current.linearWebhook.following
                      ? "follow_off"
                      : matches
                        ? "wake"
                        : "rule_miss",
      },
      "linear webhook accepted",
    );
    return context.json({ schemaVersion: 1 as const, ingested: ingested !== false });
  });
}
