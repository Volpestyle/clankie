import { LINEAR_WEBHOOK_PATH } from "@clankie/protocol/public-gateway";
import { linearFollowStatus, linearWakeMatches, LinearWakeSettingsSchema } from "@clankie/settings";
import { Hono } from "hono";
import { z } from "zod";
import { classifyLinearDelivery, linearReplyTo, linearActivityWakeTypes } from "../linear-webhook.ts";
import { authenticateOperator, readJson } from "./http-auth.ts";
import { logger } from "./log.ts";
import type { ClankieAppDependencies } from "./types.ts";
import {
  LINEAR_REQUEST_BUDGET_PATH,
  LinearRequestBudgetReportSchema,
} from "@clankie/protocol/linear-request-budget";

export interface RegisterLinearRoutesContext {
  readonly app: Hono;
  readonly dependencies: Pick<
    ClankieAppDependencies,
    "captain" | "linearWebhook" | "authenticateOperator" | "linearRequestBudget"
  >;
  readonly settingsSource: NonNullable<ClankieAppDependencies["settings"]>;
  readonly clock: () => Date;
}

export function registerLinearRoutes(ctx: RegisterLinearRoutesContext) {
  ctx.app.get(LINEAR_REQUEST_BUDGET_PATH, async (context) => {
    const operator = await authenticateOperator(context.req.raw, ctx.dependencies);
    if (operator === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    if (!ctx.dependencies.linearRequestBudget)
      return context.json({ error: "linear_request_budget_unavailable" }, 503);
    return context.json(LinearRequestBudgetReportSchema.parse(ctx.dependencies.linearRequestBudget.report()));
  });

  ctx.app.on(["GET", "PUT"], "/v1/linear/wake", async (context) => {
    const operator = await authenticateOperator(context.req.raw, ctx.dependencies);
    if (operator === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (operator === undefined) return context.json({ error: "operator_authentication_required" }, 401);
    let current;
    if (context.req.method === "PUT") {
      const parsed = LinearWakeSettingsSchema.safeParse(await readJson(context.req.raw));
      if (!parsed.success) return context.json({ error: "malformed" }, 400);
      if (!ctx.settingsSource.update) return context.json({ error: "settings_unavailable" }, 503);
      current = await ctx.settingsSource.update((value) => ({
        ...value,
        linearWebhook: { ...value.linearWebhook, wake: parsed.data },
      }));
    } else current = await ctx.settingsSource.load();
    return context.json({ schemaVersion: 1, wake: current.linearWebhook.wake });
  });

  ctx.app.on(["GET", "PUT"], "/v1/linear/target", async (context) => {
    const operator = await authenticateOperator(context.req.raw, ctx.dependencies);
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
      if (!ctx.dependencies.captain.linearWakeTargetAllowed(input.data.conversationId))
        return context.json({ error: "linear_wake_target_unavailable" }, 409);
      if (!ctx.settingsSource.update) return context.json({ error: "settings_unavailable" }, 503);
      current = await ctx.settingsSource.update((value) => ({
        ...value,
        linearWebhook: { ...value.linearWebhook, wakeConversationId: input.data.conversationId },
      }));
    } else current = await ctx.settingsSource.load();
    return context.json({ schemaVersion: 1, wakeConversationId: current.linearWebhook.wakeConversationId });
  });

  // Local operator control, independent of the publicly reachable signed webhook.
  ctx.app.on(["GET", "PUT"], "/v1/linear/follow", async (context) => {
    const operator = await authenticateOperator(context.req.raw, ctx.dependencies);
    if (operator === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (operator === undefined) return context.json({ error: "operator_authentication_required" }, 401);
    const secret = await ctx.dependencies.linearWebhook?.secret();
    const secretPresent = secret !== undefined && secret.trim().length > 0;
    let current;
    if (context.req.method === "PUT") {
      const body = await readJson(context.req.raw);
      if (
        body === null ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        !("following" in body) ||
        typeof body.following !== "boolean"
      ) {
        return context.json({ error: "malformed" }, 400);
      }
      if (ctx.settingsSource.update === undefined)
        return context.json({ error: "settings_unavailable" }, 503);
      const following = body.following;
      let refused = false;
      current = await ctx.settingsSource.update((value) => {
        if (following && !linearFollowStatus(value.linearWebhook, secretPresent).webhookConfigured) {
          refused = true;
          return value;
        }
        return { ...value, linearWebhook: { ...value.linearWebhook, following } };
      });
      if (refused)
        return context.json(
          { error: "linear_webhook_required", ...linearFollowStatus(current.linearWebhook, secretPresent) },
          409,
        );
    } else {
      current = await ctx.settingsSource.load();
    }
    return context.json({
      schemaVersion: 1 as const,
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
    if (outcome.kind === "ignored") {
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
    const ownActor =
      own !== undefined && own.workspaceId === activity.organizationId && own.userId === activity.actorId;
    const ownWorker = activity.worker !== undefined;
    const types = linearActivityWakeTypes(activity);
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
    const targetAllowed = ctx.dependencies.captain.linearWakeTargetAllowed(
      current.linearWebhook.wakeConversationId,
    );
    const following =
      current.linearWebhook.following &&
      !identityUnavailable &&
      !workspaceMismatch &&
      !ownActor &&
      !ownWorker &&
      matches;
    const ingested =
      targetAllowed &&
      ctx.dependencies.captain.receiveLinearActivity(
        activity,
        following,
        current.linearWebhook.wakeConversationId,
      );
    logger.info(
      {
        event: "linear.webhook",
        eventId: activity.eventId,
        deliveryId: activity.deliveryId,
        type: activity.type,
        action: activity.action,
        issueId: activity.issueId,
        target: current.linearWebhook.wakeConversationId,
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
