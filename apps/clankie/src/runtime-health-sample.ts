import { get } from "node:http";
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

/** Local identity metadata only; never retain the rest of an HTTP response. */
export class RuntimeIdentityMismatch extends Error {
  constructor(
    check: string,
    field: keyof RuntimeBootIdentity,
    expected: string | number,
    actual: string | number,
  ) {
    super(check);
    // Keep diagnostics compatible with the existing 1024-character durable error field.
    const bounded = (value: string | number) => {
      const json = JSON.stringify(value);
      return json.length <= 350 ? json : `${json.slice(0, 330)}… (truncated)`;
    };
    this.diagnostic = `${check}: ${field} expected=${bounded(expected)} actual=${bounded(actual)}`;
  }
  readonly diagnostic: string;
}

export function runtimeIdentityMismatch(
  check: string,
  expected: RuntimeBootIdentity,
  actual: RuntimeBootIdentity,
): RuntimeIdentityMismatch | undefined {
  for (const field of ["root", "commit", "instanceId", "pid"] as const)
    if (expected[field] !== actual[field])
      return new RuntimeIdentityMismatch(check, field, expected[field], actual[field]);
  return undefined;
}

function healthEndpoint(healthUrl: string): URL {
  const url = new URL(healthUrl);
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
  return url;
}

/** Fresh, bounded local HTTP for both the deploy canary and sustained detector. */
export function requestRuntimeHealth(input: {
  readonly healthUrl: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<Buffer> {
  const url = healthEndpoint(input.healthUrl);
  // The detector waits up to twice its configurable 60-second health budget.
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 120_000)
    throw Error("Invalid runtime health probe timeout");
  return new Promise((resolve, reject) => {
    const request = get(
      url,
      {
        agent: false,
        signal: AbortSignal.any([
          ...(input.signal === undefined ? [] : [input.signal]),
          AbortSignal.timeout(input.timeoutMs),
        ]),
        headers: { accept: "application/json" },
      },
      (response) => {
        if (response.statusCode === undefined || response.statusCode < 200 || response.statusCode >= 300) {
          response.destroy();
          reject(
            Object.assign(Error("runtime-health-http-unhealthy"), {
              code: `HTTP_${response.statusCode ?? "UNKNOWN"}`,
            }),
          );
          return;
        }
        const body: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > 32_768) {
            response.destroy(Error("runtime-health-response-too-large"));
            return;
          }
          body.push(chunk);
        });
        response.once("error", reject);
        response.once("end", () => resolve(Buffer.concat(body)));
      },
    );
    request.once("error", reject);
  });
}

/** A canonical metadata-only signal for the canary and runtime CPU alert consumers. */
export function createRuntimeHealthSampler(input: {
  readonly healthUrl: string;
  readonly timeoutMs?: number;
}): (runtime: RuntimeBootIdentity) => Promise<RuntimeHealthSample> {
  const url = healthEndpoint(input.healthUrl);
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
    // An idle shared fetch socket can wait ~500ms before writing on affected
    // Node/Undici versions (#5600). A fresh native connection measures the
    // service, including TCP setup and the complete body, without pool delay.
    const body = await requestRuntimeHealth({ healthUrl: url.href, timeoutMs });
    const value = z
      .object({
        ok: z.literal(true),
        service: z.literal("clankie"),
        runtime: RuntimeHealthSampleSchema.shape.runtime,
      })
      .parse(JSON.parse(body.toString("utf8")));
    const mismatch = runtimeIdentityMismatch("runtime-health-boot-identity-mismatch", runtime, value.runtime);
    if (mismatch) throw mismatch;
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
