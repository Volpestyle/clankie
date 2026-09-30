import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { AgentHostConnectionSchema } from "@clankie/settings";
import { AgentSessionRequestError } from "@clankie/agent-transcript";
import type { AgentSessions } from "./agent-sessions.ts";

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Operator-only access to independent native transcripts. */
export function createAgentSessionRoutes(
  sessions: AgentSessions | undefined,
  authenticate: (request: Request) => Promise<boolean | "unavailable">,
): Hono {
  const app = new Hono();
  const authorize = async (context: Context) => {
    const operator = await authenticate(context.req.raw);
    if (operator === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    if (!sessions) return context.json({ error: "agent_sessions_unavailable" }, 503);
    return undefined;
  };
  app.get("/v1/agent-hosts", async (context) => {
    const refused = await authorize(context);
    if (refused) return refused;
    return context.json({ hosts: await sessions!.hosts() });
  });

  app.post("/v1/agent-hosts", bodyLimit({ maxSize: 4 * 1024 }), async (context) => {
    const refused = await authorize(context);
    if (refused) return refused;
    const input = AgentHostConnectionSchema.safeParse(await context.req.json().catch(() => undefined));
    if (!input.success) return context.json({ error: "invalid_agent_host" }, 400);
    return context.json({ hosts: await sessions!.addHost(input.data) });
  });

  app.delete("/v1/agent-hosts/:id", async (context) => {
    const refused = await authorize(context);
    if (refused) return refused;
    try {
      return context.json({ hosts: await sessions!.removeHost(context.req.param("id")) });
    } catch (error) {
      return context.json(
        { error: "unknown_agent_host", detail: errorDetail(error) },
        error instanceof AgentSessionRequestError ? error.status : 409,
      );
    }
  });

  app.get("/v1/agent-sessions", async (context) => {
    const refused = await authorize(context);
    if (refused) return refused;
    const host = context.req.query("host");
    const limit = context.req.query("limit");
    try {
      return context.json(
        await sessions!.list({
          ...(host ? { host } : {}),
          ...(limit ? { limit: Number(limit) } : {}),
        }),
      );
    } catch (error) {
      return context.json(
        { error: "agent_sessions_failed", detail: errorDetail(error) },
        error instanceof AgentSessionRequestError ? error.status : 502,
      );
    }
  });

  app.get("/v1/agent-sessions/read", async (context) => {
    const refused = await authorize(context);
    if (refused) return refused;
    const ref = context.req.query("ref");
    if (!ref) return context.json({ error: "agent_session_ref_required" }, 400);
    const tail = context.req.query("tail");
    const after = context.req.query("after");
    try {
      return context.json(
        await sessions!.read(ref, {
          ...(tail ? { tail: Number(tail) } : {}),
          ...(after ? { after } : {}),
        }),
      );
    } catch (error) {
      return context.json(
        { error: "agent_session_read_failed", detail: errorDetail(error) },
        error instanceof AgentSessionRequestError ? error.status : 502,
      );
    }
  });

  return app;
}
