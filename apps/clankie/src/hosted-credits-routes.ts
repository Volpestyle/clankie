import { Hono } from "hono";
import { HOSTED_CREDITS_PATH, HostedCreditsSchema } from "@clankie/protocol/hosted-credits";
import type { HostedBodyClient } from "./hosted-body.ts";

/**
 * The owner's hosted AI credits (VUH-1403): the fleet's answer, relayed
 * unchanged. A self-hosted body has no hosted client and answers 404, which the
 * app reads as "hide the credits card".
 */
export function createHostedCreditsRoutes(
  credits: Pick<HostedBodyClient, "readCredits"> | undefined,
  authorize: (request: Request) => Promise<true | "authentication_required" | "forbidden">,
): Hono {
  const app = new Hono();
  // No request, answer or error logging: the balance is account data.
  app.get(HOSTED_CREDITS_PATH, async (context) => {
    context.header("cache-control", "no-store");
    try {
      const authority = await authorize(context.req.raw);
      if (authority !== true) return context.json({ error: authority }, authority === "forbidden" ? 403 : 401);
      if (credits === undefined) return context.json({ error: "not_hosted" }, 404);
      return context.json(HostedCreditsSchema.parse(await credits.readCredits()));
    } catch {
      return context.json({ error: "unavailable" }, 503);
    }
  });
  return app;
}
