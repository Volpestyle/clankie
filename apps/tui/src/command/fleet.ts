import {
  effectiveHireProfile,
  FleetAutonomySchema,
  FleetGateModeSchema,
  FleetGatesSchema,
  FLEET_GATE_PRESETS,
  FleetReleasePolicySchema,
  formatFleetAutonomyGuidance,
  type FleetAutonomy,
  AUTONOMY_LEVELS,
  AutonomyLevelSchema,
  type AutonomyLevel,
  type AutonomyLevelReading,
  type AutonomyDrift,
  formatAutonomyDrift,
  FleetResourcePolicySchema,
  withoutNoPreference,
} from "@clankie/protocol";
import { type FleetResourceGovernor } from "@clankie/fleet-resources";
import { projectRolePolicy } from "@clankie/protocol/projects";
import { readFile } from "node:fs/promises";
import { HireProfileSchema, OPERATOR_SEAT_HARNESSES, type HireProfile } from "@clankie/protocol";
import {
  FleetSettingsSchema,
  SettingsStore,
  defaultSettingsPath,
  type FleetSettings,
} from "@clankie/settings";
import { readWorkingPreferences, type WorkingPreferencesReport } from "./working-preferences.ts";
import {
  ownerSettingsApi,
  type OwnerSettingsApi,
  type OwnerSettingsApiOptions,
} from "./owner-settings-api.ts";
import { FLEET_AUTO_TIDY, FLEET_SETTINGS_PATH, FleetSettingsSnapshotSchema } from "@clankie/protocol";
import { DeployHoldSchema, describeDeployHold, type DeployHold } from "@clankie/protocol/integrate";
import { z } from "zod";
import type { machineSetupContext } from "./machine-setup.ts";

const FLEET_USAGE = [
  "Usage: clankie fleet [status|show [--working-directory PATH]]",
  `       clankie fleet set [--notes TEXT] [--closure lead|owner] [--machine-setup lead|owner] [--commit lead|owner] [--push lead|owner] [--release lead|owner|time_rule --release-rule TEXT] [--gate-preset hands-off|balanced|careful] [--everyday-work allow|lead|owner] [--leaves-mac allow|lead|owner] [--hard-to-undo allow|lead|owner] [--money-and-accounts owner] [--tools connected|off] [--peer-messages on|off] [--remote-gates on|off] [--lead-restarts on|off] [--auto-tidy off|30m|1h|4h|1d] [--harness NAME|auto] [--model NAME|auto] [--account LABEL|auto] [--mcp-servers NAME,...|none] [--hire-profile FILE.json]`,
  "       clankie fleet set [--machine ID] [--heavy-slots auto|N] [--simulator-slots auto|N] [--simulator-idle-seconds N] [--max-load-ratio N] [--minimum-free-memory-mb N] [--minimum-free-disk-gb N] [--warn-free-disk-gb N] [--warn-free-disk-percent N]",
  "       clankie fleet resources [--machine ID]",
  "       clankie fleet room [--older CURSOR] [--limit N] [--follow]",
  "       clankie fleet roster [retire SEAT OCCUPANT | undo HISTORY_ID]",
  "       clankie fleet processes [retire]",
  "       clankie fleet clear",
].join("\n");

export type FleetCommandOptions = NonNullable<Parameters<typeof machineSetupContext>[1]> &
  OwnerSettingsApiOptions & {
    readonly settings?: SettingsStore;
    readonly expectedRevision?: string;
    /** Isolated machine registry for integration fixtures. */
    readonly resourceGovernor?: FleetResourceGovernor;
  };

