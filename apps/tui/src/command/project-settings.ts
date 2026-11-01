import { workTrackerSettings } from "./work-tracker.ts";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { linkedRepoRefusal } from "@clankie/settings";
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
  ProjectFocusSchema,
  ProjectWipCapSchema,
  ProjectOwnerLoopSchema,
  LinearProjectBindingSchema,
  type UpdateProjectSettings,
  type ProjectLinkedRepo,
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
  FleetWorkingPreferencesSchema,
  type FleetAutonomy,
  type FleetAutonomyPatch,
  type FleetAutonomyWire,
  type FleetAutonomyMode,
} from "@clankie/protocol";
import { ProjectReviewSchema } from "@clankie/protocol/reviews";
import {
  DEFAULT_TRACKER_POSTING,
  TRACKER_POSTING_MODES,
  TrackerPostingSchema,
  type TrackerPosting,
} from "@clankie/protocol/tracker-posting";
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
    includeWorkPolicy?: boolean;
    /** Ask for the project view's warnings (stale reviewer seat, questions outside every project). */
    includeHealth?: boolean;
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
      "Usage: clankie project list | settings PROJECT [--closure lead|owner|inherit] [--machine-setup lead|owner|inherit] [--commit lead|owner|inherit] [--push lead|owner|inherit] [--release lead|owner|time_rule|inherit --release-rule TEXT] [--gate-preset hands-off|balanced|careful|inherit] [--everyday-work allow|lead|owner|inherit] [--leaves-mac allow|lead|owner|inherit] [--hard-to-undo allow|lead|owner|inherit] [--money-and-accounts owner|inherit] [--wip-cap 1..1000|none] [--owner-loop silent|milestones|landings|inherit] [--auto on|off] [--auto-updates on|off] [--focus TEXT|clear] [--tracker-project UUID|clear] [--linear-project UUID|clear] [--link-repo PATH]... [--unlink-repo PATH]... [--posting read-only|ask|lead|allow|default] | create PROJECT --settings FILE.json --revision REVISION | update PROJECT --changes FILE.json --revision REVISION | membership SEAT_ID OCCUPANT_ID",
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
      `${list ? PROJECTS_PATH : create ? PROJECT_CREATE_SETTINGS_PATH : PROJECT_UPDATE_SETTINGS_PATH}?${new URLSearchParams(
        {
          ...((options.includeAutonomy ?? true) ? { includeAutonomy: "true" } : {}),
          ...((options.includeWorkPolicy ?? options.includeAutonomy ?? true)
            ? {
                includeWorkPolicy: "true",
                includeAutoUpdates: "true",
                includeReview: "true",
                includeTrackerPosting: "true",
              }
            : {}),
          ...(options.includeHealth ? { includeHealth: "true" } : {}),
        },
      ).toString()}`,
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
  /** Present when the service supports project Auto (ADR 0264). */
  auto?: boolean;
  focus?: string;
  trackerProjectId?: string;
  workTracker?: Awaited<ReturnType<typeof workTrackerSettings>> | undefined;
  /** Read-only repos this project's reviews and churn may read; present when the service supports them. */
  linkedRepoPaths?: string[];
  /** "Posting to your tracker" (ADR 0302); present when the service supports it. */
  posting?: {
    saved: TrackerPosting | "default";
    effective: TrackerPosting;
    label: string;
    appliesTo: string;
  };
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
export async function runProjectFleetSettings(
  args: readonly string[],
  options: Parameters<typeof runProjectSettingsCommand>[1],
): Promise<ProjectFleetSettingsResult> {
  let workTracker: Awaited<ReturnType<typeof workTrackerSettings>> | undefined;
  if (args[2] === "tracker" || args[2] === "--tracker") {
    workTracker = await workTrackerSettings(args.slice(3), options, args[1]);
    args = args.slice(0, 2);
  }
  // `posting VALUE` reads like `tracker ...`; it is the same leaf as `--posting VALUE`.
  if (args[2] === "posting") args = [args[0]!, args[1]!, "--posting", ...args.slice(3)];
  if (!args[1] || args.length % 2 !== 0)
    throw new Error(
      "Usage: clankie project settings PROJECT [--closure lead|owner|inherit] [--machine-setup lead|owner|inherit] [--commit lead|owner|inherit] [--push lead|owner|inherit] [--release lead|owner|time_rule|inherit --release-rule TEXT] [--gate-preset hands-off|balanced|careful|inherit] [--everyday-work allow|lead|owner|inherit] [--leaves-mac allow|lead|owner|inherit] [--hard-to-undo allow|lead|owner|inherit] [--money-and-accounts owner|inherit] [--wip-cap 1..1000|none] [--owner-loop silent|milestones|landings|inherit] [--auto on|off] [--auto-updates on|off] [--focus TEXT|clear] [--tracker-project UUID|clear] [--linear-project UUID|clear] [--link-repo PATH]... [--unlink-repo PATH]... [--reviewer-seat SEAT|--reviewer-role ROLE|--reviewer none] [--posting read-only|ask|lead|allow|default]",
    );
  const changes: FleetAutonomyPatch = {};
  const work: Pick<
    UpdateProjectSettings["changes"],
    | "auto"
    | "autoUpdates"
    | "focus"
    | "trackerProjectId"
    | "linearProjectBinding"
    | "wipCap"
    | "ownerLoop"
    | "review"
    | "linkedRepos"
    | "trackerPosting"
  > = {};
  let releaseMode: string | undefined;
  let releaseRule: string | undefined;
  const link: string[] = [];
  const unlink: string[] = [];
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
    if (["--verification", "--report-style"].includes(args[index] ?? ""))
      throw new Error(`${args[index]} is retired; saved values remain read-only.`);
    if (field && !(field in changes) && ["lead", "owner", "inherit"].includes(value ?? ""))
      changes[field] = value === "inherit" ? null : (value as FleetAutonomyMode);
    else if (args[index] === "--auto" && work.auto === undefined && (value === "on" || value === "off"))
      work.auto = value === "on";
    else if (
      args[index] === "--auto-updates" &&
      work.autoUpdates === undefined &&
      (value === "on" || value === "off")
    )
      work.autoUpdates = value === "on";
    else if (args[index] === "--focus" && work.focus === undefined)
      work.focus = value === "clear" ? null : ProjectFocusSchema.parse(value);
    else if (args[index] === "--wip-cap" && work.wipCap === undefined)
      work.wipCap = value === "none" ? null : ProjectWipCapSchema.parse(Number(value));
    else if (args[index] === "--owner-loop" && work.ownerLoop === undefined)
      work.ownerLoop = value === "inherit" ? null : ProjectOwnerLoopSchema.parse(value);
    else if (args[index] === "--tracker-project" && work.trackerProjectId === undefined)
      work.trackerProjectId =
        value === "clear"
          ? null
          : UpdateProjectSettingsSchema.shape.changes.shape.trackerProjectId.parse(value);
    else if (args[index] === "--linear-project" && work.linearProjectBinding === undefined)
      work.linearProjectBinding =
        value === "clear" ? null : LinearProjectBindingSchema.parse({ provider: "linear", projectId: value });
    else if (args[index] === "--reviewer-seat" && work.review === undefined)
      work.review = ProjectReviewSchema.parse({ seat: value });
    else if (args[index] === "--reviewer-role" && work.review === undefined)
      work.review = ProjectReviewSchema.parse({ role: value });
    else if (args[index] === "--reviewer" && work.review === undefined && value === "none")
      work.review = null;
    else if (args[index] === "--posting" && work.trackerPosting === undefined) {
      if (value === "default" || value === "inherit") work.trackerPosting = null;
      else {
        const posting = TrackerPostingSchema.safeParse(value === "read-only" ? "read_only" : value);
        if (!posting.success) throw new Error("--posting takes read-only, ask, lead, allow or default.");
        work.trackerPosting = posting.data;
      }
    } else if ((args[index] === "--link-repo" || args[index] === "--unlink-repo") && value)
      // Owner workspaces are saved canonical; a path that no longer exists keeps its spelling.
      (args[index] === "--link-repo" ? link : unlink).push(await realpath(value).catch(() => resolve(value)));
    else if (args[index] === "--release" && releaseMode === undefined) releaseMode = value;
    else if (args[index] === "--release-rule" && releaseRule === undefined) releaseRule = value;
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
  let snapshot = await runProjectSettingsCommand(["list"], { ...client, includeHealth: true });
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
  if (("auto" in work || "focus" in work) && snapshot.projectsAuto !== true)
    throw new Error("This service does not support project Auto; update it before editing Auto or focus.");
  if ("linearProjectBinding" in work && snapshot.linearProjectBindings !== true)
    throw new Error("This service does not support Linear project bindings; update it before editing them.");
  if ("autoUpdates" in work && snapshot.projectAutoUpdates !== true)
    throw new Error(
      "This service does not support automatic project updates; update it before editing them.",
    );
  if ("trackerPosting" in work && snapshot.projectTrackerPosting !== true)
    throw new Error(
      "This service does not support the Posting to your tracker setting; update it before changing it.",
    );
  if ("review" in work && snapshot.projectReview !== true)
    throw new Error("This service does not support project reviewers; update it before setting one.");
  if (("wipCap" in work || "ownerLoop" in work) && snapshot.projectWorkPolicy !== true)
    throw new Error("This service does not support project work policy; update it before editing it.");
  if (link.length || unlink.length) {
    if (snapshot.linkedRepos !== true)
      throw new Error("This service does not support linked repos; update it before linking one.");
    const platform = process.platform === "win32" ? "windows" : "posix";
    const saved = snapshot.settings.projects.find((project) => project.id === args[1])!.linkedRepos ?? [];
    const named = (repo: ProjectLinkedRepo, path: string) =>
      repo.machineId === "local" && repo.platform === platform && repo.path === path;
    for (const path of unlink)
      if (!saved.some((repo) => named(repo, path))) throw new Error(`${path} is not a linked repo`);
    const linkedRepos = saved.filter((repo) => !unlink.some((path) => named(repo, path)));
    for (const path of link) {
      const repo = { machineId: "local", platform, path } as const;
      const refusal = linkedRepoRefusal(snapshot.settings, args[1]!, repo);
      if (refusal !== undefined) throw new Error(`Cannot link ${path}: ${refusal}`);
      if (!linkedRepos.some((entry) => named(entry, path))) linkedRepos.push(repo);
    }
    work.linkedRepos = linkedRepos.length ? linkedRepos : null;
  }
  if (Object.keys(changes).length || Object.keys(work).length) {
    snapshot = await runProjectSettingsCommand(
      [
        "update",
        args[1]!,
        "--changes-json",
        JSON.stringify({ ...(Object.keys(changes).length ? { autonomy: { fleet: changes } } : {}), ...work }),
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
    // allow-swallowed-rejection -- Older services lack this additive read; existing project settings still work.
    workTracker: workTracker ?? (await workTrackerSettings([], options, project.id).catch(() => undefined)),
    ...(project.trackerProjectId === undefined ? {} : { trackerProjectId: project.trackerProjectId }),
    ...(snapshot.projectsAuto === true
      ? { auto: project.auto === true, ...(project.focus === undefined ? {} : { focus: project.focus }) }
      : {}),
    ...(snapshot.projectReview === true ? { reviewer: project.review ?? "none" } : {}),
    ...(snapshot.projectTrackerPosting === true
      ? {
          posting: {
            saved: project.trackerPosting ?? "default",
            effective: project.trackerPosting ?? DEFAULT_TRACKER_POSTING,
            label: TRACKER_POSTING_MODES[project.trackerPosting ?? DEFAULT_TRACKER_POSTING].label,
            appliesTo:
              "Linear and GitHub issues; private issue files and the built-in tracker stay on this Mac and are always writable.",
          },
        }
      : {}),
    ...(snapshot.linkedRepos === true
      ? { linkedRepoPaths: (project.linkedRepos ?? []).map((repo) => repo.path) }
      : {}),
    // Every seat already working here can submit, including ones hired before the reviewer (VUH-2662).
    ...(snapshot.projectReview === true && project.review !== undefined
      ? {
          reviewSubmit:
            "Authors submit with submit_for_review and their checkout. A seat whose catalog lacks that tool (a harness without it, or a bridge started before it) runs `clankie review submit --checkout DIR --summary TEXT --issue KEY` from its own pane.",
        }
      : {}),
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
