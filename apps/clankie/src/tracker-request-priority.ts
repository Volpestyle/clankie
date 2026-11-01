import { AsyncLocalStorage } from "node:async_hooks";

// Whether a tracker request is someone waiting (interactive) or the service's
// own polling (background). Core paths mark it; the Linear extension's budget
// reads it (ADR 0328). The names keep the Linear budget's vocabulary.

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
/** The current request's priority and the accounts already admitted in it, for the budget. */
export function currentTrackerRequestContext():
  | { readonly value: LinearRequestPriority; readonly admitted?: Set<string> }
  | undefined {
  return priority.getStore();
}
