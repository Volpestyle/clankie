import type { HerdrBinding } from "@clankie/protocol";
import type { SeatRef } from "@clankie/agent-hosts";
import {
  createPreparedNativeHost,
  type PreparedNativeHostOptions,
  type PreparedNativeRoot,
} from "./prepared-native-host.ts";
import type { GrokNativeController } from "./grok-native-controller.ts";

const descriptor = (value: string) => ({ source: "herdr:grok" as const, kind: "id" as const, value });
/** Trusted initial-argv allocations only. Disk records cannot adopt arbitrary Grok leaders. */
export function createGrokNativeHost(options: Omit<PreparedNativeHostOptions, "harness">) {
  const host = createPreparedNativeHost({ ...options, harness: "grok" });
  const seats = new Map<string, { ref: SeatRef; root: PreparedNativeRoot; native: GrokNativeController }>();
  return {
    createCommandTab: host.createCommandTab,
    capture: host.capture,
    register(ref: SeatRef, root: PreparedNativeRoot, native: GrokNativeController) {
      const entry = { ref, root, native };
      seats.set(ref.paneId, entry);
      return () => {
        if (seats.get(ref.paneId) === entry) seats.delete(ref.paneId);
      };
    },
    async allows(chain: readonly number[], pane: string, binding: HerdrBinding, occupant?: string) {
      const entry = seats.get(pane);
      if (!entry || !chain.includes(entry.native.leaderPid)) return false;
      try {
        await entry.native.verifyLeader();
        const proof = await entry.root.proof(descriptor(entry.ref.sessionId));
        return (
          seats.get(pane) === entry &&
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
export type GrokNativeHost = ReturnType<typeof createGrokNativeHost>;
