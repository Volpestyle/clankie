import {
  FLEET_MODEL_GUIDANCE,
  FLEET_MODEL_MODES,
  FLEET_SIZE_GUIDANCE,
  FLEET_SIZES,
  FLEET_CLOSURE_GUIDANCE,
  FLEET_MACHINE_SETUP_GUIDANCE,
  SettingsStore,
  type FleetModelMode,
  type FleetSize,
} from "@clankie/settings";
import {
  fleetStatus,
  fleetUpdate,
  formatFleetLines,
  runFleetCommand,
  type FleetCommandOptions,
} from "./command/fleet.ts";
import type { ClankieFaceShell, FaceShellCommand } from "./shell/shell.ts";
import {
  FLEET_AUTONOMY_GUIDANCE,
  FLEET_GATE_CATEGORIES,
  FLEET_GATE_PRESETS,
  FLEET_GATE_MODES,
  FLEET_WORKING_GATE_LABELS,
  fleetGateSummary,
  matchingFleetGatePreset,
  HireEffortSchema,
  OPERATOR_SEAT_HARNESSES,
  FleetReportingStyleSchema,
  FleetReleasePolicySchema,
  FleetResourcePolicySchema,
  type FleetAutonomy,
} from "@clankie/protocol";
import { formatWorkingPreferences } from "./command/working-preferences.ts";

export interface FleetCommandServices extends FleetCommandOptions {
  settings: SettingsStore;
}

/**
 * `/fleet` edits who Clankie reaches for and the tool and peer-message switches.
 *
 * The routing notes are free text on purpose: a role enum only covers the
 * situations someone enumerated, and the useful ones are conditional. The swarm
 * size and model mode are the one structured part — the owner's budget — and
 * they are targets he sizes toward, never caps. He reads all of it and decides,
 * the same way he reads the rest of a turn — it is a preference, not a router.
 */
export function buildFleetCommands(services: FleetCommandServices): FaceShellCommand[] {
  return [
    {
      name: "fleet",
      aliases: [],
      description: "Edit how Clankie routes work across the agents he leads",
      argumentHint: "[status|show|resources|clear]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        const verb = argument.trim().toLowerCase();
        if (verb === "status" || verb === "show") {
          await showFleetStatus(shell, services);
          return;
        }
        if (verb === "resources") {
          await editFleetResources(shell, services);
          return;
        }
        if (verb === "clear") {
          await runFleetCommand(["clear"], services);
          shell.insertCommandResult(
            "/fleet clear",
            "Cleared. Fleet size max, models optimal, closure, machine setup, commit and push lead, release owner, focused verification, short plain reports, fleet tools connected and peer messages on.",
            "success",
          );
          return;
        }
        await editFleet(shell, services);
      },
    },
  ];
}

async function showFleetStatus(shell: ClankieFaceShell, services: FleetCommandServices): Promise<void> {
  const result = await fleetStatus(services);
  shell.insertCommandResult(
    "/fleet status",
    [
      `settings file: ${result.settingsFile}`,
      "",
      ...formatFleetLines(result.fleet),
      "",
      ...formatWorkingPreferences(result.workingPreferences),
      ...result.roleProfiles.map((r) => `${r.projectId}/${r.role}: ${r.summary}`),
    ].join("\n"),
    "success",
  );
}

function isFleetSize(value: string): value is FleetSize {
  return (FLEET_SIZES as readonly string[]).includes(value);
}

function isFleetModelMode(value: string): value is FleetModelMode {
  return (FLEET_MODEL_MODES as readonly string[]).includes(value);
}

