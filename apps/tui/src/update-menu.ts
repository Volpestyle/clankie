/**
 * `/update` as a modal: show what is running and the last durable update,
 * then stage one only when the owner picks it. Same endpoint as `clankie update`.
 */
import { HOST_SETTINGS_WORDING } from "@clankie/protocol/owner-settings";
import type { ClankieFaceShell } from "./shell/shell.ts";
import { formatUpdateOutput } from "./command/update-output.ts";

type Run = (args: readonly string[]) => Promise<unknown>;
type Json = Record<string, unknown>;
const record = (value: unknown): Json => (value !== null && typeof value === "object" ? (value as Json) : {});
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function runUpdateMenu(shell: ClankieFaceShell, update: Run): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin("update");
  try {
    const state = await update(["status"]);
    const pending = record(state).pending !== undefined || record(state).needsReconciliation === true;
    const choice = await flow.readSelect({
      message: formatUpdateOutput(state),
      options: [
        {
          value: "main",
          label: "Update to latest main",
          hint: pending ? "review the update status above first" : "installs, restarts, observes health",
        },
        { value: "ref", label: "Update to a ref…", hint: "branch, tag or commit" },
        {
          value: "canary",
          label: "Canary settings…",
          hint: "observation window, health budget, CPU advisory",
        },
        {
          value: "auto",
          label: `${HOST_SETTINGS_WORDING.autoUpdate.label}…`,
          hint: HOST_SETTINGS_WORDING.autoUpdate.description,
        },
      ],
      allowBack: true,
    });
    if (choice === undefined) return;
    if (choice === "auto") {
      const automatic = record(await update(["auto"]));
      const enabled = automatic.autoUpdate === true;
      const next = await flow.readSelect({
        message: `Automatic installs are ${enabled ? "on" : "off"}. Managed bodies always install their approved release.`,
        options: [
          { value: "on", label: "On", hint: "install official releases while idle" },
          { value: "off", label: "Off", hint: "install only when asked" },
        ],
        allowBack: true,
      });
      if (next === undefined) return;
      await update(["auto", next, "--expected-revision", String(automatic.revision)]);
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
    const args = ref === "main" ? [] : ["--ref", ref];
    let staged = await update(args);
    if (Array.isArray(record(staged).holds) && (record(staged).holds as unknown[]).length) {
      const held = record(staged).holds as { id: string }[];
      const consent = await flow.readSelect({
        message: formatUpdateOutput(staged),
        options: [
          { value: "keep", label: "Keep the update held" },
          {
            value: "override",
            label: "Override the reviewed holds and update",
            hint: "authenticated owner; audited per hold",
          },
        ],
        allowBack: true,
      });
      if (consent !== "override") return;
      const reason = await flow.readText({
        message: "Reason for each audited override",
        allowBack: true,
        validate: (text) => (text.trim() ? undefined : "Enter a reason."),
      });
      if (reason === undefined) return;
      staged = await update([
        ...args,
        ...held.flatMap((hold) => ["--override-hold", hold.id]),
        "--reason",
        reason,
      ]);
    }
    const accepted = record(staged).accepted === true;
    const upToDate = record(staged).upToDate === true;
    shell.insertCommandResult(
      "/update",
      formatUpdateOutput(staged),
      accepted || upToDate ? "success" : "error",
    );
  } catch (error) {
    shell.insertCommandResult("/update", message(error), "error");
  } finally {
    flow.end();
  }
}
