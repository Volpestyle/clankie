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
const WARNING_RETRY_MS = 60_000;
interface WarningIncident {
  accepted: boolean;
  retryAt: number;
  retryTimer?: ReturnType<typeof setTimeout>;
}
interface AccountState {
  readonly accountId: string;
  readonly account?: Pick<ProviderAccount, "workspaceId" | "userId">;
  requests: number[];
  warning?: WarningIncident;
  warningInFlight?: boolean;
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
  private closed = false;
  private readonly clock: () => number;
  private readonly options: {
    readonly clock?: () => number;
    /** True means native admission, including an unresolved accepted receipt, not confirmed delivery. */
    readonly onAlert?: (account: LinearRequestBudgetAccount) => boolean | Promise<boolean>;
  };
  constructor(
    options: {
      readonly clock?: () => number;
      readonly onAlert?: (account: LinearRequestBudgetAccount) => boolean | Promise<boolean>;
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
    // Pending warnings must remain retryable even when no more provider calls can be admitted.
    this.warn(state, now, observation);
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
      accounts: [...this.accounts.values()].map((state) => {
        const observation = this.observe(state, now);
        this.warn(state, now, observation);
        return observation;
      }),
    };
  }

  close(): void {
    this.closed = true;
    for (const state of this.accounts.values()) this.clearWarningTimer(state.warning);
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
    if (utilization < 0.5) {
      this.clearWarningTimer(state.warning);
      delete state.warning;
    }
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

  private warn(state: AccountState, now: number, observation = this.observe(state, now)): void {
    const onAlert = this.options.onAlert;
    if (this.closed || !onAlert || observation.utilization < 0.5) return;
    const warning = (state.warning ??= { accepted: false, retryAt: now });
    if (warning.accepted || state.warningInFlight) return;
    if (now < warning.retryAt) {
      this.scheduleWarning(state, warning, now);
      return;
    }
    this.clearWarningTimer(warning);
    state.warningInFlight = true;
    // Diagnostic admission never delays or changes an admitted provider request.
    void (async () => {
      let accepted = false;
      try {
        accepted = (await onAlert(observation)) === true;
      } catch {
        /* Retain the incident when the native notification could not be admitted. */
      }
      state.warningInFlight = false;
      if (this.closed) return;
      const settledAt = this.clock();
      this.observe(state, settledAt);
      if (state.warning === warning) {
        warning.accepted = accepted;
        if (!accepted) {
          warning.retryAt = settledAt + WARNING_RETRY_MS;
          this.scheduleWarning(state, warning, settledAt);
        }
      } else {
        // A late result belongs only to its original threshold crossing. Serialize a
        // newer incident behind it, without letting that result latch the new warning.
        this.warn(state, settledAt);
      }
    })();
  }

  private scheduleWarning(state: AccountState, warning: WarningIncident, now: number): void {
    if (
      this.closed ||
      warning.accepted ||
      warning.retryTimer ||
      state.warningInFlight ||
      state.warning !== warning
    )
      return;
    // Retry without a provider request or doctor poll, and never keep a stopping service alive.
    warning.retryTimer = setTimeout(
      () => {
        delete warning.retryTimer;
        if (state.warning === warning) this.warn(state, this.clock());
      },
      Math.max(0, warning.retryAt - now),
    );
    warning.retryTimer.unref();
  }

  private clearWarningTimer(warning?: WarningIncident): void {
    if (!warning?.retryTimer) return;
    clearTimeout(warning.retryTimer);
    delete warning.retryTimer;
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
