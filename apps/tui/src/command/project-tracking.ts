import {
  PROJECT_TRACKING_APPLY_PATH,
  PROJECT_TRACKING_PATH,
  ProjectTrackingApplyResultSchema,
  ProjectTrackingSchema,
  ProjectTrackingViewSchema,
  trackerChangeOffer,
  type ProjectTracking,
} from "@clankie/protocol/project-tracking";
import { ownerSettingsApi, type OwnerSettingsApiOptions } from "./owner-settings-api.ts";
import { runProjectSettingsCommand } from "./project-settings.ts";

const USAGE =
  "Usage: clankie project tracking PROJECT [apply | clear | [--provider github|linear] [--public-board BOARD] [--private-board BOARD] [--repo OWNER/NAME]... [--no-apply] | --accept-suggestion]";

const VALUE_FLAGS = new Set(["--provider", "--public-board", "--private-board", "--repo"]);

function parseFlags(args: readonly string[]) {
  const values = new Map<string, string>();
  const repos: string[] = [];
  let acceptSuggestion = false;
  let apply = true;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === "--accept-suggestion") acceptSuggestion = true;
    else if (flag === "--no-apply") apply = false;
    else {
      const value = args[++index];
      if (!VALUE_FLAGS.has(flag) || value === undefined) throw new Error(USAGE);
      if (flag === "--repo") repos.push(value);
      else if (values.has(flag)) throw new Error(USAGE);
      else values.set(flag, value);
    }
  }
  return { values, repos, acceptSuggestion, apply };
}

/** Save the whole setting through the revision-bearing project route, then propose it. */
export async function runProjectTrackingCommand(
  args: readonly string[],
  options: OwnerSettingsApiOptions = {},
) {
  const projectId = args[1];
  if (args[0] !== "tracking" || !projectId) throw new Error(USAGE);
  const api = await ownerSettingsApi(options);
  const view = () =>
    api.get(
      `${PROJECT_TRACKING_PATH}?${new URLSearchParams({ projectId }).toString()}`,
      ProjectTrackingViewSchema,
    );
  const apply = (expectedRevision: string) =>
    api.write(PROJECT_TRACKING_APPLY_PATH, { projectId, expectedRevision }, ProjectTrackingApplyResultSchema);
  const rest = args.slice(2);
  if (rest.length === 0) return view();
  const read = async () => {
    const snapshot = await runProjectSettingsCommand(["list"], options);
    if (!("revision" in snapshot) || !("settings" in snapshot))
      throw new Error("Project settings unavailable");
    const project = snapshot.settings.projects.find((saved) => saved.id === projectId);
    if (!project) throw new Error(`Unknown project ${projectId}`);
    return { revision: snapshot.revision, saved: project.tracking };
  };
  const save = async (revision: string, tracking: ProjectTracking | null) => {
    const updated = await runProjectSettingsCommand(
      ["update", projectId, "--changes-json", JSON.stringify({ tracking }), "--revision", revision],
      options,
    );
    if (!("revision" in updated)) throw new Error("Project settings unavailable");
    return updated.revision;
  };
  if (rest.length === 1 && rest[0] === "apply") return apply((await read()).revision);
  if (rest.length === 1 && rest[0] === "clear") {
    const { revision } = await read();
    await save(revision, null);
    return {
      projectId,
      note: "Clankie stopped managing the blocks. The blocks already in the repos stay until you remove them.",
    };
  }
  const { values, repos, acceptSuggestion, apply: applyAfter } = parseFlags(rest);
  // A suggestion is read from repo content, so it is only ever shown: the owner types the values.
  if (acceptSuggestion) {
    const { suggestion } = await view();
    return {
      projectId,
      ...(suggestion ? { suggestion } : {}),
      note: "Nothing was saved. Set what you want with --provider, --public-board, --private-board and --repo.",
    };
  }
  const { revision, saved } = await read();
  const tracking = ProjectTrackingSchema.safeParse({
    repos: repos.length > 0 ? repos : saved?.repos,
    tracker: {
      provider: values.get("--provider") ?? saved?.tracker.provider,
      publicBoard: values.get("--public-board") ?? saved?.tracker.publicBoard,
      privateBoard: values.get("--private-board") ?? saved?.tracker.privateBoard,
    },
  });
  if (!tracking.success)
    throw new Error(
      `Tracking needs at least one repo (owner/name), a provider and both boards: ${tracking.error.issues
        .map((issue) => `${issue.path.join(".") || "tracking"}: ${issue.message}`)
        .join("; ")}`,
    );
  const nextRevision = await save(revision, tracking.data);
  const offer = trackerChangeOffer(saved, tracking.data);
  return {
    projectId,
    tracking: tracking.data,
    ...(offer ? { offer } : {}),
    ...(applyAfter ? { repos: (await apply(nextRevision)).repos } : {}),
  };
}