export interface FleetCommandResult {
  readonly ok: true;
  readonly resourceMachines?: string[];
  readonly revision: string;
  readonly fleet: FleetSettings & FleetAutonomy;
  readonly workingPreferences: WorkingPreferencesReport;
  readonly roleProfiles: Array<{
    projectId: string;
    role: string;
    profile: ReturnType<typeof effectiveHireProfile>;
    /** One line naming every unset harness, model and effort as "no preference". */
    summary: string;
  }>;
  readonly retiredWorkingPreferences?: import("@clankie/protocol/projects").RetiredWorkingPreferences;
  readonly settingsFile: string;
  readonly restart: string;
  /** The autonomy dial read back from the leaves; absent from an older service. */
  readonly autonomyLevel?: AutonomyLevelReading;
  /** Status only: who holds deploys, for how long, and how long until each hold lifts. */
  readonly deployHolds?:
    | { readonly holds: ReadonlyArray<DeployHold & { readonly summary: string }> }
    | { readonly unavailable: string };
}

/** Read through runtime-update status: a GET, and holds only matter where updates run. */
async function deployHoldStatus(
  api: OwnerSettingsApi,
): Promise<NonNullable<FleetCommandResult["deployHolds"]>> {
  try {
    const { holds = [] } = await api.get(
      "/v1/runtime-update",
      z.object({ holds: z.array(DeployHoldSchema).optional() }),
    );
    const now = Date.now();
    return { holds: holds.map((hold) => ({ ...hold, summary: describeDeployHold(hold, now) })) };
  } catch (error) {
    // A machine without runtime updates has nothing to hold; its status says so.
    return { unavailable: error instanceof Error ? error.message : String(error) };
  }
}

export function formatDeployHoldLines(deployHolds: FleetCommandResult["deployHolds"]): string[] {
  if (!deployHolds) return [];
  if ("unavailable" in deployHolds) return [`deploy holds: unavailable (${deployHolds.unavailable})`];
  if (!deployHolds.holds.length) return ["deploy holds: none"];
  return ["deploy holds:", ...deployHolds.holds.map((hold) => `  ${hold.id} · ${hold.summary}`)];
}

/** Any subset of the fleet settings; what is left out keeps its current value. */
export type FleetUpdate = Partial<FleetSettings & FleetAutonomy> & { autonomyLevel?: AutonomyLevel };

function store(options: FleetCommandOptions): SettingsStore {
  return options.settings ?? new SettingsStore(defaultSettingsPath(options.env ?? process.env));
}

/**
 * Worker defaults set one field at a time; `auto` leaves the choice to Clankie.
 * `mcpServers` is a comma-separated list, and `none` clears it.
 */
type HirePatch = { [K in "harness" | "model" | "effort" | "account" | "mcpServers"]?: string };

function patchHireDefaults(current: HireProfile | undefined, patch: HirePatch): HireProfile {
  const next: Record<string, unknown> = { ...current };
  delete next.effort;
  for (const [field, value] of Object.entries(patch))
    if (value === "auto" || (field === "mcpServers" && value === "none")) delete next[field];
    else if (field === "mcpServers") next[field] = value!.split(",").map((name) => name.trim());
    else next[field] = value;
  return HireProfileSchema.parse(next);
}

/**
 * `codex · gpt-6 · high · subagents gpt-6-mini`: the fields a role resolves to.
 * An unset harness, model or effort is no preference; Clankie chooses per hire.
 */
function formatHireProfile(profile: HireProfile): string {
  const subagents = profile.subagents;
  return [
    profile.harness ?? "harness: no preference",
    profile.model ?? "model: no preference",
    profile.effort ?? "effort: no preference",
    profile.delegation,
    profile.placement,
    profile.account === undefined ? undefined : `account ${profile.account}`,
    subagents ? `subagents ${[subagents.model, subagents.effort].filter(Boolean).join(" ")}` : undefined,
    profile.mcpServers === undefined ? undefined : `mcp ${profile.mcpServers.join(",")}`,
  ]
    .filter((value) => value !== undefined && value !== "")
    .join(" · ");
}

function formatHireDefaults(hire: HireProfile | undefined): string {
  const { effort: _retiredEffort, ...active } = hire ?? {};
  const fields = Object.entries(active).map(
    ([key, value]) => `${key} ${typeof value === "string" ? value : JSON.stringify(value)}`,
  );
  return fields.length ? fields.join(", ") : "none (he picks harness, model, effort and account per job)";
}

