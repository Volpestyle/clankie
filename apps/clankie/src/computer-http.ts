import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ComputerRequestSchema } from "@clankie/interactive-environment";
import type { BodyConversationIdentity } from "./body-lease-router.ts";
import type { ComputerBody } from "./computer-body.ts";

export function registerComputerRoutes(
  app: Hono,
  options: {
    body?: ComputerBody;
    identity(request: Request, conversationId: string): Promise<BodyConversationIdentity | undefined>;
  },
): void {
  app.post("/v1/computer", bodyLimit({ maxSize: 2 * 1024 * 1024 }), async (context) => {
    let raw: unknown;
    try {
      raw = await context.req.json();
    } catch {
      return context.json({ error: "invalid_computer_request" }, 400);
    }
    const parsed = ComputerRequestSchema.safeParse(raw);
    if (!parsed.success) return context.json({ error: "invalid_computer_request" }, 400);
    const identity = await options.identity(context.req.raw, parsed.data.conversationId);
    if (identity === undefined) return context.json({ error: "computer_authorization_required" }, 401);
    if (options.body === undefined) return context.json({ error: "computer_body_unavailable" }, 503);
    try {
      const result = await options.body.dispatch(identity, parsed.data.command);
      return context.json(result as Record<string, unknown>, 200, { "cache-control": "no-store" });
    } catch {
      // Never expose native logs, private snapshot IDs, or filesystem paths in an error.
      return context.json(
        {
          error: "computer_request_refused",
          retry: "observe_status; never replay input with a new requestId",
        },
        409,
      );
    }
  });
}
