import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  OPERATOR_REVIEWS_PATH,
  OPERATOR_REVIEW_LANDING_PATH,
  OPERATOR_REVIEW_WAIVERS_PATH,
  REVIEW_PATCH_MAX_BYTES,
  ReviewLandingQuerySchema,
  ReviewWaiverInputSchema,
} from "@clankie/protocol/reviews";
import type { ReviewGate, ReviewRefusal } from "./captain/review-gate.ts";

/** HTTP status for each refusal; the body always names the refusal and why. */
export function reviewRefusalStatus(refusal: ReviewRefusal): 400 | 403 | 404 | 409 | 503 {
  switch (refusal.error) {
    case "native_seat_required":
    case "not_reviewer":
      return 403;
    case "unknown_candidate":
      return 404;
    case "store_unavailable":
      return 503;
    case "invalid_patch":
      return 400;
    default:
      return 409;
  }
}

/**
 * The owner's view of the review gate (ADR 0287): candidates, the landing
 * gate's question, and the owner's waiver. Authors and reviewers use the
 * native seat routes instead; an operator bearer never records a verdict.
 */
export function createReviewRoutes(
  reviews: ReviewGate | undefined,
  authorize: (request: Request) => Promise<true | "authentication_required" | "forbidden">,
): Hono {
  const app = new Hono();
  const denied = async (request: Request) => {
    const result = await authorize(request);
    return result === true ? undefined : result;
  };
  app.get(OPERATOR_REVIEW_LANDING_PATH, async (context) => {
    context.header("cache-control", "no-store");
    const refusal = await denied(context.req.raw);
    if (refusal) return context.json({ error: refusal }, refusal === "forbidden" ? 403 : 401);
    if (!reviews) return context.json({ error: "reviews_unavailable" }, 503);
    const query = ReviewLandingQuerySchema.safeParse(context.req.query());
    if (!query.success) return context.json({ error: "invalid_query" }, 400);
    return context.json(await reviews.landing(query.data.directory, query.data.patchId));
  });
  app.get(OPERATOR_REVIEWS_PATH, async (context) => {
    context.header("cache-control", "no-store");
    const refusal = await denied(context.req.raw);
    if (refusal) return context.json({ error: refusal }, refusal === "forbidden" ? 403 : 401);
    if (!reviews) return context.json({ error: "reviews_unavailable" }, 503);
    const project = z.string().min(1).max(64).optional().safeParse(context.req.query("project"));
    if (!project.success) return context.json({ error: "invalid_query" }, 400);
    return context.json({ schemaVersion: 1, candidates: reviews.list(project.data).slice(0, 500) });
  });
  app.get(`${OPERATOR_REVIEWS_PATH}/:id`, async (context) => {
    context.header("cache-control", "no-store");
    const refusal = await denied(context.req.raw);
    if (refusal) return context.json({ error: refusal }, refusal === "forbidden" ? 403 : 401);
    if (!reviews) return context.json({ error: "reviews_unavailable" }, 503);
    const id = z.string().uuid().safeParse(context.req.param("id"));
    const candidate = id.success ? reviews.get(id.data) : undefined;
    if (!candidate) return context.json({ error: "unknown_candidate" }, 404);
    const patch = context.req.query("patch") === "true" ? reviews.patch(candidate.id) : undefined;
    return context.json({ schemaVersion: 1, candidate, ...(patch === undefined ? {} : { patch }) });
  });
  app.post(
    OPERATOR_REVIEW_WAIVERS_PATH,
    bodyLimit({ maxSize: Math.ceil(REVIEW_PATCH_MAX_BYTES / 3) * 4 + 64 * 1024 }),
    async (context) => {
      const refusal = await denied(context.req.raw);
      if (refusal) return context.json({ error: refusal }, refusal === "forbidden" ? 403 : 401);
      if (!reviews) return context.json({ error: "reviews_unavailable" }, 503);
      // allow-swallowed-rejection -- A malformed body is refused below as an invalid waiver.
      const input = ReviewWaiverInputSchema.safeParse(await context.req.json().catch(() => undefined));
      if (!input.success) return context.json({ error: "invalid_waiver" }, 400);
      const result = await reviews.waive(input.data, { actor: "owner" });
      return "error" in result
        ? context.json(result, reviewRefusalStatus(result))
        : context.json({ schemaVersion: 1, candidate: result });
    },
  );
  return app;
}
