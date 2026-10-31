import { type AgentSession } from "@earendil-works/pi-coding-agent";
import { WATCH_TURN_REFUSAL, type WatchGate } from "../watch.ts";

/**
 * Watch's last stop before a provider (ADR 0307). Choosing a model is refused
 * while watching, but a turn already running keeps its model across tool
 * results, retries and steered messages, and Pi compacts on its own. Every one
 * of those goes through the session's stream function, so this asks again
 * there before each request, and while watching the request is never sent.
 */
export function guardWatchedRequests(
  session: Pick<AgentSession, "agent">,
  watch: Pick<WatchGate, "refuse">,
): void {
  const send = session.agent.streamFunction;
  session.agent.streamFunction = async (model, context, options) => {
    await watch.refuse(WATCH_TURN_REFUSAL);
    return await send(model, context, options);
  };
}
