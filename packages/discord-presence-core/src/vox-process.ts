import {
  createVoxClient,
  resolveVoxBin,
  voxBuildStaleHint,
  VOX_IPC_PROTOCOL_VERSION,
  type VoxClient,
  type VoxProcessStatus,
} from "@clankie/vox-client";

const VOX_PROCESS_READY_TIMEOUT_MS = 5_000;

type VoxClientFactory = (options?: Parameters<typeof createVoxClient>[0]) => VoxClient;

export interface VoxProcessProbeResult {
  readonly binaryResolved: boolean;
  readonly binaryDetail: string;
  readonly processReady: boolean;
  readonly processDetail: string;
}

export async function startOfficialBotVox(options: {
  readonly enabled: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly createClient?: VoxClientFactory;
  readonly timeoutMs?: number;
  readonly onError?: (message: string) => void;
  readonly onLog?: (message: string) => void;
}): Promise<VoxClient | undefined> {
  if (!options.enabled) return undefined;
  const vox = (options.createClient ?? createVoxClient)({
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    ...(options.onLog === undefined ? {} : { onLog: options.onLog }),
  });
  try {
    await waitForVoxProcessReady(vox, options.timeoutMs);
    return vox;
  } catch (error) {
    vox.close();
    throw new Error(
      `Discord voice requires the Vox media process: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function probeVoxProcess(
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly createClient?: VoxClientFactory;
    readonly timeoutMs?: number;
  } = {},
): Promise<VoxProcessProbeResult> {
  const env = options.env ?? process.env;
  const bin = resolveVoxBin(env);
  if (bin === undefined) {
    return {
      binaryResolved: false,
      binaryDetail: "Vox binary was not found",
      processReady: false,
      processDetail: "process smoke was not attempted because the Vox binary is missing",
    };
  }
  const vox = (options.createClient ?? createVoxClient)({ bin, env });
  // Readiness runs before voice is asked for anything, so a stale build is
  // worth reporting here even when the smoke below still passes.
  const stale = voxBuildStaleHint(bin);
  const binaryDetail =
    stale === undefined ? "owned Vox binary resolved" : `owned Vox binary resolved, but ${stale}`;
  try {
    await waitForVoxProcessReady(vox, options.timeoutMs);
    return {
      binaryResolved: true,
      binaryDetail,
      processReady: true,
      processDetail: `Vox emitted process_ready protocol ${String(VOX_IPC_PROTOCOL_VERSION)}`,
    };
  } catch (error) {
    return {
      binaryResolved: true,
      binaryDetail,
      processReady: false,
      processDetail: error instanceof Error ? error.message : "Vox process smoke failed",
    };
  } finally {
    vox.close();
  }
}

export function waitForVoxProcessReady(
  vox: VoxClient,
  timeoutMs = VOX_PROCESS_READY_TIMEOUT_MS,
): Promise<void> {
  if (isTerminalStatus(vox.status)) return Promise.reject(new Error(vox.detail));

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let unsubscribeEvent: (() => void) | undefined;
    let unsubscribeStatus: (() => void) | undefined;
    const timer = setTimeout(
      () => settle(new Error("Vox did not emit a versioned process_ready before the timeout")),
      timeoutMs,
    );
    timer.unref?.();
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribeEvent?.();
      unsubscribeStatus?.();
      if (error === undefined) resolve();
      else reject(error);
    };
    unsubscribeEvent = vox.onEvent((event) => {
      if (event.type !== "process_ready") return;
      if (event.protocolVersion !== VOX_IPC_PROTOCOL_VERSION) {
        settle(
          new Error(
            `Vox IPC protocol mismatch: client=${String(VOX_IPC_PROTOCOL_VERSION)} binary=${String(event.protocolVersion)}`,
          ),
        );
        return;
      }
      settle();
    });
    if (settled) unsubscribeEvent();
    unsubscribeStatus = vox.onStatus((status, detail) => {
      if (isTerminalStatus(status)) settle(new Error(detail));
    });
    if (settled) unsubscribeStatus();
  });
}

function isTerminalStatus(status: VoxProcessStatus): boolean {
  return status === "missing" || status === "error" || status === "closed";
}
