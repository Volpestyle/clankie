import type { OperatorSeatBindings } from "../../src/operator-seat-bindings.ts";

/**
 * For tests about what a seat bridge does once admitted (receipts, restarts,
 * capabilities). It admits every caller, so it proves nothing about binding;
 * `operator-seat-binding-routes.integration.test.ts` covers the real refusals.
 */
export function permissiveSeatBindings(): OperatorSeatBindings {
  const ok = async () => ({ ok: true as const, role: "bridge" as const });
  return { admit: ok, register: ok, deregister: ok } as unknown as OperatorSeatBindings;
}