export function formatFleetLines(fleet: FleetSettings & Partial<FleetAutonomy>): string[] {
  const notes = fleet.notes.trim();
  const resources = FleetResourcePolicySchema.parse(fleet.machineResources?.local ?? fleet.resources ?? {});
  return [
    `heavy capacity: ${resources.heavySlots ?? "automatic"} shared slots; simulators: ${resources.simulatorSlots ?? "automatic"}`,
    `simulator idle: ${resources.simulatorIdleMs / 1000}s; load limit: ${resources.maxLoadRatio} per core; minimum available memory: ${resources.minAvailableMemoryMb} MiB; disk floor: ${resources.minFreeDiskGb} GiB; disk warning: ${resources.warnFreeDiskGb} GiB or ${resources.warnFreeDiskPercent}%`,
    ...formatFleetAutonomyGuidance(FleetAutonomySchema.parse(fleetAutonomyFields(fleet))),
    `tools: ${fleet.tools} — ${fleet.tools === "off" ? "fleet tool access disabled" : "every verified connected server through clankie_tools and clankie_call"}`,
    `peer messages: ${fleet.peerMessages} — ${fleet.peerMessages === "off" ? "new messages between fleet workers disabled" : "proven native workers may message their own fleet"}`,
    `remote gates: ${fleet.remoteGates ?? "off"} — ${fleet.remoteGates === "on" ? "integrate gates may run on a linked machine's fleet workspace while this Mac is saturated" : "integrate gates run on this machine"}`,
    `lead restarts: ${fleet.leadRestarts ?? "on"} — ${fleet.leadRestarts === "off" ? "the lead seat keeps its session until someone restarts it" : "an idle lead seat restarts fresh in its pane with a handoff brief once its session is large or a day old"}`,
    `auto tidy: ${fleet.autoTidy ?? "1h"} — ${fleet.autoTidy === "off" ? "finished panes and landed worktrees wait for the lead to tidy them" : `a hire's pane closes after ${fleet.autoTidy ?? "1h"} idle once its reports are read and its work landed; landed, clean worktrees untouched for a day are removed`}`,
    `worker defaults: ${formatHireDefaults(fleet.hire)}`,
    "routing preferences:",
    ...(notes.length === 0
      ? ["  (none — the default: he picks a harness per job on his own)"]
      : notes.split("\n").map((line) => `  ${line}`)),
  ];
}

function fleetAutonomyFields(
  value: Partial<{ [K in keyof FleetAutonomy]: FleetAutonomy[K] | undefined }>,
): Partial<FleetAutonomy> {
  const {
    closure,
    machineSetup,
    commit,
    push,
    release,
    verification,
    reportingStyle,
    everydayWork,
    leavesMac,
    hardToUndo,
    moneyAndAccounts,
  } = value;
  return Object.fromEntries(
    Object.entries({
      closure,
      machineSetup,
      commit,
      push,
      release,
      verification,
      reportingStyle,
      everydayWork,
      leavesMac,
      hardToUndo,
      moneyAndAccounts,
    }).filter(([, value]) => value !== undefined),
  );
}

async function result(
  settings: SettingsStore,
  fleet: FleetSettings,
  options: FleetCommandOptions,
): Promise<Omit<FleetCommandResult, "revision">> {
  const config = await settings.load();
  return {
    ok: true,
    fleet: { ...fleet, ...config.autonomy.fleet },
    workingPreferences: await readWorkingPreferences(options),
    roleProfiles: config.projects.projects.flatMap((p) =>
      (p.roles.length
        ? p.roles
        : ["planner", "designer", "builder", "tester", "reviewer", "researcher"].map((role) => ({ role }))
      ).map((r) => {
        const { effort: _retired, ...defaults } = fleet.hire ?? {};
        const profile = effectiveHireProfile(
          {},
          projectRolePolicy(p, r.role),
          effectiveHireProfile(p.hiring?.worker ?? {}, {}, defaults),
        );
        return { projectId: p.id, role: r.role, profile, summary: formatHireProfile(profile) };
      }),
    ),
    settingsFile: settings.path,
    restart: "clankie restart",
  };
}

