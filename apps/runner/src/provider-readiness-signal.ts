import { isAbsolute } from "node:path";
import type { ProviderReadinessReport } from "./provider-factory.ts";
import { replacePrivateFileAtomically } from "./private-artifact.ts";

export const REQUIRED_NATIVE_CODING_WORKERS = [
  "codex-implementation",
  "claude-verification",
  "pi-debugging",
] as const;

export interface RunnerProviderReadinessSignal {
  schemaVersion: 1;
  nonce: string;
  runnerId: string;
  status: "ready" | "unavailable";
  workers: Array<{
    provider: string;
    workerId: string;
    status: ProviderReadinessReport["status"];
    issueCodes: string[];
  }>;
}

/** Publishes the provider factory's exact, content-free result for a nonce-bound launcher. */
export async function publishProviderReadinessSignal(input: {
  path: string;
  nonce: string;
  runnerId: string;
  reports: readonly ProviderReadinessReport[];
}): Promise<RunnerProviderReadinessSignal> {
  if (!isAbsolute(input.path)) throw new Error("runner_readiness_path_must_be_absolute");
  if (!/^[a-f0-9]{32,128}$/u.test(input.nonce)) throw new Error("runner_readiness_nonce_invalid");
  const workers = input.reports
    .map((report) => ({
      provider: report.provider,
      workerId: report.workerId,
      status: report.status,
      issueCodes: report.issues.map((issue) => issue.code).sort(),
    }))
    .sort((left, right) => left.workerId.localeCompare(right.workerId));
  const ready = new Set(
    workers.filter((worker) => worker.status === "ready").map((worker) => worker.workerId),
  );
  const signal: RunnerProviderReadinessSignal = {
    schemaVersion: 1,
    nonce: input.nonce,
    runnerId: input.runnerId,
    status: REQUIRED_NATIVE_CODING_WORKERS.every((workerId) => ready.has(workerId)) ? "ready" : "unavailable",
    workers,
  };
  await replacePrivateFileAtomically(input.path, `${JSON.stringify(signal, null, 2)}\n`);
  return signal;
}
