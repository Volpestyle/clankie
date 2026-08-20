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
  let failure: unknown;
  const attempt = async (action: () => void | Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      failure ??= error;
    }
  };
  await attempt(input.stopIngress);
  await attempt(input.leaveVoice);
  await attempt(input.disposeVoiceSession);
  await attempt(input.disposeVoiceGateway);
  await attempt(input.closeVox);
  await attempt(input.destroyDiscord);
  await attempt(input.stopPresence);
  await attempt(input.recordStopped);
  if (failure !== undefined) throw failure;
}