export async function fleetStatus(options: FleetCommandOptions = {}): Promise<FleetCommandResult> {
  const settings = store(options);
  const api = await ownerSettingsApi(options);
  const snapshot = await api.get(
    `${FLEET_SETTINGS_PATH}?includeWorkPolicy=true`,
    FleetSettingsSnapshotSchema,
  );
  const report = await result(
    settings,
    FleetSettingsSchema.parse(
      Object.fromEntries(Object.entries(snapshot.fleet).filter(([key]) => key in FleetSettingsSchema.shape)),
    ),
    options,
  );
  return {
    ...report,
    revision: snapshot.revision,
    ...(snapshot.retiredWorkingPreferences
      ? { retiredWorkingPreferences: snapshot.retiredWorkingPreferences }
      : {}),
    ...(snapshot.resourceMachines ? { resourceMachines: snapshot.resourceMachines } : {}),
    fleet: { ...report.fleet, ...FleetAutonomySchema.parse(fleetAutonomyFields(snapshot.fleet)) },
    ...(snapshot.autonomyLevel === undefined ? {} : { autonomyLevel: snapshot.autonomyLevel }),
    deployHolds: await deployHoldStatus(api),
  };
}

/** Merge the given fields into the stored fleet settings; a string alone updates the notes. */
export async function fleetUpdate(
  update: string | FleetUpdate,
  options: FleetCommandOptions = {},
  hirePatch?: HirePatch,
): Promise<FleetCommandResult> {
  const change: FleetUpdate = typeof update === "string" ? { notes: update } : update;
  const settings = store(options);
  const fleetChange = Object.fromEntries(
    Object.entries(change).filter(([key]) => key in FleetSettingsSchema.shape),
  );
  const api = await ownerSettingsApi(options);
  const snapshot = await api.get(
    `${FLEET_SETTINGS_PATH}?includeWorkPolicy=true`,
    FleetSettingsSnapshotSchema,
  );
  const updated = await api.write(
    `${FLEET_SETTINGS_PATH}?includeWorkPolicy=true`,
    {
      schemaVersion: 1,
      expectedRevision: options.expectedRevision ?? snapshot.revision,
      changes: {
        ...fleetChange,
        ...fleetAutonomyFields(change),
        ...(change.autonomyLevel === undefined ? {} : { autonomyLevel: change.autonomyLevel }),
        ...(Object.hasOwn(change, "hire") ? { hire: change.hire ?? null } : {}),
        ...(hirePatch === undefined ? {} : { hire: patchHireDefaults(snapshot.fleet.hire, hirePatch) }),
      },
    },
    FleetSettingsSnapshotSchema,
  );

  const report = await result(
    settings,
    FleetSettingsSchema.parse(
      Object.fromEntries(Object.entries(updated.fleet).filter(([key]) => key in FleetSettingsSchema.shape)),
    ),
    options,
  );
  return {
    ...report,
    revision: updated.revision,
    ...(updated.retiredWorkingPreferences
      ? { retiredWorkingPreferences: updated.retiredWorkingPreferences }
      : {}),
    fleet: { ...report.fleet, ...FleetAutonomySchema.parse(fleetAutonomyFields(updated.fleet)) },
    ...(updated.autonomyLevel === undefined ? {} : { autonomyLevel: updated.autonomyLevel }),
  };
}

const AUTONOMY_USAGE = `Usage: clankie autonomy [status|${AutonomyLevelSchema.options.join("|")}]`;

export interface AutonomyCommandResult {
  readonly ok: true;
  readonly revision: string;
  readonly level: AutonomyLevelReading;
  readonly description: string;
  readonly levels: Record<AutonomyLevel, string>;
  readonly drift?: AutonomyDrift;
}

