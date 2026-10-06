import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { ProviderAccount, ProviderCredential } from "@clankie/credential-broker";
import type {
  LinearRequestBudgetAccount,
  LinearRequestBudgetReport,
} from "@clankie/protocol/linear-request-budget";

export type LinearRequestPriority = "interactive" | "background";
const priority = new AsyncLocalStorage<{ value: LinearRequestPriority; admitted?: Set<string> }>();
export function withLinearRequestPriority<T>(value: LinearRequestPriority, call: () => T): T {
  return priority.run({ value }, call);
}
/** Start a fresh logical tool request, even inside a caller's polling scope. */
export function withLinearRequestInvocation<T>(value: LinearRequestPriority, call: () => T): T {
  return priority.run({ value, admitted: new Set() }, call);
}
/** The API adapter may serve several provider pages inside the host's one logical request. */
export function withinLinearRequestInvocation<T>(value: LinearRequestPriority, call: () => T): T {
  const context = priority.getStore();
  return context?.value === value && context.admitted ? call() : withLinearRequestInvocation(value, call);
}
export function currentLinearRequestPriority(fallback: LinearRequestPriority): LinearRequestPriority {
  return priority.getStore()?.value ?? fallback;
}
const WINDOW_MS = 3_600_000;
const LIMIT = 5_000;
const BACKGROUND_INTERVAL_MS = 60_000;
interface AccountState {
  readonly accountId: string;
  readonly account?: Pick<ProviderAccount, "workspaceId" | "userId">;
  requests: number[];
  warned: boolean;
  sequence: number;
  headerSequence: number;
  lastBackground?: number;
  provider?: { remaining: number; resetAt: number; limit: number };
}

export class LinearRequestBudgetRefused extends Error {
  readonly code = "linear_request_budget";
  readonly reason: "background_throttled" | "budget_exhausted";
  readonly retryAt: number;
  constructor(reason: "background_throttled" | "budget_exhausted", retryAt: number) {
    super(`Linear request budget ${reason}; retry after ${new Date(retryAt).toISOString()}`);
    this.reason = reason;
    this.retryAt = retryAt;
  }
}

/** One service-owned budget across API/MCP audiences; counts wire attempts, including failures. */
export class LinearRequestBudget {
  private readonly accounts = new Map<string, AccountState>();
  private readonly clock: () => number;
  private readonly options: {
    readonly clock?: () => number;
    readonly onAlert?: (account: LinearRequestBudgetAccount) => unknown;
  };
  constructor(
    options: {
      readonly clock?: () => number;
      readonly onAlert?: (account: LinearRequestBudgetAccount) => unknown;
    } = {},
  ) {
    this.options = options;
    this.clock = options.clock ?? Date.now;
  }

  async fetch(
    credential: ProviderCredential,
    request: typeof fetch,
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
    beforeDispatch?: () => void,
  ): Promise<Response> {
    init?.signal?.throwIfAborted();
    const state = this.state(credential);
    const now = this.clock();
    const observation = this.observe(state, now);
    const context = priority.getStore();
    const selectedPriority = context?.value ?? "interactive";
    if (observation.used >= observation.limit - 1) {
      throw new LinearRequestBudgetRefused("budget_exhausted", this.retryAt(state, now));
    }
    if (
      selectedPriority === "background" &&
      !context?.admitted?.has(state.accountId) &&
      observation.utilization >= 0.8 &&
      state.lastBackground !== undefined &&
      now < state.lastBackground + BACKGROUND_INTERVAL_MS
    ) {
      throw new LinearRequestBudgetRefused(
        "background_throttled",
        state.lastBackground + BACKGROUND_INTERVAL_MS,
      );
    }
    // Keep admission synchronous with the receipt fence. Refused calls have no wire effect.
    beforeDispatch?.();
    state.requests.push(now);
    const sequence = ++state.sequence;
    if (selectedPriority === "background" && !context?.admitted?.has(state.accountId)) {
      state.lastBackground = now;
      // An admitted read may finish pagination. Every page still obeys the hard cap.
      context?.admitted?.add(state.accountId);
    }
    if (state.provider) state.provider.remaining = Math.max(0, state.provider.remaining - 1);
    this.warn(state, now);
    const response = await request(input, init);
    const remaining = headerInteger(response.headers, "x-ratelimit-requests-remaining");
    const resetAt = headerInteger(response.headers, "x-ratelimit-requests-reset");
    const limit = headerInteger(response.headers, "x-ratelimit-requests-limit") ?? LIMIT;
    if (
      remaining !== undefined &&
      resetAt !== undefined &&
      resetAt > this.clock() &&
      limit > 0 &&
      sequence > state.headerSequence
    ) {
      const observedRemaining = Math.max(0, remaining - (state.sequence - sequence));
      state.provider = {
        remaining:
          state.provider?.resetAt === resetAt
            ? Math.min(state.provider.remaining, observedRemaining)
            : observedRemaining,
        resetAt,
        limit,
      };
      state.headerSequence = sequence;
    }
    this.warn(state, this.clock());
    return response;
  }

