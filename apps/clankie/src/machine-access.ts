import { MachineAccessRefused, machineAccessAllows, type MachineAccessLevel } from "@clankie/protocol";
import type { ClankieSettings, SettingsStore } from "@clankie/settings";

/** ID comes from the trusted machine/connection registry, never a model's host claim. */
export function machineAccessLevel(settings: ClankieSettings, id: string): MachineAccessLevel {
  if (id === "local") return settings.machineAccess.local ?? "screen";
  const machine = settings.machines.find((entry) => entry.id === id || entry.aliases.includes(id));
  return machine && Object.hasOwn(settings.machineAccess, machine.id)
    ? settings.machineAccess[machine.id]!
    : "portal";
}

export async function requireMachineAccess(
  settings: SettingsStore,
  id: string,
  required: MachineAccessLevel,
): Promise<void> {
  const policy = await settings.loadFenced();
  const level = machineAccessLevel(policy.settings, id);
  if (!machineAccessAllows(level, required)) throw new MachineAccessRefused(id, level, required);
  policy.assertCurrent();
}

/** Resolve a fleet connection and its ceiling from one fenced registry generation. */
export async function requireRuntimeMachineAccess(
  settings: SettingsStore,
  fleet: string | undefined,
  required: MachineAccessLevel,
): Promise<void> {
  if (fleet === undefined || fleet === "default") return requireMachineAccess(settings, "local", required);
  const policy = await settings.loadFenced();
  const connection = policy.settings.execution.connections.find((entry) => entry.id === fleet);
  if (!connection) throw new Error("Unknown runtime connection");
  if (connection.ssh && connection.machine === undefined)
    throw new Error("Remote runtime has no proven machine");
  const machine = connection.machine ?? "local";
  const level = machineAccessLevel(policy.settings, machine);
  if (!machineAccessAllows(level, required)) throw new MachineAccessRefused(machine, level, required);
  policy.assertCurrent();
}
