import { readFile, stat } from "node:fs/promises";
import {
  inspectOperatorCredential,
  resolveOperatorCredential,
  type CredentialStore,
} from "@clankie/credential-broker";
import {
  PROJECTS_PATH,
  PROJECT_CREATE_SETTINGS_PATH,
  CreateProjectSettingsSchema,
  readFleetProjectMembership,
  PROJECT_UPDATE_SETTINGS_PATH,
  ProjectsSnapshotSchema,
  UpdateProjectSettingsSchema,
  type ProjectsSnapshot,
} from "@clankie/protocol/projects";
import {
  effectiveFleetAutonomy,
  FLEET_WORKING_PREFERENCE_FIELDS,
  FleetAutonomyPatchSchema,
  FleetGateModeSchema,
  FleetGatesSchema,
  FLEET_GATE_FIELDS,
  FLEET_GATE_PRESETS,
  FleetReleasePolicySchema,
  FleetVerificationSchema,
  FleetReportingStyleSchema,
  FleetWorkingPreferencesSchema,
  type FleetAutonomy,
  type FleetAutonomyPatch,
  type FleetAutonomyWire,
  type FleetAutonomyMode,
} from "@clankie/protocol";
import { commandHost } from "./io.ts";

/** Revision-bearing API client shared by the CLI and the console's /project entry. */
export async function runProjectSettingsCommand(
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    host?: string;
    fetchImpl?: typeof fetch;
    operatorCredentialStore?: CredentialStore;
    includeAutonomy?: boolean;
  } = {},
) {
  if (args[0] === "settings") return runProjectFleetSettings(args, options);
  const membership = args.length === 3 && args[0] === "membership";
  const list = args.length === 1 && args[0] === "list";
  const create = args[0] === "create";
  if (
    !list &&
    !membership &&
    !(
      args.length === 6 &&
      (create || args[0] === "update") &&
      (create ? ["--settings", "--settings-json"] : ["--changes", "--changes-json"]).includes(args[2]!) &&
      args[4] === "--revision"
    )
  )
    throw new Error(
      "Usage: clankie project list | settings PROJECT [--closure lead|owner|inherit] [--machine-setup lead|owner|inherit] [--commit lead|owner|inherit] [--push lead|owner|inherit] [--release lead|owner|time_rule|inherit --release-rule TEXT] [--verification review_and_seal|change_run_read|inherit] [--report-style TEXT|inherit] [--gate-preset hands-off|balanced|careful|inherit] [--everyday-work allow|lead|owner|inherit] [--leaves-mac allow|lead|owner|inherit] [--hard-to-undo allow|lead|owner|inherit] [--money-and-accounts owner|inherit] | create PROJECT --settings FILE.json --revision REVISION | update PROJECT --changes FILE.json --revision REVISION | membership SEAT_ID OCCUPANT_ID",
    );
  let command: unknown;
  if (!list && !membership) {
    const inline = args[2] === "--changes-json" || args[2] === "--settings-json";
    if (!inline && (await stat(args[3]!)).size > 16 * 1024) throw new Error("Project changes are too large");
    const text = inline ? args[3]! : await readFile(args[3]!, "utf8");
    if (Buffer.byteLength(text) > 16 * 1024) throw new Error("Project changes are too large");
    if (create) {
      const proposed: unknown = JSON.parse(text);
      // IDs/revision are explicit command arguments, never silently overridden by a file.
      const fields = CreateProjectSettingsSchema.omit({ projectId: true, expectedRevision: true }).parse(
        proposed,
      );
      command = CreateProjectSettingsSchema.parse({
        ...fields,
        projectId: args[1],
        expectedRevision: args[5],
      });
    } else
      command = UpdateProjectSettingsSchema.parse({
        projectId: args[1],
        expectedRevision: args[5],
        changes: JSON.parse(text),
      });
    if (Buffer.byteLength(JSON.stringify(command)) > 16 * 1024)
      throw new Error("Project changes are too large");
  }
  const auth = {
    env: options.env ?? process.env,
    ...(options.operatorCredentialStore ? { store: options.operatorCredentialStore } : {}),
  };
  if (!["consistent", "store_only"].includes((await inspectOperatorCredential(auth)).consistency))
    throw new Error("Project settings require the canonical operator credential");
  const credential = await resolveOperatorCredential(auth);
  if (!credential) throw new Error("Operator credential unavailable");
  if (membership) {
    const result = await readFleetProjectMembership(
      { schemaVersion: 1, seats: [{ seatId: args[1]!, occupantId: args[2]! }] },
      async (path, body, signal) => {
        const response = await (options.fetchImpl ?? fetch)(new URL(path, commandHost(options)), {
          method: "POST",
          headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          ...(signal === undefined ? {} : { signal }),
        });
        return {
          status: response.status,
          json: async () => {
            const text = await response.text();
            if (Buffer.byteLength(text) > 32 * 1024) throw new Error("Membership response is too large");
            return JSON.parse(text) as unknown;
          },
        };
      },
      AbortSignal.timeout(10000),
    );
    if (!result) throw new Error("This host does not support live project membership reads");
    return result;
  }
  const response = await (options.fetchImpl ?? fetch)(
    new URL(
      `${list ? PROJECTS_PATH : create ? PROJECT_CREATE_SETTINGS_PATH : PROJECT_UPDATE_SETTINGS_PATH}${options.includeAutonomy ? "?includeAutonomy=true" : ""}`,
      commandHost(options),
    ),
    {
      method: list ? "GET" : "POST",
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      ...(list ? {} : { body: JSON.stringify(command) }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (response.status === 409 && create) {
    const body = await response.text();
    let trackerUnavailable = false;
    if (Buffer.byteLength(body) <= 16 * 1024) {
      try {
        trackerUnavailable = JSON.parse(body)?.error === "project_tracker_unavailable";
      } catch {
        /* A malformed refusal cannot become success. */
      }
    }
    throw new Error(
      trackerUnavailable
        ? "The existing .clankie/tracking.json is unavailable or invalid. Set up the tracker separately, then review project creation again; no tracker was created."
        : "Project creation conflicted: recheck the revision, canonical workspace and existing tracker, then review the proposal. No retry was sent.",
    );
  }
  if (response.status === 409)
    throw new Error(
      "Project settings changed or these edits conflict with an assigned role. Read the saved settings and review your changes.",
    );
  if (!response.ok) throw new Error(`Project settings request refused (${response.status})`);
  const text = await response.text();
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error("Project settings response is too large");
  return ProjectsSnapshotSchema.parse(JSON.parse(text));
}

interface ProjectFleetSettingsResult extends ProjectsSnapshot {
  projectId: string;
  fleet: {
    closure: FleetAutonomyMode | "inherit";
    machineSetup: FleetAutonomyMode | "inherit";
    commit?: FleetAutonomy["commit"] | "inherit";
    push?: FleetAutonomy["push"] | "inherit";
    release?: FleetAutonomy["release"] | "inherit";
    verification?: FleetAutonomy["verification"] | "inherit";
    reportingStyle?: string;
    everydayWork?: FleetAutonomy["everydayWork"] | "inherit";
    leavesMac?: FleetAutonomy["leavesMac"] | "inherit";
    hardToUndo?: FleetAutonomy["hardToUndo"] | "inherit";
    moneyAndAccounts?: "owner" | "inherit";
    effective: FleetAutonomyWire;
  };
}

/** Change only the selected project leaves, using the latest revision and owner API. */
async function runProjectFleetSettings(
  args: readonly string[],
  options: Parameters<typeof runProjectSettingsCommand>[1],
): Promise<ProjectFleetSettingsResult> {
  if (!args[1] || args.length % 2 !== 0)
    throw new Error(
      "Usage: clankie project settings PROJECT [--closure lead|owner|inherit] [--machine-setup lead|owner|inherit] [--commit lead|owner|inherit] [--push lead|owner|inherit] [--release lead|owner|time_rule|inherit --release-rule TEXT] [--verification review_and_seal|change_run_read|inherit] [--report-style TEXT|inherit] [--gate-preset hands-off|balanced|careful|inherit] [--everyday-work allow|lead|owner|inherit] [--leaves-mac allow|lead|owner|inherit] [--hard-to-undo allow|lead|owner|inherit] [--money-and-accounts owner|inherit]",
    );
  const changes: FleetAutonomyPatch = {};
  let releaseMode: string | undefined;
  let releaseRule: string | undefined;
  for (let index = 2; index < args.length; index += 2) {
    const field =
      args[index] === "--closure"
        ? "closure"
        : args[index] === "--machine-setup"
          ? "machineSetup"
          : args[index] === "--commit"
            ? "commit"
            : args[index] === "--push"
              ? "push"
              : undefined;
    const value = args[index + 1];
    if (field && !(field in changes) && ["lead", "owner", "inherit"].includes(value ?? ""))
      changes[field] = value === "inherit" ? null : (value as FleetAutonomyMode);
    else if (args[index] === "--release" && releaseMode === undefined) releaseMode = value;
    else if (args[index] === "--release-rule" && releaseRule === undefined) releaseRule = value;
    else if (args[index] === "--verification" && changes.verification === undefined)
      changes.verification = value === "inherit" ? null : FleetVerificationSchema.parse(value);
    else if (args[index] === "--report-style" && changes.reportingStyle === undefined)
      changes.reportingStyle = value === "inherit" ? null : FleetReportingStyleSchema.parse(value);
    else if (args[index] === "--gate-preset") {
      if (FLEET_GATE_FIELDS.some((field) => field in changes))
        throw new Error("Choose one gate preset before individual gate overrides.");
      const preset = FLEET_GATE_PRESETS[value as keyof typeof FLEET_GATE_PRESETS];
      if (value === "inherit") for (const field of FLEET_GATE_FIELDS) changes[field] = null;
      else if (preset) Object.assign(changes, preset.gates);
      else throw new Error("Unsupported gate preset.");
    } else if (
      ["--everyday-work", "--leaves-mac", "--hard-to-undo", "--money-and-accounts"].includes(
        args[index] ?? "",
      )
    ) {
      const gateField = (
        {
          "--everyday-work": "everydayWork",
          "--leaves-mac": "leavesMac",
          "--hard-to-undo": "hardToUndo",
          "--money-and-accounts": "moneyAndAccounts",
        } as const
      )[args[index] as "--everyday-work" | "--leaves-mac" | "--hard-to-undo" | "--money-and-accounts"];
      const gate = value === "inherit" ? null : FleetGateModeSchema.parse(value);
      if (gateField === "moneyAndAccounts")
        changes.moneyAndAccounts = gate === null ? null : FleetGatesSchema.shape.moneyAndAccounts.parse(gate);
      else changes[gateField] = gate;
    } else
      throw new Error("Project fleet settings require each field once with a supported value or inherit.");
  }
  if (releaseMode !== undefined || releaseRule !== undefined) {
    if (releaseMode === "inherit" && releaseRule === undefined) changes.release = null;
    else
      changes.release = FleetReleasePolicySchema.parse({
        mode: releaseMode,
        ...(releaseRule === undefined ? {} : { rule: releaseRule }),
      });
  }
  if (Object.keys(changes).length) FleetAutonomyPatchSchema.parse(changes);
  const client = { ...options, includeAutonomy: true };
  let snapshot = await runProjectSettingsCommand(["list"], client);
  if (!snapshot || !("settings" in snapshot) || snapshot.autonomyDefaults === undefined)
    throw new Error(
      "This service does not expose current fleet autonomy settings; update it before editing project autonomy.",
    );
  if (!snapshot.settings.projects.some((project) => project.id === args[1]))
    throw new Error("Unknown project");
  if (
    FLEET_WORKING_PREFERENCE_FIELDS.some((field) => field in changes) &&
    snapshot.workingPreferences !== true
  )
    throw new Error("This service does not support working preferences; update it before editing them.");
  if (FLEET_GATE_FIELDS.some((field) => field in changes) && snapshot.fleetGates !== true)
    throw new Error("This service does not support fleet gates; update it before editing them.");
  if (Object.keys(changes).length) {
    snapshot = await runProjectSettingsCommand(
      [
        "update",
        args[1]!,
        "--changes-json",
        JSON.stringify({ autonomy: { fleet: changes } }),
        "--revision",
        snapshot.revision,
      ],
      client,
    );
    if (!snapshot || !("settings" in snapshot) || snapshot.autonomyDefaults === undefined)
      throw new Error(
        "Project autonomy was submitted, but current policy could not be read; inspect it before retrying.",
      );
  }
  const project = snapshot.settings.projects.find((entry) => entry.id === args[1]);
  if (!project) throw new Error("Project disappeared; inspect its saved settings.");
  const supported = snapshot.workingPreferences === true;
  if (supported)
    FleetWorkingPreferencesSchema.parse({
      commit: snapshot.autonomyDefaults.fleet.commit,
      push: snapshot.autonomyDefaults.fleet.push,
      release: snapshot.autonomyDefaults.fleet.release,
      verification: snapshot.autonomyDefaults.fleet.verification,
      reportingStyle: snapshot.autonomyDefaults.fleet.reportingStyle,
    });
  const effective = effectiveFleetAutonomy(snapshot.autonomyDefaults, project.autonomy);
  return {
    ...snapshot,
    projectId: project.id,
    fleet: {
      closure: project.autonomy?.fleet?.closure ?? "inherit",
      machineSetup: project.autonomy?.fleet?.machineSetup ?? "inherit",
      ...(supported
        ? {
            commit: project.autonomy?.fleet?.commit ?? "inherit",
            push: project.autonomy?.fleet?.push ?? "inherit",
            release: project.autonomy?.fleet?.release ?? "inherit",
            verification: project.autonomy?.fleet?.verification ?? "inherit",
            reportingStyle: project.autonomy?.fleet?.reportingStyle ?? "inherit",
          }
        : {}),
      ...(snapshot.fleetGates === true
        ? {
            everydayWork: project.autonomy?.fleet?.everydayWork ?? "inherit",
            leavesMac: project.autonomy?.fleet?.leavesMac ?? "inherit",
            hardToUndo: project.autonomy?.fleet?.hardToUndo ?? "inherit",
            moneyAndAccounts: project.autonomy?.fleet?.moneyAndAccounts ?? "inherit",
          }
        : {}),
      effective: supported ? effective : { closure: effective.closure, machineSetup: effective.machineSetup },
    },
  };
}
