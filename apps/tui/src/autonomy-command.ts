import {
  AUTONOMY_LEVELS,
  AutonomyLevelSchema,
  type OperatorAutonomyCommand,
  type OperatorAutonomyStatus,
} from "@clankie/protocol";
import { autonomyLevelDescription, type AutonomyCommandResult } from "./command/fleet.ts";
import { onOff, runSettingsMenu } from "./settings-menu.ts";
import type { FaceShellCommand } from "./shell/shell.ts";

export interface AutonomyCommandServices {
  /** The owner's one dial over the fleet settings API (ADR 0263). */
  readonly level?: ((args: readonly string[]) => Promise<AutonomyCommandResult>) | undefined;
  /** The selected conversation's goal and self-wake runner. */
  readonly goals?: ((command: OperatorAutonomyCommand) => Promise<OperatorAutonomyStatus>) | undefined;
  readonly formatGoals?: (status: OperatorAutonomyStatus) => string;
}

const USAGE = `Usage: /autonomy [status|${AutonomyLevelSchema.options.join("|")}|clear]`;

/**
 * `/autonomy` is the dial: off, low, high or full sets how much Clankie decides
 * without asking. Whether he works unprompted is `/auto`; `clear` cancels the
 * chat's scheduled wake.
 */
export function autonomyCommand(services: AutonomyCommandServices): FaceShellCommand {
  const { level, goals } = services;
  const formatGoals = services.formatGoals ?? ((status) => `Goals and self-wakes: ${onOff(status.enabled)}`);
  return {
    name: "autonomy",
    aliases: [],
    description: "Set how many decisions Clankie takes on his own",
    argumentHint: "[off|low|high|full|clear]",
    takesArgument: true,
    async run(argument, shell): Promise<void> {
      if (level === undefined && goals === undefined) {
        shell.insertCommandResult("/autonomy", "Autonomy controls are unavailable.", "error");
        return;
      }
      const input = argument.trim().toLowerCase();
      if (input === "") {
        await runSettingsMenu(shell, "/autonomy", async () => {
          const dial = level === undefined ? undefined : await level([]);
          const status = goals === undefined ? undefined : await goals({ action: "status" });
          return {
            title: [
              ...(dial === undefined ? [] : [autonomyLevelDescription(dial.level)]),
              ...(status === undefined ? [] : [formatGoals(status).split("\n").join(" · ")]),
            ].join(" · "),
            actions: [
              ...(level === undefined
                ? []
                : AutonomyLevelSchema.options.map((option) => ({
                    value: option,
                    label: AUTONOMY_LEVELS[option].label,
                    hint: dial?.level === option ? "current" : AUTONOMY_LEVELS[option].description,
                    async run() {
                      return autonomyLevelDescription((await level([option])).level);
                    },
                  }))),
              ...(status === undefined
                ? []
                : [
                    {
                      value: "goals",
                      label: status.enabled ? "Turn Auto off" : "Turn Auto on",
                      hint: "Whether he works unprompted (/auto); the level is how much he asks",
                      async run() {
                        await goals!({ action: "set_enabled", enabled: !status.enabled });
                        return `Auto ${onOff(!status.enabled)}.`;
                      },
                    },
                  ]),
              ...(status?.wake === undefined
                ? []
                : [
                    {
                      value: "clear",
                      label: "Clear the scheduled wake",
                      hint: status.wake.at,
                      async run() {
                        await goals!({ action: "clear_wake" });
                        return "Wake cleared.";
                      },
                    },
                  ]),
            ],
          };
        });
        return;
      }
      try {
        const chosen = AutonomyLevelSchema.safeParse(input);
        if (chosen.success && level !== undefined) {
          shell.insertCommandResult(
            "/autonomy",
            autonomyLevelDescription((await level([chosen.data])).level),
            "success",
          );
          return;
        }
        const command: OperatorAutonomyCommand | undefined =
          input === "status"
            ? { action: "status" }
            : input === "clear"
              ? { action: "clear_wake" }
              : undefined;
        if (input === "status" && goals === undefined && level !== undefined) {
          shell.insertCommandResult(
            "/autonomy",
            autonomyLevelDescription((await level([])).level),
            "success",
          );
          return;
        }
        if (command === undefined || goals === undefined) {
          shell.insertCommandResult("/autonomy", USAGE, "error");
          return;
        }
        const status = await goals(command);
        const dial = input === "status" && level !== undefined ? await level([]) : undefined;
        shell.insertCommandResult(
          "/autonomy",
          [...(dial === undefined ? [] : [autonomyLevelDescription(dial.level)]), formatGoals(status)].join(
            "\n",
          ),
          status.error === undefined ? "success" : "error",
        );
      } catch (error) {
        shell.insertCommandResult(
          "/autonomy",
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    },
  };
}

/** `/auto` is the master switch for unprompted work (ADR 0264): projects on Auto, goals and self-wakes. */
export function autoCommand(
  goals: ((command: OperatorAutonomyCommand) => Promise<OperatorAutonomyStatus>) | undefined,
): FaceShellCommand {
  return {
    name: "auto",
    aliases: [],
    description: "Turn unprompted work on or off: projects on Auto, goals and self-wakes",
    argumentHint: "[on|off]",
    takesArgument: true,
    async run(argument, shell): Promise<void> {
      if (goals === undefined) {
        shell.insertCommandResult("/auto", "Auto controls are unavailable.", "error");
        return;
      }
      const input = argument.trim().toLowerCase();
      if (!["", "status", "on", "off"].includes(input)) {
        shell.insertCommandResult("/auto", "Usage: /auto [on|off]", "error");
        return;
      }
      try {
        const status = await goals(
          input === "on" || input === "off"
            ? { action: "set_enabled", enabled: input === "on" }
            : { action: "status" },
        );
        shell.insertCommandResult(
          "/auto",
          status.enabled
            ? "Auto is on: Clankie works projects on Auto, goals and self-wakes without being asked. Choose projects with /project."
            : "Auto is off: nothing starts unprompted.",
          status.error === undefined ? "success" : "error",
        );
      } catch (error) {
        shell.insertCommandResult("/auto", error instanceof Error ? error.message : String(error), "error");
      }
    },
  };
}
