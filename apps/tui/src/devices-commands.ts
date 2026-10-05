/**
 * `/devices` is `clankie devices`: the same listing and revoke, written into the
 * transcript. An empty list opens on the next step (`/pair`) rather than a bare
 * "none".
 */
import { runDevicesCommand, type DevicesCliCommandOptions } from "./command/devices.ts";
import type { DeviceListItem } from "@clankie/protocol";
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
        if (!argument.trim()) {
          await runDevicesMenu(shell, services);
          return;
        }
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

/** Runs the CLI with `--json` so the menu reads the same listing the table prints. */
async function devicesJson(args: readonly string[], services: DevicesCommandServices) {
  let out = "";
  await runDevicesCommand([...args, "--json"], {
    ...services,
    stdout: { write: (chunk: string) => void (out += chunk) },
    stderr: { write: () => undefined },
  });
  const result = JSON.parse(out) as { ok: boolean; error?: string; devices?: DeviceListItem[] };
  if (!result.ok) throw new Error(result.error ?? "Devices unavailable");
  return result;
}

async function runDevicesMenu(shell: ClankieFaceShell, services: DevicesCommandServices): Promise<void> {
  let devices: DeviceListItem[];
  try {
    devices = (await devicesJson([], services)).devices ?? [];
  } catch (error) {
    shell.insertCommandResult("/devices", error instanceof Error ? error.message : String(error), "error");
    return;
  }
  // Nothing to choose from: point at the next step instead of an empty menu.
  if (!devices.length) {
    shell.insertCommandResult("/devices", "No paired devices. Pair one with /pair.", "success");
    return;
  }
  const flow = shell.setupFlow;
  flow.begin("devices");
  try {
    for (let first = true; ; first = false) {
      if (!first) devices = (await devicesJson([], services)).devices ?? [];
      const choice = await flow.readSelect({
        message: devices.length ? `Paired devices (${devices.length})` : "No paired devices · /pair adds one",
        options: devices.map((device) => ({
          value: device.deviceId,
          label: device.name,
          hint: `${device.platform} · ${device.status}${device.review === true ? " · review" : ""}`,
          description: device.deviceId,
        })),
        allowBack: true,
      });
      const device = devices.find((entry) => entry.deviceId === choice);
      if (!device) return;
      const confirm = await flow.readSelect({
        message: `Revoke ${device.name}?`,
        options: [
          { value: "no", label: "Keep it" },
          { value: "yes", label: "Revoke", hint: "it must pair again to reach him" },
        ],
        allowBack: true,
      });
      if (confirm !== "yes") continue;
      try {
        await devicesJson(["revoke", device.deviceId], services);
        flow.renderLine(`Revoked ${device.name}.`, "success");
      } catch (error) {
        flow.renderLine(error instanceof Error ? error.message : String(error), "error");
      }
    }
  } catch (error) {
    shell.insertCommandResult("/devices", error instanceof Error ? error.message : String(error), "error");
  } finally {
    flow.end();
  }
}