  report(): LinearRequestBudgetReport {
    const now = this.clock();
    return {
      schemaVersion: 1,
      windowMs: WINDOW_MS,
      observedAt: now,
      accounts: [...this.accounts.values()].map((state) => this.observe(state, now)),
    };
  }

  private state(credential: ProviderCredential): AccountState {
    const account = "account" in credential ? credential.account : undefined;
    // An unverified legacy credential still gets a bounded bucket, without exposing a token.
    const accountId = createHash("sha256")
      .update(
        JSON.stringify(
          account
            ? [account.workspaceId, account.userId]
            : [
                "unverified",
                credential.type === "oauth"
                  ? credential.access
                  : credential.type === "api"
                    ? credential.key
                    : credential.token,
              ],
        ),
      )
      .digest("hex")
      .slice(0, 24);
    let state = this.accounts.get(accountId);
    if (!state) {
      state = {
        accountId,
        ...(account ? { account: { workspaceId: account.workspaceId, userId: account.userId } } : {}),
        requests: [],
        warned: false,
        sequence: 0,
        headerSequence: 0,
      };
      this.accounts.set(accountId, state);
    }
    return state;
  }

  private observe(state: AccountState, now: number): LinearRequestBudgetAccount {
    const first = state.requests.findIndex((at) => at > now - WINDOW_MS);
    if (first === -1) state.requests = [];
    else if (first > 0) state.requests.splice(0, first);
    if (state.provider && state.provider.resetAt <= now) delete state.provider;
    const limit = Math.min(LIMIT, state.provider?.limit ?? LIMIT);
    const used = Math.max(
      state.requests.length,
      state.provider ? state.provider.limit - state.provider.remaining : 0,
    );
    const utilization = used / limit;
    if (utilization < 0.5) state.warned = false;
    return {
      accountId: state.accountId,
      ...state.account,
      requests: state.requests.length,
      limit,
      used,
      utilization,
      status:
        used >= limit - 1
          ? "limited"
          : utilization >= 0.8
            ? "throttled"
            : utilization >= 0.5
              ? "warning"
              : "normal",
      backgroundMinIntervalMs: utilization >= 0.8 ? BACKGROUND_INTERVAL_MS : 0,
      ...(utilization >= 0.8 &&
      state.lastBackground !== undefined &&
      state.lastBackground + BACKGROUND_INTERVAL_MS > now
        ? { backgroundRetryAt: state.lastBackground + BACKGROUND_INTERVAL_MS }
        : {}),
      ...(state.provider
        ? { requestsRemaining: state.provider.remaining, resetAt: state.provider.resetAt }
        : {}),
    };
  }

  private warn(state: AccountState, now: number) {
    const observation = this.observe(state, now);
    if (observation.utilization >= 0.5 && !state.warned) {
      state.warned = true;
      // Diagnostic delivery never changes whether an admitted provider request is sent.
      try {
        void Promise.resolve(this.options.onAlert?.(observation)).catch(() => undefined);
      } catch {
        /* observed in doctor */
      }
    }
  }

  private retryAt(state: AccountState, now: number) {
    return Math.max(
      state.requests[0] === undefined ? now : state.requests[0] + WINDOW_MS,
      state.provider && state.provider.remaining <= 1 ? state.provider.resetAt : now,
    );
  }
}

function headerInteger(headers: Headers, name: string): number | undefined {
  const value = headers.get(name);
  if (value === null || !/^\d+$/u.test(value)) return;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}