/** The owner's one autonomy dial (ADR 0263), over the same fleet settings API. */
export async function runAutonomyCommand(
  args: readonly string[],
  options: FleetCommandOptions = {},
): Promise<AutonomyCommandResult> {
  const verb = args[0] ?? "status";
  if (args.length > 1) throw new Error(AUTONOMY_USAGE);
  const api = await ownerSettingsApi(options);
  const snapshot = await api.get(
    `${FLEET_SETTINGS_PATH}?includeWorkPolicy=true`,
    FleetSettingsSnapshotSchema,
  );
  if (snapshot.autonomyLevel === undefined)
    throw new Error("This Clankie service predates the autonomy dial. Update it, then try again.");
  let report = snapshot;
  if (verb !== "status") {
    const level = AutonomyLevelSchema.safeParse(verb);
    if (!level.success) throw new Error(AUTONOMY_USAGE);
    report = await api.write(
      FLEET_SETTINGS_PATH,
      {
        schemaVersion: 1,
        expectedRevision: snapshot.revision,
        changes: { autonomyLevel: level.data },
      },
      FleetSettingsSnapshotSchema,
    );
  }
  if (report.autonomyLevel === undefined)
    throw new Error("This Clankie service predates the autonomy dial. Update it, then try again.");
  return {
    ok: true,
    revision: report.revision,
    level: report.autonomyLevel,
    description: autonomyLevelDescription(report.autonomyLevel, report.autonomyDrift),
    ...(report.autonomyDrift === undefined ? {} : { drift: report.autonomyDrift }),
    levels: Object.fromEntries(
      AutonomyLevelSchema.options.map((level) => [level, AUTONOMY_LEVELS[level].description]),
    ) as Record<AutonomyLevel, string>,
  };
}

export function autonomyLevelDescription(level: AutonomyLevelReading, drift?: AutonomyDrift): string {
  if (level === "custom" && drift !== undefined) return formatAutonomyDrift(drift);
  return level === "custom"
    ? "Custom: individual settings differ from every level. Choose a level to reset them, or keep tuning them under Advanced."
    : `${AUTONOMY_LEVELS[level].label}: ${AUTONOMY_LEVELS[level].description}`;
}

