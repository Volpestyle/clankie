import { createHash } from "node:crypto";
import {
  DesktopChoiceSchema,
  desktopModeAllowed,
  type DesktopAccessSnapshot,
  type DesktopActorPermissions,
  type DesktopMode,
} from "@clankie/protocol/desktop-access";
import type { MachineAccessLevel } from "@clankie/protocol/machine-access";
import type { ClankieSettings, SettingsStore } from "@clankie/settings";

/** Permission observations inform the owner only. They never authorize an operation. */
export class DesktopAccess {
  private readonly observations = new Map<string, DesktopActorPermissions>();
  private readonly settings: Pick<SettingsStore, "load"> & Partial<Pick<SettingsStore, "update">>;
  private readonly access: (settings: ClankieSettings, id: string) => MachineAccessLevel;
  private readonly now: () => number;
  constructor(
    settings: Pick<SettingsStore, "load"> & Partial<Pick<SettingsStore, "update">>,
    access: (settings: ClankieSettings, id: string) => MachineAccessLevel,
    now: () => number = Date.now,
  ) {
    this.settings = settings;
    this.access = access;
    this.now = now;
  }

  snapshot(current: ClankieSettings, machineId: string, lead?: string): DesktopAccessSnapshot {
    const choice = Object.hasOwn(current.computer.machines, machineId)
      ? current.computer.machines[machineId]!
      : DesktopChoiceSchema.parse({});
    const selectedMode =
      (lead !== undefined && Object.hasOwn(choice.leadModes, lead) ? choice.leadModes[lead] : undefined) ??
      choice.desktopMode;
    const accessLevel = current.autonomy.watch ? "portal" : this.access(current, machineId);
    const observation = this.observations.get(machineId);
    return {
      schemaVersion: 1,
      machineId,
      revision: createHash("sha256").update(JSON.stringify({ choice, accessLevel })).digest("hex"),
      ...choice,
      ...(lead === undefined ? {} : { selectedLead: lead }),
      selectedMode,
      effectiveMode: desktopModeAllowed(selectedMode, accessLevel) ? selectedMode : "none",
      accessLevel,
      permissions:
        observation === undefined
          ? { state: "unavailable", reason: "not_checked" }
          : this.now() - Date.parse(observation.observedAt) > 60_000 ||
              this.now() < Date.parse(observation.observedAt)
            ? { state: "unavailable", reason: "stale" }
            : { state: "observed", observation },
      vm: { state: "unavailable" },
    };
  }

  read(machineId: string, lead?: string) {
    return this.settings.load().then((current) => this.snapshot(current, machineId, lead));
  }

  async set(
    machineId: string,
    input: { expectedRevision: string; mode: DesktopMode; lead?: string | undefined },
    guard: () => Promise<void>,
  ): Promise<DesktopAccessSnapshot> {
    if (!this.settings.update) throw Error("desktop_settings_unavailable");
    let before: string | undefined;
    const updated = await this.settings.update(
      (current) => {
        const state = this.snapshot(current, machineId, input.lead);
        if (state.revision !== input.expectedRevision) throw Error("desktop_mode_conflict");
        if (!desktopModeAllowed(input.mode, state.accessLevel)) throw Error("desktop_mode_above_ceiling");
        before = JSON.stringify(current);
        const previous = Object.hasOwn(current.computer.machines, machineId)
          ? current.computer.machines[machineId]!
          : DesktopChoiceSchema.parse({});
        const choice =
          input.lead === undefined
            ? { ...previous, desktopMode: input.mode }
            : { ...previous, leadModes: { ...previous.leadModes, [input.lead]: input.mode } };
        return {
          ...current,
          computer: { ...current.computer, machines: { ...current.computer.machines, [machineId]: choice } },
        };
      },
      async () => {
        await guard();
        if (JSON.stringify(await this.settings.load()) !== before) throw Error("desktop_mode_conflict");
        // Recheck the independently verified sandbox/join ceiling at the commit boundary.
        if (!desktopModeAllowed(input.mode, this.access(await this.settings.load(), machineId)))
          throw Error("desktop_mode_above_ceiling");
      },
    );
    return this.snapshot(updated, machineId, input.lead);
  }

  publish(machineId: string, observation: DesktopActorPermissions): void {
    // A remote controller cannot attest which local process macOS evaluated.
    if (machineId !== "local") throw Error("desktop_actor_context_unavailable");
    const age = this.now() - Date.parse(observation.observedAt);
    if (age < 0 || age > 10_000) throw Error("desktop_actor_observation_stale");
    this.observations.set(machineId, observation);
  }
}
