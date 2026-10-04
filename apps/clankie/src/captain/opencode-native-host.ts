import type { Socket } from "node:net";
import type { SeatProcessIdentity } from "@clankie/agent-hosts";
import {
  createPreparedNativeHost,
  type PreparedCommandTab,
  type PreparedNativeHostOptions,
  type PreparedNativeSession,
} from "./prepared-native-host.ts";

export type OpenCodeCommandTab = PreparedCommandTab;
export interface OpenCodeNativeRoot {
  readonly paneId: string;
  readonly terminalId: string;
  check(socket: Socket): Promise<boolean>;
  proof(sessionId: string): Promise<SeatProcessIdentity>;
  report(sessionId: string, state: "idle" | "working" | "blocked" | "unknown", name?: string): Promise<void>;
}

const descriptor = (value: string): PreparedNativeSession => ({
  source: "herdr:opencode",
  kind: "id",
  value,
});

/** OpenCode's controller keeps its exact native ID API; process observation is shared. */
export function createOpenCodeNativeHost(input: Omit<PreparedNativeHostOptions, "harness">) {
  const host = createPreparedNativeHost({ ...input, harness: "opencode" });
  return {
    createCommandTab: host.createCommandTab,
    async capture(paneId: string, executable: string, cwd: string): Promise<OpenCodeNativeRoot> {
      const root = await host.capture(paneId, executable, cwd);
      return {
        paneId: root.paneId,
        terminalId: root.terminalId,
        check: root.check,
        report: (id, state, name) => root.report(descriptor(id), state, name),
        proof: (id) => root.proof(descriptor(id)),
      };
    },
  };
}
