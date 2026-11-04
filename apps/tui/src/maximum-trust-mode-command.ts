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
    result.seatsOnOtherMode === undefined
      ? "Running agents: couldn't check this machine; other machines aren't listed."
      : "Running agents: this machine only; other machines aren't listed.",
    ...(seats.length === 0
      ? []
      : [
          `Still ${result.enabled ? "asking permission" : "skipping permission prompts"} until they restart: ${seats
            .map((seat) => `${seat.title || seat.seatId} (${seat.harness})`)
            .join(", ")}.`,
        ]),
  ].join("\n");
}

/**
 * `/maximum-trust-mode`: the owner's switch (VUH-2048), over the same owner API as the CLI.
 * Its description stays a literal for the public docs extractor; the test pins it to the summary.
 */
export function maximumTrustModeCommand(
  mode: ((args: readonly string[]) => Promise<MaximumTrustModeResult>) | undefined,
): FaceShellCommand {
  return {
    name: "maximum-trust-mode",
    aliases: [],
    description:
      "Let Claude, Codex and Grok skip their permission prompts; questions only you can answer still come to you",
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
