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
}
export function inspectLiveHarnessBridges(options: {
  socket: string;
  panes: readonly HarnessBridgePane[];
  run(command: string, args: string[]): Promise<string>;
  platform?: string;
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
