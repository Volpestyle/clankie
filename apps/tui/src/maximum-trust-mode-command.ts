import { MAXIMUM_TRUST_MODE_WORDING } from "@clankie/protocol/owner-settings";
import type { MaximumTrustModeResult } from "./command/maximum-trust-mode.ts";
import { onOff, runSettingsMenu } from "./settings-menu.ts";
import type { FaceShellCommand } from "./shell/shell.ts";

const USAGE = "Usage: /maximum-trust-mode [status|on|off]";

/** The mode, what it means, its warning while on, and the live seats still on the other mode. */
function describeMaximumTrustMode(result: MaximumTrustModeResult): string {
  const seats = result.seatsOnOtherMode ?? [];
  return [
    `${MAXIMUM_TRUST_MODE_WORDING.title}: ${onOff(result.enabled)}. ${result.description}`,
    ...(result.warning === undefined ? [] : [`Warning: ${result.warning}`]),
    ...(seats.length === 0
      ? []
      : [
          `Still ${result.enabled ? "guarded" : "in maximum trust"} until relaunched: ${seats
            .map((seat) => `${seat.title || seat.seatId} (${seat.harness})`)
            .join(", ")}.`,
        ]),
  ].join("\n");
}

/** `/maximum-trust-mode`: the owner's switch (VUH-2048), over the same owner API as the CLI. */
export function maximumTrustModeCommand(
  mode: ((args: readonly string[]) => Promise<MaximumTrustModeResult>) | undefined,
): FaceShellCommand {
  return {
    name: "maximum-trust-mode",
    aliases: [],
    description: "Launch every harness without its permission prompts and sandbox",
    argumentHint: "[on|off]",
    takesArgument: true,
    async run(argument, shell): Promise<void> {
      if (mode === undefined) {
        shell.insertCommandResult("/maximum-trust-mode", "Maximum trust mode is unavailable here.", "error");
        return;
      }
      const input = argument.trim().toLowerCase();
      if (input === "") {
        await runSettingsMenu(shell, "/maximum-trust-mode", async () => {
          const current = await mode([]);
          const next = current.enabled ? "off" : "on";
          return {
            title: describeMaximumTrustMode(current),
            actions: [
              {
                value: next,
                label: `Turn maximum trust mode ${next}`,
                hint: current.enabled ? MAXIMUM_TRUST_MODE_WORDING.off : MAXIMUM_TRUST_MODE_WORDING.warning,
                async run() {
                  return describeMaximumTrustMode(await mode([next]));
                },
              },
            ],
          };
        });
        return;
      }
      if (input !== "status" && input !== "on" && input !== "off") {
        shell.insertCommandResult("/maximum-trust-mode", USAGE, "error");
        return;
      }
      try {
        shell.insertCommandResult(
          "/maximum-trust-mode",
          describeMaximumTrustMode(await mode(input === "status" ? [] : [input])),
          "success",
        );
      } catch (error) {
        shell.insertCommandResult(
          "/maximum-trust-mode",
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    },
  };
}
