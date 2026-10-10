import type { HerdrBinding } from "@clankie/protocol";
import type { SeatRef } from "@clankie/agent-hosts";
import {
  createPreparedNativeHost,
  type PreparedNativeHostOptions,
  type PreparedNativeRoot,
} from "./prepared-native-host.ts";

export const primeDescriptor = (sessionId: string) => ({
  source: "herdr:prime" as const,
  kind: "id" as const,
  value: sessionId,
});

/**
 * A hired Prime Agent session runs in a daemon worker process outside the
 * pane's process tree, so its Clankie MCP server does too. This host admits
 * that server only while the exact worker of a session Clankie bound to the
 * pane is in the requesting process's ancestry.
 */
export interface PrimeBoundSeat {
  readonly ref: SeatRef;
  readonly root: PreparedNativeRoot;
  /** Fresh daemon observation of the session's worker PID; rejects when control is gone. */
  workerPid(): Promise<number>;
}

export function createPrimeNativeHost(options: Omit<PreparedNativeHostOptions, "harness">) {
  const host = createPreparedNativeHost({ ...options, harness: "prime" });
  const seats = new Map<string, PrimeBoundSeat>();
  return {
    createCommandTab: host.createCommandTab,
    capture: host.capture,
    register(seat: PrimeBoundSeat) {
      seats.set(seat.ref.paneId, seat);
      return () => {
        if (seats.get(seat.ref.paneId) === seat) seats.delete(seat.ref.paneId);
      };
    },
    /** Herdr cannot hold Prime session identity; restore it for panes Clankie bound. */
    session(paneId: string, terminalId: string) {
      const seat = seats.get(paneId);
      return seat !== undefined && seat.root.terminalId === terminalId
        ? primeDescriptor(seat.ref.sessionId)
        : undefined;
    },
    async allows(chain: readonly number[], pane: string, binding: HerdrBinding, occupant?: string) {
      const seat = seats.get(pane);
      if (!seat) return false;
      try {
        if (!chain.includes(await seat.workerPid())) return false;
        const proof = await seat.root.proof(primeDescriptor(seat.ref.sessionId));
        return (
          seats.get(pane) === seat &&
          proof.binding.socketPath === binding.socketPath &&
          proof.binding.session === binding.session &&
          (occupant === undefined || occupant === proof.nativeOccupantId)
        );
      } catch {
        return false;
      }
    },
  };
}
export type PrimeNativeHost = ReturnType<typeof createPrimeNativeHost>;
