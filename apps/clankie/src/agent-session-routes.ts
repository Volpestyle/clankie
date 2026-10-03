import type { Machines } from "./machines.ts";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { AgentHostConnectionSchema } from "@clankie/settings";
import { AgentSessionRequestError } from "@clankie/agent-transcript";
import type { AgentSessions } from "./agent-sessions.ts";
import type { HireSeat } from "./captain/port.ts";
import { z } from "zod";

const ResumeSchema = z
  .object({
    ref: z.string().trim().min(1).max(128),
    fleet: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,63}$/u)
      .optional(),
    brief: z
      .string()
      .min(1)
      .refine((text) => Buffer.byteLength(text) <= 32 * 1024 && !text.includes("\0"))
      .optional(),
  })
  .strict();

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Operator-only access to independent native transcripts. */
export function createAgentSessionRoutes(
  sessions: AgentSessions | undefined,
  authenticate: (request: Request) => Promise<boolean | "unavailable">,
  hire?: HireSeat,
  machines?: Machines,
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
  app.post("/v1/agent-sessions/resume", bodyLimit({ maxSize: 64 * 1024 }), async (context) => {
    const refused = await authorize(context);
    if (refused) return refused;
    const input = ResumeSchema.safeParse(await context.req.json().catch(() => undefined));
    if (!input.success) return context.json({ error: "invalid_agent_session_resume" }, 400);
    if (hire === undefined) return context.json({ error: "agent_session_hire_unavailable" }, 503);
    try {
      const session = await sessions!.resolve(input.data.ref);
      return context.json(
        await hire(
          {
            schemaVersion: 1,
            resume: session.ref,
            harness: session.file.harness,
            title: `Resume ${session.file.harness}`,
            workingDirectory: session.workingDirectory,
            ...(input.data.fleet === undefined ? {} : { fleet: input.data.fleet }),
          },
          input.data.brief,
        ),
      );
    } catch (error) {
      return context.json(
        { error: "agent_session_resume_failed", detail: errorDetail(error) },
        error instanceof AgentSessionRequestError ? error.status : 502,
      );
    }
  });
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
    if (machines) {
      await machines.add(input.data);
      return context.json({ hosts: await sessions!.hosts() });
    }
    return context.json({ hosts: await sessions!.addHost(input.data) });
  });

  app.delete("/v1/agent-hosts/:id", async (context) => {
    const refused = await authorize(context);
    if (refused) return refused;
    try {
      if (machines) {
        await machines.remove(context.req.param("id"));
        return context.json({ hosts: await sessions!.hosts() });
      }
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
