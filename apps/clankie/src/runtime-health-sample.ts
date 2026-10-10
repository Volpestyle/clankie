import { performance } from "node:perf_hooks";
import { z } from "zod";
import type { RuntimeBootIdentity } from "../../tui/bin/runtime-update.ts";

/** Captain-process CPU: 100% means one CPU core. Health latency includes reading the response. */
export interface RuntimeHealthSample {
  readonly observedAt: string;
  readonly runtime: RuntimeBootIdentity;
  readonly cpuPercent: number;
  readonly intervalMs: number;
  readonly healthLatencyMs: number;
}

export const RuntimeHealthSampleSchema = z.strictObject({
  observedAt: z.iso.datetime(),
  runtime: z.strictObject({
    root: z.string().min(1).max(4096),
    commit: z.string().regex(/^[a-f0-9]{40,64}$/u),
    instanceId: z.uuid(),
    pid: z.number().int().min(2),
  }),
  cpuPercent: z.number().finite().nonnegative(),
  intervalMs: z.number().finite().positive(),
  healthLatencyMs: z.number().finite().nonnegative(),
});

/** A canonical metadata-only signal for the canary and runtime CPU alert consumers. */
export function createRuntimeHealthSampler(input: {
  readonly healthUrl: string;
  readonly timeoutMs?: number;
}): (runtime: RuntimeBootIdentity) => Promise<RuntimeHealthSample> {
  const url = new URL(input.healthUrl);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/health" ||
    url.search ||
    url.hash
  )
    throw Error("Runtime health sampler requires the local /health endpoint");
  const timeoutMs = input.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw Error("Invalid runtime health probe timeout");
  let previousCpu: NodeJS.CpuUsage | undefined;
  let previousAt: number | undefined;
  return async (runtime) => {
    if (runtime.pid !== process.pid) throw Error("runtime-health-cpu-identity-mismatch");
    previousCpu ??= process.cpuUsage();
    previousAt ??= performance.now();
    const probeAt = performance.now();
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw Error("runtime-health-http-unhealthy");
    const reader = response.body?.getReader();
    if (!reader) throw Error("runtime-health-response-empty");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 32_768) throw Error("runtime-health-response-too-large");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const value = z
      .object({
        ok: z.literal(true),
        service: z.literal("clankie"),
        runtime: RuntimeHealthSampleSchema.shape.runtime,
      })
      .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (
      value.runtime.root !== runtime.root ||
      value.runtime.commit !== runtime.commit ||
      value.runtime.instanceId !== runtime.instanceId ||
      value.runtime.pid !== runtime.pid
    )
      throw Error("runtime-health-boot-identity-mismatch");
    const at = performance.now();
    const cpu = process.cpuUsage();
    const intervalMs = at - previousAt;
    const cpuPercent =
      ((cpu.user - previousCpu.user + cpu.system - previousCpu.system) / (intervalMs * 1000)) * 100;
    previousCpu = cpu;
    previousAt = at;
    return RuntimeHealthSampleSchema.parse({
      observedAt: new Date().toISOString(),
      runtime: value.runtime,
      cpuPercent,
      intervalMs,
      healthLatencyMs: at - probeAt,
    });
  };
}
