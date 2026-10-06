import { createInterface } from "node:readline/promises";
import type { BrowserCommandOptions } from "./browser.ts";
import { outputJson, type Writable } from "./io.ts";
import { parseUpdateArgs, runUpdateCommand, UPDATE_USAGE } from "./update.ts";
import type { RuntimeCanaryResult } from "../../bin/runtime-update.ts";
import type { DeployHold } from "@clankie/protocol/integrate";

type Hold = DeployHold & { candidate?: string; canary?: RuntimeCanaryResult };
type CpuComparison = {
  cpuMeanPercent?: number;
  advisoryPercent: number;
  previous?: { commit: string; cpuMeanPercent: number };
  ratioToPrevious?: number;
};
interface View {
  runtime?: { commit: string };
  target?: { newCommit: string; ref: string; commitCount: number; summary: string[]; warning?: string };
  latest?: { id: string; phase: string; newCommit: string; canary?: RuntimeCanaryResult };
  holds?: Hold[];
  canary?: RuntimeCanaryResult;
  policy?: RuntimeCanaryResult["policy"];
  canaryPolicy?: RuntimeCanaryResult["policy"];
  canaryCpu?: CpuComparison | null;
  cpu?: CpuComparison | null;
  accepted?: boolean;
  upToDate?: boolean;
  pending?: string;
  error?: string;
  detail?: string;
  needsReconciliation?: boolean;
  appliesTo?: string;
}
const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
const short = (sha: string) => sha.slice(0, 8);
const causes: Record<string, string> = {
  "runtime-canary-cpu-budget-exceeded": "historical CPU canary",
  "runtime-canary-latency-budget-exceeded": "health latency canary",
  "runtime-canary-health-unavailable": "canary could not verify runtime health",
  "runtime-canary-runtime-changed": "canary runtime changed during observation",
  "runtime-canary-sampling-gap": "canary sampling was interrupted",
  "runtime-canary-samples-incomplete": "canary has too few samples",
  "canary-pending": "canary observation still running",
};
const range = (values: Array<number | undefined>, unit: string) => {
  const numbers = values.filter((n): n is number => n !== undefined && Number.isFinite(n));
  if (!numbers.length) return `unavailable${unit}`;
  const low = Math.min(...numbers).toFixed(1),
    high = Math.max(...numbers).toFixed(1);
  return `${low === high ? low : `${low}–${high}`}${unit}`;
};
function measurements(canaries: RuntimeCanaryResult[]): string {
  const cpu = range(
    canaries.map((c) => c.cpuMeanPercent),
    "%",
  );
  const cpuAdvisory = range(
    canaries.map((c) => c.policy?.cpuPercent),
    "%",
  );
  const health = range(
    canaries.map((c) => c.healthP95Ms),
    " ms",
  );
  const fine = canaries.every(
    (c) => c.healthP95Ms !== undefined && c.policy && c.healthP95Ms <= c.policy.healthLatencyMs,
  );
  return `CPU mean ${cpu} vs ${cpuAdvisory} advisory; health p95 ${health}${fine ? ", fine" : ""}`;
}
export function formatUpdateOutput(input: unknown): string {
  const view = input as View;
  const lines: string[] = [];
  if (view.runtime) lines.push(`Live: ${short(view.runtime.commit)}`);
  if (view.target) {
    const t = view.target;
    lines.push(
      `Target: ${clean(t.ref)} ${short(t.newCommit)} (${t.commitCount} new commit${t.commitCount === 1 ? "" : "s"})`,
    );
    lines.push(...t.summary.map((s) => `  ${clean(s)}`));
    if (t.warning) lines.push(`Target warning: ${clean(t.warning)}`);
  }
  if (view.latest)
    lines.push(`Last update: ${short(view.latest.newCommit)} ${view.latest.phase} (${view.latest.id})`);
  const canary = view.canary ?? view.latest?.canary;
  if (canary) {
    lines.push(`Canary: ${canary.state}; ${measurements([canary])}`);
    if (canary.error) lines.push(`Cause: ${causes[canary.error] ?? clean(canary.error)}`);
    if (canary.previousHealthyCommit) lines.push(`Previous healthy: ${short(canary.previousHealthyCommit)}`);
  }
  const policy = view.policy ?? view.canaryPolicy;
  if (policy)
    lines.push(
      `Canary policy: ${policy.cpuPercent}% CPU advisory (one core; never holds), ${policy.healthLatencyMs} ms health p95 budget; ${policy.windowMs / 1000}s window, every ${policy.sampleIntervalMs / 1000}s`,
    );
  if (view.appliesTo === "next_canary") lines.push("Settings apply to the next canary.");
  const cpu = view.canaryCpu ?? view.cpu;
  if (cpu?.cpuMeanPercent !== undefined) {
    lines.push(
      `CPU advisory observation: ${cpu.cpuMeanPercent.toFixed(2)}% vs ${cpu.advisoryPercent}% advisory; CPU never holds deploys.`,
    );
    if (cpu.previous) {
      lines.push(
        `Previous CPU: ${cpu.previous.cpuMeanPercent.toFixed(2)}% (${short(cpu.previous.commit)})${cpu.ratioToPrevious === undefined ? "" : `; ${cpu.ratioToPrevious.toFixed(2)}× previous`}`,
      );
    }
  }
  const groups = new Map<string, Hold[]>();
  for (const hold of view.holds ?? []) {
    const cause =
      hold.canary?.error ??
      (hold.canary?.state === "pending" ? "canary-pending" : `${hold.holder}: ${hold.reason}`);
    groups.set(cause, [...(groups.get(cause) ?? []), hold]);
  }
  if (groups.size) {
    lines.push("Update held. Live runtime remains in place.");
    for (const [cause, holds] of groups) {
      const label = causes[cause] ?? clean(cause);
      const canaries = holds.flatMap((h) => (h.canary ? [h.canary] : []));
      lines.push(
        `${holds.length} ${label} hold${holds.length === 1 ? "" : "s"}${canaries.length ? `: ${measurements(canaries)}` : ""}`,
      );
      lines.push(`  Holds: ${holds.map((h) => h.id).join(", ")}`);
    }
    lines.push(
      'Review the holds, then as owner run: clankie update --override-holds --reason "why proceeding is safe"',
    );
    lines.push(
      "Each hold gets its own audited override and remains recorded. Historical holds require an explicit owner release.",
    );
  }
  if (view.upToDate) lines.push("Already running the requested official release. No update was scheduled.");
  else if (view.accepted)
    lines.push(
      "Update accepted. Finish this turn, then run clankie update status to check health and canary.",
    );
  else if (view.pending && !groups.size)
    lines.push(`Update still settling: ${view.pending}. Read clankie update status.`);
  if (view.error && !groups.size)
    lines.push(`Update unavailable: ${clean(view.error)}${view.detail ? ` (${clean(view.detail)})` : ""}`);
  if (view.needsReconciliation)
    lines.push("Result is uncertain. Read clankie update status; do not resend the update.");
  return lines.join("\n") || "No update observation available.";
}
export async function runUpdateCli(
  args: readonly string[],
  options: BrowserCommandOptions & {
    stdout?: Writable;
    input?: NodeJS.ReadableStream;
    isTTY?: boolean;
  },
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  if (args.includes("--help") || args.includes("-h")) {
    stdout.write(`${UPDATE_USAGE}\n`);
    return 0;
  }
  const json = args.includes("--json") || !(options.isTTY ?? (stdout as NodeJS.WriteStream).isTTY);
  const rest = args.filter((a) => a !== "--json");
  if (json || rest[0] === "canary") {
    const result = await runUpdateCommand(rest, options);
    if (json) outputJson(stdout, result);
    else stdout.write(`${formatUpdateOutput(result)}\n`);
    return (result as View).error ? 1 : 0;
  }
  const { status, ref } = parseUpdateArgs(rest);
  const preview = (await runUpdateCommand(["status"], { ...options, previewRef: ref })) as View;
  stdout.write(`${formatUpdateOutput(preview)}\n`);
  if (status) return preview.error ? 1 : 0;
  if (preview.error || preview.needsReconciliation) return 1;
  let updateArgs = rest;
  if (preview.holds?.length && !rest.includes("--override-holds") && !rest.includes("--override-hold")) {
    const input = options.input ?? process.stdin;
    if (!(input as NodeJS.ReadStream).isTTY) return 1;
    const prompt = createInterface({ input, output: stdout as NodeJS.WritableStream });
    try {
      const answer = await prompt.question(
        `Override ${preview.holds.length} holds and update as the authenticated owner? [y/N] `,
      );
      if (!/^y(?:es)?$/iu.test(answer.trim())) return 1;
      const reason = (await prompt.question("Reason for each audited override: ")).trim();
      if (!reason) {
        stdout.write("A reason is required. Update remains held.\n");
        return 1;
      }
      // Name exactly the reviewed holds. A newly acquired hold still blocks admission.
      updateArgs = [...rest, ...preview.holds.flatMap((h) => ["--override-hold", h.id]), "--reason", reason];
    } finally {
      prompt.close();
    }
  }
  const result = (await runUpdateCommand(updateArgs, options)) as View;
  stdout.write(`${formatUpdateOutput(result)}\n`);
  return result.error || (result.accepted === false && !result.upToDate) ? 1 : 0;
}