async function editFleetResources(shell: ClankieFaceShell, services: FleetCommandServices): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin("fleet resources");
  try {
    const snapshot = await fleetStatus(services);
    const current = snapshot.fleet;
    const resources = FleetResourcePolicySchema.parse(current.resources ?? {});
    const capacity = await flow.readText({
      message: "Fleet — shared heavy capacity (auto or 1–64)",
      defaultValue: String(resources.heavySlots ?? "auto"),
      allowBack: true,
      validate: (value: string) =>
        value === "auto" || (/^\d+$/u.test(value) && Number(value) >= 1 && Number(value) <= 64)
          ? undefined
          : "Use auto or an integer from 1 to 64.",
    });
    if (capacity === undefined) return;
    resources.heavySlots = capacity === "auto" ? null : Number(capacity);
    const simulators = await flow.readText({
      message: "Fleet — maximum booted simulators (0–64)",
      defaultValue: String(resources.simulatorSlots),
      allowBack: true,
      validate: (value: string) =>
        /^\d+$/u.test(value) && Number(value) >= 0 && Number(value) <= 64
          ? undefined
          : "Use an integer from 0 to 64.",
    });
    if (simulators === undefined) return;
    resources.simulatorSlots = Number(simulators);
    const idle = await flow.readText({
      message: "Fleet — simulator idle timeout in seconds (1–86400)",
      defaultValue: String(resources.simulatorIdleMs / 1000),
      allowBack: true,
      validate: (value: string) =>
        /^\d+$/u.test(value) && Number(value) >= 1 && Number(value) <= 86400
          ? undefined
          : "Use an integer from 1 to 86400.",
    });
    if (idle === undefined) return;
    resources.simulatorIdleMs = Number(idle) * 1000;
    const load = await flow.readText({
      message: "Fleet — load limit per core (0–16, greater than zero)",
      defaultValue: String(resources.maxLoadRatio),
      allowBack: true,
      validate: (value: string) =>
        Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) <= 16
          ? undefined
          : "Use a positive number up to 16.",
    });
    if (load === undefined) return;
    resources.maxLoadRatio = Number(load);
    const memory = await flow.readText({
      message: "Fleet — minimum available memory in MiB",
      defaultValue: String(resources.minAvailableMemoryMb),
      allowBack: true,
      validate: (value: string) =>
        /^\d+$/u.test(value) && Number(value) >= 0 && Number(value) <= 1048576
          ? undefined
          : "Use an integer from 0 to 1048576.",
    });
    if (memory === undefined) return;
    resources.minAvailableMemoryMb = Number(memory);
    await fleetUpdate({ resources }, { ...services, expectedRevision: snapshot.revision });
    flow.renderLine(
      "Saved. Resource capacity and pressure limits apply to the shared machine governor.",
      "success",
    );
  } finally {
    flow.end();
  }
}

