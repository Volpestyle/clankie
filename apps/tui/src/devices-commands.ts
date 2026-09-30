/**
 * `/devices` is `clankie devices`: the same listing and revoke, written into the
 * transcript. An empty list opens on the next step (`/pair`) rather than a bare
 * "none".
 */
import { runDevicesCommand, type DevicesCliCommandOptions } from "./command/devices.ts";
import type { ClankieFaceShell, FaceShellCommand } from "./shell/shell.ts";

export type DevicesCommandServices = Omit<DevicesCliCommandOptions, "stdout" | "stderr">;

export function buildDevicesCommands(services: DevicesCommandServices): FaceShellCommand[] {
  return [
    {
      name: "devices",
      aliases: [],
      description: "List paired phones and tablets, or revoke one",
      argumentHint: "[revoke ID]",
      takesArgument: true,
      async run(argument: string, shell: ClankieFaceShell): Promise<void> {
        let out = "";
        let err = "";
        const exit = await runDevicesCommand(
          argument
            .trim()
            .split(/\s+/u)
            .filter((word) => word.length > 0),
          {
            ...services,
            stdout: { write: (chunk: string) => void (out += chunk) },
            stderr: { write: (chunk: string) => void (err += chunk) },
          },
        ).catch((error: unknown) => {
          err += error instanceof Error ? error.message : String(error);
          return 1;
        });
        shell.insertCommandResult("/devices", `${err}\n${out}`.trim(), exit === 0 ? "success" : "error");
      },
    },
  ];
}
