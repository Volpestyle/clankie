import { type OperatorGoal } from "@clankie/protocol";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type AgentSession } from "@earendil-works/pi-coding-agent";
import { AutonomyStore } from "./autonomy.ts";

export const NATIVE_GOAL_UNSUPPORTED =
  "native_goal_unsupported: Service goals are unavailable in a native harness seat: continuations cannot reach this seat with enforced token accounting. Continue the task in this harness without create_goal, or use a Pi-owned conversation.";

/**
 * Charge each provider response before Pi can request another one. The native
 * request hook is used because extension hook exceptions are only diagnostics.
 * A single response can overshoot; subsequent requests and continuations cannot.
 */
export function enforceGoalBudget(
  session: AgentSession,
  autonomy: AutonomyStore,
  conversationId: string,
  goal: OperatorGoal,
  autonomous: boolean,
): () => void {
  const original = session.agent.prepareRequest;
  const originalStream = session.agent.streamFunction;
  // Cache refreshes use a separate runtime stream and are optional. Keep
  // goal spend on the guarded request path instead of refreshing in parallel.
  const warmingMode = session.settingsManager.getCacheWarmingMode();
  session.setCacheWarmingMode("off");
  let accountingRefusal: string | undefined;
  const check = (): void => {
    const current = autonomy.getGoal(conversationId);
    if (current !== goal) {
      throw new Error("goal_replaced");
    }
    if (accountingRefusal !== undefined) throw new Error(accountingRefusal);
    if (current.tokenBudget === undefined || current.tokensUsed >= current.tokenBudget)
      throw new Error("goal_budget_limited");
    if (current.status === "budget_limited" || current.status === "usage_limited")
      throw new Error(`goal_${current.status}`);
    if (autonomous && current.status === "paused") throw new Error("goal_paused");
  };
  const guarded: NonNullable<typeof original> = async (request, signal) => {
    check();
    const prepared = original === undefined ? undefined : await original(request, signal);
    check();
    return prepared ?? undefined;
  };
  session.agent.prepareRequest = guarded;
  const charge = (message: AssistantMessage): void => {
    const tokens = message.usage?.totalTokens;
    // Pi reports zero when a request fails or is cancelled before any usage.
    // Keep its retries and the owner's next prompt available in those cases.
    const unaccounted =
      typeof tokens !== "number" ||
      !Number.isSafeInteger(tokens) ||
      tokens < 0 ||
      (tokens === 0 && message.stopReason !== "error" && message.stopReason !== "aborted") ||
      !Number.isSafeInteger(goal.tokensUsed + tokens);
    if (unaccounted) accountingRefusal = "goal_usage_limited";
    const current = unaccounted
      ? autonomy.limitUsage(conversationId, goal)
      : autonomy.recordUsage(conversationId, tokens ?? 0, goal);
    if (
      current !== undefined &&
      (unaccounted ||
        current.tokenBudget === undefined ||
        current.tokensUsed >= current.tokenBudget ||
        current.status === "budget_limited" ||
        current.status === "usage_limited")
    ) {
      // abort() cancels synchronously before awaiting Pi's settlement. The
      // request guard also covers retries and later tools in this same run.
      void session.abort().catch(() => undefined);
    }
  };
  const guardedStream: typeof originalStream = async (model, context, options) => {
    check();
    const stream = await originalStream(model, context, options);
    // This includes compaction and summarization calls, which do not emit
    // ordinary assistant message events. Count each response once, including
    // failed retries, before the next request can pass the same guard.
    void stream
      .result()
      .then(charge)
      .catch(() => {
        accountingRefusal = "goal_usage_limited";
        try {
          autonomy.limitUsage(conversationId, goal);
        } catch {
          // The in-memory guard still closes when durable accounting fails.
        }
        void session.abort().catch(() => undefined);
      });
    return stream;
  };
  session.agent.streamFunction = guardedStream;
  return () => {
    if (session.agent.prepareRequest === guarded) {
      if (original === undefined) delete session.agent.prepareRequest;
      else session.agent.prepareRequest = original;
    }
    if (session.agent.streamFunction === guardedStream) session.agent.streamFunction = originalStream;
    session.setCacheWarmingMode(warmingMode);
  };
}
