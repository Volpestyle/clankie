/**
 * `/update` as a modal: show what is running and the last durable update,
 * then stage one only when the owner picks it. Same endpoint as `clankie update`.
 */
import type { ClankieFaceShell } from "./shell/shell.ts";

type Run = (args: readonly string[]) => Promise<unknown>;
type Json = Record<string, unknown>;
const record = (value: unknown): Json => (value !== null && typeof value === "object" ? (value as Json) : {});
const short = (value: unknown) => (typeof value === "string" ? value.slice(0, 8) : "?");
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `Running 0b9d486d · last update main 887e07f6 → cc9727b9 healthy`. */
export function formatUpdateState(state: unknown): string {
  const runtime = record(record(state).runtime);
  const latest = record(record(state).latest ?? record(state).operation);
  const running = `Running ${short(runtime.commit)}`;
  if (latest.phase === undefined) return `${running} · no update recorded`;
  const canary = record(latest.canary);
  const signal = canary.state === undefined ? "" : ` · canary ${String(canary.state)}`;
  const measured =
    typeof canary.cpuMeanPercent === "number" && typeof canary.healthP95Ms === "number"
      ? ` (${canary.cpuMeanPercent.toFixed(1)}% CPU, ${Math.round(canary.healthP95Ms)} ms health p95)`
      : "";
  const previous =
    canary.state === "failed" ? ` · previous healthy ${short(canary.previousHealthyCommit)}` : "";
  return `${running} · last update ${String(latest.ref ?? "main")} ${short(latest.oldCommit)} → ${short(latest.newCommit)} ${String(latest.phase)}${signal}${measured}${previous}`;
}

export async function runUpdateMenu(shell: ClankieFaceShell, update: Run): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin("update");
  try {
    const state = await update(["status"]);
    const latest = record(record(state).latest);
    const pending =
      record(state).pending !== undefined &&
      (latest.healthy !== true || record(latest.canary).state === "pending");
    const choice = await flow.readSelect({
      message: formatUpdateState(state),
      options: [
        {
          value: "main",
          label: "Update to latest main",
          hint: pending ? "an update is already in flight" : "installs, restarts, observes health",
        },
        { value: "ref", label: "Update to a ref…", hint: "branch, tag or commit" },
        {
          value: "canary",
          label: "Canary settings…",
          hint: "observation window, health budget, CPU advisory",
        },
        {
          value: "auto",
          label: "Automatic installs…",
          hint: "hosted bodies install official releases while idle",
        },
      ],
      allowBack: true,
    });
    if (choice === undefined) return;
    if (choice === "auto") {
      const enabled = record(await update(["auto"])).autoUpdate === true;
      const next = await flow.readSelect({
        message: `Automatic installs are ${enabled ? "on" : "off"}. Managed bodies always install their approved release.`,
        options: [
          { value: "on", label: "On", hint: "install official releases while idle" },
          { value: "off", label: "Off", hint: "install only when asked" },
        ],
        allowBack: true,
      });
      if (next === undefined) return;
      await update(["auto", next]);
      shell.insertCommandResult("/update", `Automatic installs ${next}.`, "success");
      return;
    }
    if (choice === "canary") {
      const policy = record(record(await update(["canary"])).policy);
      const fields = [
        { key: "windowMs", flag: "--window-seconds", scale: 1000, label: "Observation window (seconds)" },
        {
          key: "sampleIntervalMs",
          flag: "--sample-seconds",
          scale: 1000,
          label: "Sample interval (seconds)",
        },
        {
          key: "cpuPercent",
          flag: "--cpu-percent",
          scale: 1,
          label: "CPU advisory (% of one core; never holds)",
        },
        { key: "healthLatencyMs", flag: "--health-ms", scale: 1, label: "Health p95 budget (milliseconds)" },
      ];
      const args = ["canary"];
      for (const field of fields) {
        const value = await flow.readText({
          message: `${field.label}; current ${Number(policy[field.key]) / field.scale}`,
          allowBack: true,
          validate: (value) =>
            Number.isFinite(Number(value)) && Number(value) > 0 ? undefined : "Enter a positive number.",
        });
        if (value === undefined) return;
        args.push(field.flag, value.trim());
      }
      await update(args);
      shell.insertCommandResult("/update", "Canary settings saved for the next update.", "success");
      return;
    }
    let ref = "main";
    if (choice === "ref") {
      const typed = await flow.readText({
        message: "Ref",
        allowBack: true,
        validate: (value) => (value.trim() && !value.trim().startsWith("-") ? undefined : "Enter a ref."),
      });
      if (typed === undefined) return;
      ref = typed.trim();
    }
    const staged = await update(ref === "main" ? [] : ["--ref", ref]);
    const accepted = record(staged).accepted === true;
    shell.insertCommandResult(
      "/update",
      accepted
        ? `Staged ${ref}. ${formatUpdateState(staged)}\n/update status follows it.`
        : `Not staged: another update is still settling. ${formatUpdateState(staged)}`,
      accepted ? "success" : "error",
    );
  } catch (error) {
    shell.insertCommandResult("/update", message(error), "error");
  } finally {
    flow.end();
  }
}
