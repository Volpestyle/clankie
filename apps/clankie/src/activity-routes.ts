import { timingSafeEqual } from "node:crypto";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { ActivityShareRequestError } from "@clankie/rendered-surface-client";
import { ActivityAdmissionError, type SelfHostedActivityAdmission } from "./activity-admission.ts";
import { ActivitySharingRequestSchema, type ActivitySharing } from "./activity-sharing.ts";
import { readJson } from "./app/http-auth.ts";
import { logger } from "./app/log.ts";
import type { ExtensionRoutes } from "./ports/routes.ts";

export interface ActivityRouteParts {
  /** Local owner-authorized projection of delivered artifacts; hosted launch/admission is separate. */
  readonly activitySharing?: ActivitySharing;
  /**
   * Self-hosted official Activity admission (VUH-2833). Only the local activity
   * server reaches it, presenting the broker-held activity producer bearer.
   */
  readonly activityAdmission?: {
    token(): Promise<string | undefined>;
    admit(input: unknown): Promise<SelfHostedActivityAdmission>;
  };
}

/** World's Activity admission and sharing routes (ADR 0328). */
export function activityRoutes(parts: ActivityRouteParts = {}): ExtensionRoutes {
  return {
    place: "body",
    register(app, host) {
      app.post("/v1/activity/admit", bodyLimit({ maxSize: 4 * 1024 }), async (context) => {
        const admission = parts.activityAdmission;
        if (admission === undefined) return context.json({ error: "activity_admission_unavailable" }, 503);
        const expected = await admission.token();
        const supplied = Buffer.from(context.req.header("authorization") ?? "");
        const wanted = Buffer.from(`Bearer ${expected ?? ""}`);
        if (
          expected === undefined ||
          supplied.byteLength !== wanted.byteLength ||
          !timingSafeEqual(supplied, wanted)
        )
          return context.json({ error: "activity_admission_unauthorized" }, 401);
        context.header("cache-control", "no-store");
        try {
          return context.json(await admission.admit(await readJson(context.req.raw)));
        } catch (error) {
          if (error instanceof ActivityAdmissionError)
            return context.json(
              { error: error.message, ...(error.detail ? { detail: error.detail } : {}) },
              error.status,
            );
          logger.warn({ phase: "activity_admission" }, "activity admission failed");
          return context.json({ error: "activity_admission_denied" }, 403);
        }
      });

      app.post("/v1/activity/shares", async (context) => {
        const identity = await host.operator(context.req.raw);
        if (identity === "unavailable")
          return context.json({ error: "operator_authentication_unavailable" }, 503);
        if (!identity) return context.json({ error: "operator_authentication_required" }, 401);
        if (parts.activitySharing === undefined)
          return context.json({ error: "activity_sharing_unavailable" }, 503);
        const parsed = ActivitySharingRequestSchema.safeParse(await readJson(context.req.raw));
        if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
        try {
          const result = await parts.activitySharing.request(parsed.data, async () => {
            const current = await host.operator(context.req.raw);
            return current !== "unavailable" && current?.operatorId === identity.operatorId;
          });
          context.header("cache-control", "no-store");
          return context.json(result);
        } catch (error) {
          if (error instanceof ActivityShareRequestError) {
            return context.json(
              {
                error: "activity_share_request_failed",
                outcome: error.outcome,
                operation: error.operation,
                ...(error.shareId === undefined ? {} : { shareId: error.shareId }),
                ...(error.generation === undefined ? {} : { generation: error.generation }),
              },
              error.outcome === "uncertain" ? 503 : 409,
            );
          }
          const name = error instanceof Error ? error.message : "";
          if (name === "operator_authentication_required") return context.json({ error: name }, 401);
          if (name === "activity_destination_refused") return context.json({ error: name }, 403);
          if (name === "activity_source_unavailable") return context.json({ error: name }, 404);
          if (name === "activity_share_generation_conflict") return context.json({ error: name }, 409);
          if (name === "activity_share_gone" || name === "activity_artifact_unavailable")
            return context.json({ error: name }, 404);
          if (name === "activity_share_capacity") return context.json({ error: name }, 409);
          if (name === "activity_share_busy") return context.json({ error: name }, 429);
          if (error instanceof z.ZodError) return context.json({ error: "invalid_activity_media" }, 400);
          logger.warn(
            { phase: "activity_share", action: parsed.data.action },
            "activity share request failed",
          );
          return context.json({ error: "activity_sharing_unavailable" }, 503);
        }
      });
    },
    close: () => parts.activitySharing?.close(),
  };
}
