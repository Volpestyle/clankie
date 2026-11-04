import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  WORKER_ASK_ANSWER_PATH,
  WORKER_ASK_WITHDRAW_PATH,
  WORKER_ASKS_PATH,
  WorkerAskAnswerSchema,
  WorkerAskIdSchema,
  type WorkerAsk,
  type WorkerAskList,
} from "@clankie/protocol/worker-asks";
import type { WorkerAskService } from "./captain/worker-asks.ts";

const STATES = new Set<WorkerAsk["state"]>(["open", "answering", "answered", "withdrawn"]);

/**
 * Workers' structured asks over HTTP (#604), the one API the CLI, app and
 * connected leads share. Owner or Take Control authority, as huddles.
 */
export function createWorkerAskRoutes(
  authorize: (request: Request) => Promise<true | "authentication_required" | "forbidden">,
  asks: WorkerAskService | undefined,
): Hono {
  const app = new Hono();
  const stillAuthorized = (request: Request) => async () => {
    const authority = await authorize(request);
    if (authority !== true) throw new Error(authority);
  };
  const gate: MiddlewareHandler = async (context, next) => {
    context.header("cache-control", "no-store");
    const authority = await authorize(context.req.raw);
    if (authority !== true) return context.json({ error: authority }, authority === "forbidden" ? 403 : 401);
    if (!asks) return context.json({ error: "worker_asks_unavailable" }, 503);
    await next();
  };
  app.use(WORKER_ASKS_PATH, gate);
  app.use(WORKER_ASK_ANSWER_PATH, gate);
  app.use(WORKER_ASK_WITHDRAW_PATH, gate);
  app.get(WORKER_ASKS_PATH, (context) => {
    const state = context.req.query("state");
    if (state !== undefined && !STATES.has(state as WorkerAsk["state"]))
      return context.json({ error: "invalid_state" }, 400);
    const body: WorkerAskList = {
      schemaVersion: 1,
      asks: [...asks!.list(state === undefined ? undefined : { state: state as WorkerAsk["state"] })],
    };
    return context.json(body);
  });
  // Every result is a closed outcome the caller reads, refusals included; only a malformed request is 400.
  app.post(WORKER_ASK_ANSWER_PATH, bodyLimit({ maxSize: 8192 }), async (context) => {
    const askId = WorkerAskIdSchema.safeParse(context.req.param("askId"));
    // allow-swallowed-rejection -- an unparseable body is refused below as invalid_request.
    const answer = WorkerAskAnswerSchema.safeParse(await context.req.json().catch(() => undefined));
    if (!askId.success || !answer.success) return context.json({ error: "invalid_request" }, 400);
    // The caller's authority is read again at the send, not only at the door.
    const result = await asks!.answer(askId.data, answer.data, {
      authorized: stillAuthorized(context.req.raw),
    });
    return context.json(result);
  });
  app.post(WORKER_ASK_WITHDRAW_PATH, async (context) => {
    const askId = WorkerAskIdSchema.safeParse(context.req.param("askId"));
    if (!askId.success) return context.json({ error: "invalid_request" }, 400);
    // As with an answer, authority is read again at the write.
    const result = await asks!.withdraw(askId.data, { authorized: stillAuthorized(context.req.raw) });
    return context.json(result);
  });
  return app;
}
