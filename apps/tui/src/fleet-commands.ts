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
import { fleetStatus, fleetUpdate, formatFleetLines, runFleetCommand } from "./command/fleet.ts";
import type { ClankieFaceShell, FaceShellCommand } from "./shell/shell.ts";
import {
  FLEET_AUTONOMY_GUIDANCE,
  FleetReportingStyleSchema,
  FleetReleasePolicySchema,
  type FleetAutonomy,
} from "@clankie/protocol";
import { formatWorkingPreferences } from "./command/working-preferences.ts";

export interface FleetCommandServices {
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
      argumentHint: "[status|clear]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        const verb = argument.trim().toLowerCase();
        if (verb === "status") {
          await showFleetStatus(shell, services);
          return;
        }
        if (verb === "clear") {
          await runFleetCommand(["clear"], { settings: services.settings });
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
  const result = await fleetStatus({ settings: services.settings });
  shell.insertCommandResult(
    "/fleet status",
    [
      `settings file: ${result.settingsFile}`,
      "",
      ...formatFleetLines(result.fleet),
      "",
      ...formatWorkingPreferences(result.workingPreferences),
      ...result.roleProfiles.map((r) => `${r.projectId}/${r.role}: ${hireProfileLine(r.profile)}`),
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

async function editFleet(shell: ClankieFaceShell, services: FleetCommandServices): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin("fleet");
  try {
    const current = (await fleetStatus({ settings: services.settings })).fleet;
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
    for (const field of ["commit", "push"] as const) {
      const value = await flow.readSelect({
        message: `Fleet — who may ${field} completed work`,
        options: (["lead", "owner"] as const).map((value) => ({
          value,
          label: value,
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
        label: value,
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
      { settings: services.settings },
    );
    flow.renderLine(
      "Saved. Fleet autonomy, tool access and peer-message settings apply immediately. Run `clankie restart` to apply routing preferences.",
      "success",
    );
  } finally {
    flow.end();
  }
}

/** `codex · gpt-6 · high · subagents gpt-6-mini` — the fields a role actually sets. */
function hireProfileLine(profile: Record<string, unknown>): string {
  const subagents = profile.subagents as { model?: string; effort?: string } | null | undefined;
  return [
    profile.harness,
    profile.model,
    profile.effort,
    profile.delegation,
    profile.placement,
    profile.account === undefined ? undefined : `account ${String(profile.account)}`,
    subagents ? `subagents ${[subagents.model, subagents.effort].filter(Boolean).join(" ")}` : undefined,
  ]
    .filter((value) => value !== undefined && value !== "")
    .join(" · ");
}
