import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import type { RuntimeBootIdentity } from "../../../tui/bin/runtime-update.ts";
import { RuntimeHealthSampleSchema, type RuntimeHealthSample } from "../../src/runtime-health-sample.ts";

/** FIFO observations retain gaps in the sampled process, never receipt-time gaps. */
export async function updateWakeHealth(root: string, sampledPauseMs = 0) {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./update-wake-health-process.ts", import.meta.url)),
      root,
      String(sampledPauseMs),
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  let stderr = "";
  child.stderr!.on("data", (value: Buffer) => {
    stderr += value.toString();
  });
  let ready!: (runtime: RuntimeBootIdentity) => void;
  let rejectReady!: (error: Error) => void;
  const started = new Promise<RuntimeBootIdentity>((resolve, reject) => {
    ready = resolve;
    rejectReady = reject;
  });
  const queue: Array<{ at: number; reading?: RuntimeHealthSample; error?: string }> = [];
  const readings: RuntimeHealthSample[] = [];
  let notify: (() => void) | undefined;
  let failed: Error | undefined;
  let closing = false;
  let collecting = false;
  let origin: number | undefined;
  let clock = 0;
  const fail = (error: Error) => {
    failed = error;
    rejectReady(error);
    notify?.();
  };
  child.on("error", fail);
  child.on("exit", (code, signal) => {
    if (!closing) fail(Error(`Health fixture exited: ${code ?? signal}; ${stderr}`));
  });
  child.on("message", (value) => {
    const packet = value as {
      type: string;
      runtime: RuntimeBootIdentity;
      at: number;
      reading?: RuntimeHealthSample;
      error?: string;
    };
    if (packet.type === "ready") ready(packet.runtime);
    if (packet.type === "sample") {
      queue.push(packet);
      if (packet.reading) readings.push(RuntimeHealthSampleSchema.parse(packet.reading));
      notify?.();
    }
  });
  const close = async () => {
    closing = true;
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const kill = setTimeout(() => child.kill("SIGKILL"), 3000);
      try {
        await exited;
      } finally {
        clearTimeout(kill);
      }
    }
    if (failed) throw failed;
  };
  let runtime: RuntimeBootIdentity;
  try {
    runtime = await started;
  } catch (error) {
    await close();
    throw error;
  }
  return {
    runtime,
    readings,
    now: () => clock,
    sample: async () => {
      if (!collecting) {
        collecting = true;
        child.send("start");
      }
      while (!queue.length) {
        if (failed) throw failed;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        notify = undefined;
      }
      const packet = queue.shift()!;
      origin ??= packet.at;
      if (!Number.isFinite(packet.at) || packet.at - origin < clock)
        throw Error("Health sample clock regressed");
      clock = packet.at - origin;
      if (packet.error) throw Error(packet.error);
      return RuntimeHealthSampleSchema.parse(packet.reading);
    },
    close,
  };
}
