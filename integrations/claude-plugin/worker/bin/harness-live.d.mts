export interface HarnessBridgePane {
  paneId: string;
  harness: string;
}
export interface HarnessBridgeObservation extends HarnessBridgePane {
  status: "live-process" | "missing" | "pane-mismatch" | "unobserved";
  detail: string;
  remediation?: string;
  bridgePid?: number;
  claimedPane?: string;
  sharedDaemon?: boolean;
  freshness?: "older-than-runtime" | "current" | "unknown";
  bridgeStartedAt?: string;
  runtimeStartedAt?: string;
  operatorBridge?: Omit<HarnessBridgeObservation, keyof HarnessBridgePane | "operatorBridge">;
}
export function inspectLiveHarnessBridges(options: {
  socket: string;
  panes: readonly HarnessBridgePane[];
  run(command: string, args: string[]): Promise<string>;
  platform?: string;
  /** PID from this live service's existing runtime identity, never a pane claim. */
  runtimePid?: number;
}): Promise<{
  state: string;
  panes: readonly HarnessBridgeObservation[];
  unownedBridges: readonly {
    pid: number;
    claimedPane?: string;
    sharedDaemon: boolean;
    detail: string;
    remediation?: string;
  }[];
}>;
