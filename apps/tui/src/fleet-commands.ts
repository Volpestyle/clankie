import { SettingsStore } from "@clankie/settings";
import { fleetStatus, fleetUpdate, formatFleetLines } from "./command/fleet.ts";
import type { ClankieFaceShell, FaceShellCommand } from "./shell/shell.ts";

export interface FleetCommandServices {
  settings: SettingsStore;
}

/**
 * `/fleet` edits **who Clankie reaches for**, not what he may do.
 *
 * Free text on purpose: a role enum only covers the situations someone
 * enumerated, and the useful ones are conditional. He reads this and decides,
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
          await fleetUpdate("", { settings: services.settings });
          shell.insertCommandResult(
            "/fleet clear",
            "Cleared. He picks a harness per job with nothing from you.",
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

async function editFleet(shell: ClankieFaceShell, services: FleetCommandServices): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin("fleet");
  try {
    const current = (await services.settings.load()).fleet;
    const notes = await flow.readText({
      message: "Fleet — which agents you want on what, and when (empty: he decides)",
      defaultValue: current.notes,
      placeholder: "e.g. codex for mechanical work, claude when it needs skills",
      multiline: true,
      allowBack: true,
      validate: (value: string) => (value.length > 4_000 ? "Keep it under 4000 characters." : undefined),
    });
    if (notes === undefined) return;
    await fleetUpdate(notes.trim(), { settings: services.settings });
    flow.renderLine("Saved. Run `clankie restart captain` to apply it.", "success");
  } finally {
    flow.end();
  }
}
