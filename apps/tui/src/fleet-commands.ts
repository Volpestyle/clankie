import {
  FLEET_MODEL_GUIDANCE,
  FLEET_MODEL_MODES,
  FLEET_SIZE_GUIDANCE,
  FLEET_SIZES,
  SettingsStore,
  type FleetModelMode,
  type FleetSize,
} from "@clankie/settings";
import { fleetStatus, fleetUpdate, formatFleetLines } from "./command/fleet.ts";
import type { ClankieFaceShell, FaceShellCommand } from "./shell/shell.ts";

export interface FleetCommandServices {
  settings: SettingsStore;
}

/**
 * `/fleet` edits **who Clankie reaches for**, not what he may do.
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
          await fleetUpdate({ notes: "", size: "max", models: "optimal" }, { settings: services.settings });
          shell.insertCommandResult(
            "/fleet clear",
            "Cleared. Swarm size max, models optimal, and he picks a harness per job with nothing from you.",
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
    [`settings file: ${result.settingsFile}`, "", ...formatFleetLines(result.fleet)].join("\n"),
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
    const current = (await services.settings.load()).fleet;
    const size = await flow.readSelect({
      message: "Fleet — the swarm size to aim for (a target, not a cap)",
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
    const notes = await flow.readText({
      message: "Fleet — which agents you want on what, and when (empty: he decides)",
      defaultValue: current.notes,
      placeholder: "e.g. codex for mechanical work, claude when it needs skills",
      multiline: true,
      allowBack: true,
      validate: (value: string) => (value.length > 4_000 ? "Keep it under 4000 characters." : undefined),
    });
    if (notes === undefined) return;
    await fleetUpdate({ size, models, notes: notes.trim() }, { settings: services.settings });
    flow.renderLine("Saved. Run `clankie restart captain` to apply it.", "success");
  } finally {
    flow.end();
  }
}
