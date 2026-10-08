import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MachineAccessRefusalSchema, type MachineAccessRefusal } from "@clankie/protocol";
import { MachineAccessRefused, machineAccessAllows, type MachineAccessLevel } from "@clankie/protocol";
import { localSandboxAccess, type ClankieSettings, type SettingsStore } from "@clankie/settings";

interface JoinedMachineRegistry {
  has(id: string): boolean;
  accessCeiling(id: string): MachineAccessLevel | undefined;
}

/** ID comes from the trusted machine/connection registry, never a model's host claim. */
export function machineAccessLevel(
  settings: ClankieSettings,
  id: string,
  joined?: JoinedMachineRegistry,
): MachineAccessLevel {
  if (id === "local") return localSandboxAccess(settings.machineAccess.local ?? "screen");
  if (joined?.has(id)) {
    const level = settings.machineAccess[id] ?? "portal";
    const ceiling = joined.accessCeiling(id) ?? "portal";
    return machineAccessAllows(ceiling, level) ? level : ceiling;
  }
  const machine = settings.machines.find((entry) => entry.id === id || entry.aliases.includes(id));
  return machine && Object.hasOwn(settings.machineAccess, machine.id)
    ? settings.machineAccess[machine.id]!
    : "portal";
}

export async function requireMachineAccess(
  settings: SettingsStore,
  id: string,
  required: MachineAccessLevel,
  joined?: JoinedMachineRegistry,
): Promise<void> {
  const policy = await settings.loadFenced();
  const level = machineAccessLevel(policy.settings, id, joined);
  if (!machineAccessAllows(level, required)) await refuseMachineAccess(settings, id, level, required);
  policy.assertCurrent();
}

/** Resolve a fleet connection and its ceiling from one fenced registry generation. */
export async function requireRuntimeMachineAccess(
  settings: SettingsStore,
  fleet: string | undefined,
  required: MachineAccessLevel,
  joined?: JoinedMachineRegistry,
): Promise<void> {
  if (fleet === undefined || fleet === "default")
    return requireMachineAccess(settings, "local", required, joined);
  const policy = await settings.loadFenced();
  const connection = policy.settings.execution.connections.find((entry) => entry.id === fleet);
  if (!connection) throw new Error("Unknown runtime connection");
  if (connection.ssh && connection.machine === undefined)
    throw new Error("Remote runtime has no proven machine");
  const machine = connection.machine ?? "local";
  const level = machineAccessLevel(policy.settings, machine, joined);
  if (!machineAccessAllows(level, required)) await refuseMachineAccess(settings, machine, level, required);
  policy.assertCurrent();
}

/** One durable owner observation per machine/required level; repeated refusals coalesce. */
async function refuseMachineAccess(
  settings: SettingsStore,
  machine: string,
  level: MachineAccessLevel,
  required: MachineAccessLevel,
): Promise<never> {
  const error = new MachineAccessRefused(machine, level, required);
  const directory = `${settings.path}.access-refusals`;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${encodeURIComponent(machine)}-${required}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({
        machine,
        accessLevel: level,
        required,
        observedAt: new Date().toISOString(),
        fix: `Owner: clankie machines access ${machine} ${required} (joined/OS ceilings may require new approval).`,
      }),
      { mode: 0o600 },
    );
    await rename(temporary, path);
  } catch (failure) {
    throw new Error(`${error.message} Owner refusal observation could not be saved: ${String(failure)}`, {
      cause: error,
    });
  }
  throw error;
}

export async function readMachineAccessRefusals(
  settings: SettingsStore,
  joined?: JoinedMachineRegistry,
): Promise<MachineAccessRefusal[]> {
  const directory = `${settings.path}.access-refusals`;
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const policy = await settings.load();
  const records = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) =>
        MachineAccessRefusalSchema.parse(JSON.parse(await readFile(join(directory, file), "utf8"))),
      ),
  );
  // Keep the original evidence on disk; resolved observations disappear from doctor.
  return records.filter(
    (record) => !machineAccessAllows(machineAccessLevel(policy, record.machine, joined), record.required),
  );
}
