import type { HerdrBinding } from "@clankie/protocol";
import { NativePaneNotFoundError, nativeRequest } from "../herdr-native-request.ts";
import type { HerdrCoreSeats } from "./herdr-core-seats.ts";

/**
 * Whether a local native pane is positively gone (#376): Herdr answers that the pane does
 * not exist, or the desktop app's core has no such terminal or reports it finished. Any
 * other answer, a failed read, or another machine is false: absence is never inferred
 * from silence, so a pane that could not be read still counts as present.
 */
export function createNativePaneGone(options: {
  readonly binding: () => Promise<HerdrBinding | undefined>;
  readonly coreSeats: () => HerdrCoreSeats;
}): (fleet: string, pane: string) => Promise<boolean> {
  return async (fleet, pane) => {
    if (fleet !== "default") return false;
    try {
      const core = /^herdr-core\/(t[0-9a-z]+)$/u.exec(pane)?.[1];
      if (core !== undefined) {
        const terminal = await options.coreSeats().get(core);
        return terminal === undefined || terminal.state === "finished";
      }
      if (!/^w[\w]+:p[\w]+$/u.test(pane)) return false;
      const binding = await options.binding();
      if (!binding) return false;
      await nativeRequest(binding, "pane.process_info", { pane_id: pane }, { timeoutMs: 5_000 });
      return false;
    } catch (error) {
      return error instanceof NativePaneNotFoundError;
    }
  };
}