/** `set` takes each flag at most once, each with a value; anything else is a usage error. */
async function parseSet(
  flags: readonly string[],
  resourceDefaults: FleetSettings["resources"],
): Promise<{ change: FleetUpdate; hire: HirePatch }> {
  if (flags.length === 0 || flags.length % 2 !== 0) throw new Error(FLEET_USAGE);
  const change: FleetUpdate = {};
  const hire: HirePatch = {};
  let releaseMode: string | undefined;
  let releaseRule: string | undefined;
  const resources = FleetResourcePolicySchema.parse(resourceDefaults ?? {});
  const resourceFlags = new Set<string>();
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index];
    const value = flags[index + 1] ?? "";
    if (["--size", "--models", "--verification", "--report-style", "--effort"].includes(flag ?? ""))
      throw new Error(
        `${flag} is retired. Saved values remain read-only; use concrete project work policy and per-hire effort.`,
      );
    if (
      [
        "--heavy-slots",
        "--simulator-slots",
        "--simulator-idle-seconds",
        "--max-load-ratio",
        "--minimum-free-memory-mb",
        "--minimum-free-disk-gb",
        "--warn-free-disk-gb",
        "--warn-free-disk-percent",
      ].includes(flag ?? "")
    ) {
      if (resourceFlags.has(flag!)) throw new Error(FLEET_USAGE);
      resourceFlags.add(flag!);
      const number = Number(value);
      if (flag === "--heavy-slots") resources.heavySlots = value === "auto" ? null : number;
      else if (flag === "--simulator-slots") resources.simulatorSlots = value === "auto" ? null : number;
      else if (flag === "--simulator-idle-seconds") resources.simulatorIdleMs = number * 1000;
      else if (flag === "--max-load-ratio") resources.maxLoadRatio = number;
      else if (flag === "--minimum-free-disk-gb") resources.minFreeDiskGb = number;
      else if (flag === "--warn-free-disk-gb") resources.warnFreeDiskGb = number;
      else if (flag === "--warn-free-disk-percent") resources.warnFreeDiskPercent = number;
      else resources.minAvailableMemoryMb = number;
      change.resources = FleetResourcePolicySchema.parse(resources);
    } else if (flag === "--hire-profile" && change.hire === undefined) {
      const text = await readFile(value, "utf8");
      if (Buffer.byteLength(text) > 16 * 1024) throw new Error("Hire profile is too large");
      change.hire = HireProfileSchema.parse(withoutNoPreference(JSON.parse(text)));
    } else if (flag === "--notes" && change.notes === undefined) {
      if (value.length > 4_000) throw new Error("Keep --notes under 4000 characters.");
      change.notes = value;
    } else if (flag === "--closure" && change.closure === undefined) {
      if (value !== "lead" && value !== "owner") throw new Error("--closure must be lead or owner.");
      change.closure = value;
    } else if (flag === "--machine-setup" && change.machineSetup === undefined) {
      if (value !== "lead" && value !== "owner") throw new Error("--machine-setup must be lead or owner.");
      change.machineSetup = value;
    } else if (
      (flag === "--commit" || flag === "--push") &&
      change[flag === "--commit" ? "commit" : "push"] === undefined
    ) {
      if (value !== "lead" && value !== "owner") throw new Error(`${flag} must be lead or owner.`);
      change[flag === "--commit" ? "commit" : "push"] = value;
    } else if (flag === "--release" && releaseMode === undefined) {
      releaseMode = value;
    } else if (flag === "--release-rule" && releaseRule === undefined) {
      releaseRule = value;
    } else if (flag === "--gate-preset") {
      const preset = FLEET_GATE_PRESETS[value as keyof typeof FLEET_GATE_PRESETS];
      if (
        !preset ||
        ["everydayWork", "leavesMac", "hardToUndo", "moneyAndAccounts"].some((field) => field in change)
      )
        throw new Error("Choose one gate preset before individual gate overrides.");
      Object.assign(change, preset.gates);
    } else if (
      ["--everyday-work", "--leaves-mac", "--hard-to-undo", "--money-and-accounts"].includes(flag ?? "")
    ) {
      const field = (
        {
          "--everyday-work": "everydayWork",
          "--leaves-mac": "leavesMac",
          "--hard-to-undo": "hardToUndo",
          "--money-and-accounts": "moneyAndAccounts",
        } as const
      )[flag as "--everyday-work" | "--leaves-mac" | "--hard-to-undo" | "--money-and-accounts"];
      const gate = FleetGateModeSchema.parse(value);
      if (field === "moneyAndAccounts")
        change.moneyAndAccounts = FleetGatesSchema.shape.moneyAndAccounts.parse(gate);
      else change[field] = gate;
    } else if (flag === "--tools" && change.tools === undefined) {
      if (value !== "connected" && value !== "off") throw new Error("--tools must be connected or off.");
      change.tools = value;
    } else if (flag === "--peer-messages" && change.peerMessages === undefined) {
      if (value !== "on" && value !== "off") throw new Error("--peer-messages must be on or off.");
      change.peerMessages = value;
    } else if (flag === "--remote-gates" && change.remoteGates === undefined) {
      if (value !== "on" && value !== "off") throw new Error("--remote-gates must be on or off.");
      change.remoteGates = value;
    } else if (flag === "--lead-restarts" && change.leadRestarts === undefined) {
      if (value !== "on" && value !== "off") throw new Error("--lead-restarts must be on or off.");
      change.leadRestarts = value;
    } else if (flag === "--auto-tidy" && change.autoTidy === undefined) {
      if (!(FLEET_AUTO_TIDY as readonly (string | undefined)[]).includes(value))
        throw new Error(`--auto-tidy must be one of ${FLEET_AUTO_TIDY.join(", ")}.`);
      change.autoTidy = value as (typeof FLEET_AUTO_TIDY)[number];
    } else if (flag === "--harness" && !("harness" in hire) && value) {
      if (value !== "auto" && !(OPERATOR_SEAT_HARNESSES as readonly string[]).includes(value))
        throw new Error(`--harness must be auto or one of ${OPERATOR_SEAT_HARNESSES.join(", ")}.`);
      hire.harness = value;
    } else if (flag === "--account" && !("account" in hire) && value) {
      if (value !== "auto" && !/^[a-z][a-z0-9_-]{0,63}$/u.test(value))
        throw new Error("--account must be auto or an account label.");
      hire.account = value;
    } else if ((flag === "--model" || flag === "--effort") && !(flag.slice(2) in hire) && value) {
      hire[flag.slice(2) as keyof HirePatch] = value;
    } else if (flag === "--mcp-servers" && !("mcpServers" in hire) && value) {
      hire.mcpServers = value;
    } else {
      throw new Error(FLEET_USAGE);
    }
  }
  if (change.hire !== undefined && Object.keys(hire).length)
    throw new Error("Use --hire-profile or --harness/--model/--effort/--account/--mcp-servers, not both.");
  if (releaseMode !== undefined || releaseRule !== undefined)
    change.release = FleetReleasePolicySchema.parse({
      mode: releaseMode,
      ...(releaseRule === undefined ? {} : { rule: releaseRule }),
    });
  return { change, hire };
}