async function editFleet(shell: ClankieFaceShell, services: FleetCommandServices): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin("fleet");
  try {
    const snapshot = await fleetStatus(services);
    const current = snapshot.fleet;
    flow.renderLine(fleetGateSummary(current));
    const size = await flow.readSelect({
      message: "Fleet — the fleet size to aim for (a target, not a cap)",
      options: FLEET_SIZES.map((value) => ({ value, label: value, description: FLEET_SIZE_GUIDANCE[value] })),
      initialValue: current.size,
      currentValue: current.size,
      allowBack: true,
    });
    if (size === undefined || !isFleetSize(size)) return;
    const models = await flow.readSelect({
      message: "Fleet — how a model and effort are picked per job",
      options: FLEET_MODEL_MODES.map((value) => ({
        value,
        label: value,
        description: FLEET_MODEL_GUIDANCE[value],
      })),
      initialValue: current.models,
      currentValue: current.models,
      allowBack: true,
    });
    if (models === undefined || !isFleetModelMode(models)) return;
    const auto = { value: "auto", label: "auto", description: "He chooses per job." };
    const harness = await flow.readSelect({
      message: "Fleet — default worker harness",
      options: [auto, ...OPERATOR_SEAT_HARNESSES.map((value) => ({ value, label: value }))],
      initialValue: current.hire?.harness ?? "auto",
      currentValue: current.hire?.harness ?? "auto",
      allowBack: true,
    });
    if (harness === undefined) return;
    const model = await flow.readText({
      message: "Fleet — default worker model (empty: he chooses)",
      defaultValue: current.hire?.model ?? "",
      placeholder: "e.g. gpt-6.1-sol",
      allowBack: true,
      validate: (value: string) => (value.trim().length > 200 ? "Keep it under 200 characters." : undefined),
    });
    if (model === undefined) return;
    const effort = await flow.readSelect({
      message: "Fleet — default worker effort",
      options: [
        auto,
        ...HireEffortSchema.options.map((value) => ({ value, label: value })),
        ...(current.hire?.effort && !HireEffortSchema.safeParse(current.hire.effort).success
          ? [{ value: current.hire.effort, label: current.hire.effort }]
          : []),
      ],
      initialValue: current.hire?.effort ?? "auto",
      currentValue: current.hire?.effort ?? "auto",
      allowBack: true,
    });
    if (effort === undefined) return;
    const account = await flow.readText({
      message: "Fleet — default worker account label (empty: he chooses per machine by sign-in and usage)",
      defaultValue: current.hire?.account ?? "",
      placeholder: "e.g. james for ~/.claude-james or ~/.codex-james on the hire's machine",
      allowBack: true,
      validate: (value: string) =>
        value.trim() === "" || value.trim() === "auto" || /^[a-z][a-z0-9_-]{0,63}$/u.test(value.trim())
          ? undefined
          : "Lowercase label, or empty.",
    });
    if (account === undefined) return;
    const tools = await flow.readSelect({
      message: "Fleet — access to connected tools",
      options: [
        {
          value: "connected",
          label: "connected",
          description: "Every admitted fleet pane gets tools from verified connected accounts.",
        },
        {
          value: "off",
          label: "off",
          description: "Disable connected tools for all fleet panes; manual grants keep working.",
        },
      ],
      initialValue: current.tools,
      currentValue: current.tools,
      allowBack: true,
    });
    if (tools !== "connected" && tools !== "off") return;
    const peerMessages = await flow.readSelect({
      message: "Fleet — messages between workers",
      options: [
        {
          value: "on",
          label: "on",
          description: "Proven native workers may message other seats in their own fleet.",
        },
        {
          value: "off",
          label: "off",
          description: "Stop new peer messages; existing delivery receipts remain readable.",
        },
      ],
      initialValue: current.peerMessages,
      currentValue: current.peerMessages,
      allowBack: true,
    });
    if (peerMessages !== "on" && peerMessages !== "off") return;
    const closure = await flow.readSelect({
      message: "Fleet — who accepts and closes completed tracked work",
      options: (["lead", "owner"] as const).map((value) => ({
        value,
        label: value,
        description: FLEET_CLOSURE_GUIDANCE[value],
      })),
      initialValue: current.closure,
      currentValue: current.closure,
      allowBack: true,
    });
    if (closure !== "lead" && closure !== "owner") return;
    const machineSetup = await flow.readSelect({
      message: "Fleet — who approves harness setup on linked machines",
      options: (["lead", "owner"] as const).map((value) => ({
        value,
        label: value,
        description: FLEET_MACHINE_SETUP_GUIDANCE[value],
      })),
      initialValue: current.machineSetup,
      currentValue: current.machineSetup,
      allowBack: true,
    });
    if (machineSetup !== "lead" && machineSetup !== "owner") return;
    const preference: Partial<FleetAutonomy> = {};
    const preset = await flow.readSelect({
      message: "How hands-on do you want to be?",
      options: [
        { value: "custom", label: "Customize", description: "Choose who decides for each category." },
        ...Object.entries(FLEET_GATE_PRESETS).map(([value, entry]) => ({
          value,
          label: entry.label,
          description: entry.description,
        })),
      ],
      initialValue: matchingFleetGatePreset(current) ?? "custom",
      currentValue: matchingFleetGatePreset(current) ?? "custom",
      allowBack: true,
    });
    if (typeof preset !== "string") return;
    const presetGates =
      preset === "custom" ? current : FLEET_GATE_PRESETS[preset as keyof typeof FLEET_GATE_PRESETS]?.gates;
    if (!presetGates) return;
    if (preset !== "custom") Object.assign(preference, presetGates);
    for (const category of preset === "custom" ? FLEET_GATE_CATEGORIES : []) {
      if (category.key === "moneyAndAccounts") {
        preference.moneyAndAccounts = "owner";
        flow.renderLine(`${category.label}: ${FLEET_GATE_MODES.owner.label} — ${category.description}`);
        continue;
      }
      const value = await flow.readSelect({
        message: `Fleet — ${category.label}`,
        options: Object.entries(FLEET_GATE_MODES).map(([value, entry]) => ({
          value,
          label: entry.label,
          description: entry.description,
        })),
        initialValue: presetGates[category.key],
        currentValue: current[category.key],
        allowBack: true,
      });
      if (value !== "allow" && value !== "lead" && value !== "owner") return;
      preference[category.key] = value;
    }
    for (const field of ["commit", "push"] as const) {
      const value = await flow.readSelect({
        message: `Fleet — who may ${field} completed work`,
        options: (["lead", "owner"] as const).map((value) => ({
          value,
          label: FLEET_WORKING_GATE_LABELS[value],
          description: FLEET_AUTONOMY_GUIDANCE[field][value],
        })),
        initialValue: current[field],
        currentValue: current[field],
        allowBack: true,
      });
      if (value !== "lead" && value !== "owner") return;
      preference[field] = value;
    }
    const release = await flow.readSelect({
      message: "Fleet — who may publish an official release",
      options: (["lead", "owner", "time_rule"] as const).map((value) => ({
        value,
        label: FLEET_WORKING_GATE_LABELS[value],
        description: FLEET_AUTONOMY_GUIDANCE.release[value],
      })),
      initialValue: current.release.mode,
      currentValue: current.release.mode,
      allowBack: true,
    });
    if (release !== "lead" && release !== "owner" && release !== "time_rule") return;
    if (release === "time_rule") {
      const rule = await flow.readText({
        message: "Fleet — the standing release time rule",
        defaultValue: current.release.mode === "time_rule" ? current.release.rule : "",
        multiline: true,
        allowBack: true,
        validate: (value: string) =>
          FleetReportingStyleSchema.safeParse(value).success
            ? undefined
            : "Use 1 to 2000 nonempty characters.",
      });
      if (rule === undefined) return;
      preference.release = FleetReleasePolicySchema.parse({ mode: release, rule });
    } else preference.release = { mode: release };
    const verification = await flow.readSelect({
      message: "Fleet — how completed changes are verified",
      options: (["change_run_read", "review_and_seal"] as const).map((value) => ({
        value,
        label: value,
        description: FLEET_AUTONOMY_GUIDANCE.verification[value],
      })),
      initialValue: current.verification,
      currentValue: current.verification,
      allowBack: true,
    });
    if (verification !== "change_run_read" && verification !== "review_and_seal") return;
    preference.verification = verification;
    const reportingStyle = await flow.readText({
      message: "Fleet — progress and result reporting style",
      defaultValue: current.reportingStyle,
      multiline: true,
      allowBack: true,
      validate: (value: string) =>
        FleetReportingStyleSchema.safeParse(value).success ? undefined : "Use 1 to 2000 nonempty characters.",
    });
    if (reportingStyle === undefined) return;
    preference.reportingStyle = FleetReportingStyleSchema.parse(reportingStyle);
    const notes = await flow.readText({
      message: "Fleet — which agents you want on what, and when (empty: he decides)",
      defaultValue: current.notes,
      placeholder: "e.g. codex for mechanical work, claude when it needs skills",
      multiline: true,
      allowBack: true,
      validate: (value: string) => (value.length > 4_000 ? "Keep it under 4000 characters." : undefined),
    });
    if (notes === undefined) return;
    await fleetUpdate(
      { size, models, tools, peerMessages, closure, machineSetup, notes: notes.trim(), ...preference },
      { ...services, expectedRevision: snapshot.revision },
      { harness, model: model.trim() || "auto", effort, account: account.trim() || "auto" },
    );
    flow.renderLine(
      "Saved. Fleet autonomy, tool access and peer-message settings apply immediately. Run `clankie restart` to apply routing preferences.",
      "success",
    );
  } finally {
    flow.end();
  }
}
