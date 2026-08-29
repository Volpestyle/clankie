import { runShutdownSteps } from "@clankie/discord-presence-core";

export async function shutdownDiscordBridge(input: {
  readonly stopIngress: () => void | Promise<void>;
  readonly leaveVoice: () => Promise<void>;
  readonly disposeVoiceSession: () => Promise<void>;
  readonly disposeVoiceGateway: () => void;
  readonly closeVox: () => void;
  readonly destroyDiscord: () => void;
  readonly stopPresence: () => Promise<void>;
  readonly recordStopped: () => Promise<void>;
}): Promise<void> {
  await runShutdownSteps([
    input.stopIngress,
    input.leaveVoice,
    input.disposeVoiceSession,
    input.disposeVoiceGateway,
    input.closeVox,
    input.destroyDiscord,
    input.stopPresence,
    input.recordStopped,
  ]);
}