export async function runFleetCommand(
  args: readonly string[],
  options: FleetCommandOptions = {},
): Promise<FleetCommandResult> {
  const verb = args[0];
  if (verb === undefined || verb === "status" || verb === "show") {
    if (args.length <= 1) return await fleetStatus(options);
    if (args.length === 3 && args[1] === "--working-directory" && args[2])
      return await fleetStatus({ ...options, cwd: args[2] });
    throw new Error(FLEET_USAGE);
  }
  // `clear` returns every field to its default: no notes, no plan limit.
  if (verb === "clear" && args.length === 1) {
    const snapshot = await (
      await ownerSettingsApi(options)
    ).get(FLEET_SETTINGS_PATH, FleetSettingsSnapshotSchema);
    const current = snapshot.fleet;
    const { size: _retiredSize, models: _retiredModels, ...fleetDefaults } = FleetSettingsSchema.parse({});
    const {
      verification: _retiredVerification,
      reportingStyle: _retiredStyle,
      ...autonomyDefaults
    } = FleetAutonomySchema.parse({});
    return await fleetUpdate(
      {
        ...fleetDefaults,
        hire: undefined,
        ...autonomyDefaults,
        ...(current.resources === undefined ? {} : { resources: FleetResourcePolicySchema.parse({}) }),
      },
      { ...options, expectedRevision: snapshot.revision },
    );
  }
  if (verb === "set") {
    const snapshot = await (
      await ownerSettingsApi(options)
    ).get(FLEET_SETTINGS_PATH, FleetSettingsSnapshotSchema);
    const selector = args.indexOf("--machine");
    const machine = selector === -1 ? undefined : args[selector + 1];
    if (
      selector !== -1 &&
      (!machine || !snapshot.resourceMachines?.includes(machine === "default" ? "local" : machine))
    )
      throw new Error("Unknown resource machine");
    const canonical = machine === "default" ? "local" : machine;
    const flags = args.slice(1);
    if (selector !== -1) flags.splice(selector - 1, 2);
    const { change, hire } = await parseSet(
      flags,
      canonical === undefined
        ? (snapshot.fleet.machineResources?.local ?? snapshot.fleet.resources)
        : (snapshot.fleet.machineResources?.[canonical] ??
            (canonical === "local" ? snapshot.fleet.resources : undefined)),
    );
    if (canonical !== undefined) {
      if (
        !change.resources ||
        Object.keys(change).some((key) => key !== "resources") ||
        Object.keys(hire).length
      )
        throw new Error("--machine applies only to resource settings");
      change.machineResources = { [canonical]: change.resources };
      delete change.resources;
    }
    return await fleetUpdate(
      change,
      { ...options, expectedRevision: snapshot.revision },
      Object.keys(hire).length ? hire : undefined,
    );
  }
  throw new Error(FLEET_USAGE);
}
