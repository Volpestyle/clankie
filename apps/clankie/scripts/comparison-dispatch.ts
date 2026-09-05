/**
 * The one authenticated transport the comparison tooling speaks.
 *
 * Two consumers share it — `comparison-run.ts` (submit a turn) and
 * `comparison-await-job.ts` (watch a job to quiescence) — so the dispatch
 * envelope is shaped and parsed in exactly one place. Op shaping, result
 * matching and typing stay with `createOperatorConversationServiceClient` in
 * `@clankie/protocol`; this only carries a bearer and a deadline.
 *
 * The route is `/operator/v1/dispatch` but it authenticates the **captain**
 * credential, not the operator one: `app.ts` guards it with
 * `authenticateCaptain`, which `index.ts` backs with `CLANKIE_CAPTAIN_TOKEN`
 * and the Discord bridge identities. An operator bearer is refused there with
 * `captain_authentication_required`. The path name is misleading; the wiring is
 * not.
 */
import {
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  OperatorConversationServiceResultSchema,
  type OperatorConversationServiceDispatch,
  type OperatorConversationServiceRequest,
} from "@clankie/protocol";

export interface HttpDispatchInput {
  readonly base: string;
  /** The captain bearer. Read from the environment by callers; never logged. */
  readonly token: string;
  /** Absolute epoch ms. Every request is bounded by what is left of it. */
  readonly deadlineAt: number;
  /** Injected for tests: the real app's `request` is fetch-shaped. */
  readonly fetchImpl?: typeof fetch;
}

export function createHttpDispatch(input: HttpDispatchInput): OperatorConversationServiceDispatch {
  const fetchImpl = input.fetchImpl ?? fetch;
  return async (request: OperatorConversationServiceRequest) => {
    // Bound by the run's remaining time, never a fresh window past it: a
    // request started near the end must not outlive the job it belongs to.
    const remaining = input.deadlineAt - Date.now();
    if (remaining <= 0) throw new Error("deadline exceeded before dispatch");
    const response = await fetchImpl(new URL(OPERATOR_CONVERSATION_DISPATCH_PATH, input.base), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${input.token}` },
      body: JSON.stringify(request),
      redirect: "error",
      signal: AbortSignal.timeout(remaining),
    });
    if (!response.ok) throw new Error(`dispatch ${String(response.status)}: ${await response.text()}`);
    return OperatorConversationServiceResultSchema.parse(await response.json());
  };
}
