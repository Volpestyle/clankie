import { createInterface } from "node:readline/promises";
import type { BrowserCommandOptions } from "./browser.ts";
import { outputJson, type Writable } from "./io.ts";
import { parseUpdateArgs, runUpdateCommand, UPDATE_USAGE } from "./update.ts";
import type { RuntimeCanaryResult, RuntimeUpdateResult } from "../../bin/runtime-update.ts";
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
  latest?: RuntimeUpdateResult;
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
// oxlint-disable-next-line no-control-regex -- terminal output must strip every C0/C1 control
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
const phases: Record<string, string> = {
  scheduled: "Scheduled; waiting for the helper to start",
  installing: "Preparing the update; live runtime has not been replaced",
  stopping: "Draining and stopping the old runtime",
  activating: "Switching to the prepared runtime",
  restarting: "Starting the replacement and checking health",
  healthy: "Replacement is healthy",
  refused: "Update refused before cutover; live runtime was not replaced",
  failed: "Update failed",
  "rolled-back": "Update failed; previous runtime restored and healthy",
  "stop-unconfirmed": "Could not confirm that services stopped",
};
const reasons: Record<string, string> = {
  "pre-cutover-failed": "Preparation failed before cutover; live runtime was not replaced",
  "old-services-stop-unconfirmed": "Could not confirm the old runtime stopped",
  "new-services-stop-unconfirmed": "Could not confirm the replacement stopped before rollback",
  "cutover-failed": "Update failed during cutover",
  "rollback-unconfirmed": "Could not confirm that rollback completed safely",
  "pinned-runtime-changed": "The live runtime changed before preparation",
  "resolved-commit-changed": "The target commit changed before preparation",
  "runtime-changed-during-install": "The runtime changed during preparation",
  "target-update-status-unsupported": "The target does not support durable update status",
  "target-runtime-canary-unsupported": "The target does not support the runtime canary",
  "harness-refresh-incomplete": "Runtime is healthy, but some harness tools could not be refreshed",
};
const errors: Record<string, string> = {
  update_refused: "The update request was not admitted",
  update_status_unavailable: "Could not read update status. Reconnect and run clankie update status.",
  update_response_unreadable: "Could not read the update response.",
  update_record_unreadable:
    "Could not read the saved update record. Keep the original operation for reconciliation.",
  service_shutting_down:
    "The old runtime is draining. A brief disconnect is expected; reconnect and run clankie update status.",
};
function updateNextStep(view: View): string[] {
  const latest = view.latest;
  if (view.pending && view.pending !== latest?.id)
    return ["The original update is still pending. Run clankie update status; do not resend it."];
  if (
    view.needsReconciliation ||
    (latest &&
      ["failed", "stop-unconfirmed"].includes(latest.phase) &&
      latest.reason !== "pre-cutover-failed" &&
      !latest.reconciled)
  )
    return [
      "Result is uncertain. Keep the original operation and lock for reconciliation. Reconnect and run clankie update status; do not resend the update or restart services.",
    ];
  if (latest?.reconciled)
    return [
      `The running service confirmed this operation safe at ${clean(latest.reconciled.at)} (${short(latest.reconciled.commit)}). Another clankie update is allowed, subject to holds.`,
    ];
  if (latest?.phase === "failed" && latest.reason === "pre-cutover-failed")
    return [
      "Run clankie update to retry, subject to holds. The next update safely retires any retained lock for this failed operation.",
    ];
  if (latest?.phase === "scheduled")
    return [
      "Finish the initiating turn and run clankie update status. An unstarted helper fails after ten minutes when startup or a later update checks it; status alone does not retire it.",
    ];
  if (latest && ["stopping", "activating", "restarting"].includes(latest.phase))
    return [
      "A brief disconnect is expected during the drain and replacement. Let it finish, reconnect and run clankie update status; do not resend the update.",
    ];
  if (latest?.phase === "installing")
    return ["Let preparation finish, then run clankie update status; do not submit another update."];
  if (latest && ["refused", "rolled-back"].includes(latest.phase))
    return ["Review the cause, then run clankie update with a supported target to retry, subject to holds."];
  if (latest?.phase === "healthy") {
    const canary = latest.canary;
    if (
      !canary ||
      (canary.state === "passed" && canary.holdReleased === true) ||
      (canary.state === "failed" && canary.holdEstablished === true)
    )
      return ["Canary observation is complete. Another clankie update is allowed, subject to holds."];
    return [
      "Canary observation is still settling. Run clankie update status; do not submit another update yet.",
    ];
  }
  if (view.pending)
    return ["The original update is still pending. Run clankie update status; do not resend it."];
  return [];
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
  if (view.latest) {
    const latest = view.latest;
    lines.push(
      `Last update: ${short(latest.newCommit)} — ${phases[latest.phase] ?? "Unrecognized saved update state"} (${clean(latest.id)})`,
    );
    if (latest.reason) lines.push(`Cause: ${reasons[latest.reason] ?? clean(latest.reason)}`);
    if (latest.error) lines.push(`Failure detail: ${clean(latest.error)}`);
    if (latest.rollbackError) lines.push(`Rollback detail: ${clean(latest.rollbackError)}`);
  }
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
    lines.push("Further updates are held. Review these holds before admitting another update.");
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
  else if (view.accepted && !view.needsReconciliation)
    lines.push(
      "Update accepted. Finish this turn, then run clankie update status to check health and canary.",
    );
  if (view.error && !(groups.size && view.error === "update_refused"))
    lines.push(
      `Update unavailable: ${errors[view.error] ?? clean(view.error)}${view.detail ? ` (${clean(view.detail)})` : ""}`,
    );
  lines.push(...updateNextStep(view));
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
    const view = result as View;
    return view.error || (view.accepted === false && !view.upToDate) ? 1 : 0;
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
