import { coalesceOnce, runShutdownSteps } from "@clankie/discord-presence-core";

export function createUserSessionShutdown(steps: {
  readonly quiesceCallbacks: () => void;
  readonly stopControls: () => void;
  readonly stopStreams: () => void;
  readonly disposeGatewayBridge: () => void;
  readonly leaveVoice: () => Promise<void>;
  readonly releaseVoiceMembership: () => void;
  readonly disposeVoice: () => Promise<void>;
  readonly closeVox: () => void;
  readonly closeGateway: () => void;
  readonly stopPresence: () => Promise<void>;
  readonly recordStopped: (signal: NodeJS.Signals) => Promise<void>;
}): (signal: NodeJS.Signals) => Promise<void> {
  return coalesceOnce(async (signal) => {
    await runShutdownSteps([
      steps.quiesceCallbacks,
      steps.stopControls,
      steps.stopStreams,
      steps.disposeGatewayBridge,
      steps.leaveVoice,
      steps.releaseVoiceMembership,
      steps.disposeVoice,
      steps.closeVox,
      steps.closeGateway,
      steps.stopPresence,
      () => steps.recordStopped(signal),
    ]);
  });
}
