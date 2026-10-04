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
  PROJECT_UPDATE_SETTINGS_PATH,
  ProjectsSnapshotSchema,
  UpdateProjectSettingsSchema,
} from "@clankie/protocol/projects";
import { commandHost } from "./io.ts";

/** Revision-bearing API client shared by the CLI and the console's /project entry. */
export async function runProjectSettingsCommand(
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    host?: string;
    fetchImpl?: typeof fetch;
    operatorCredentialStore?: CredentialStore;
  } = {},
) {
  const list = args.length === 1 && args[0] === "list";
  const create = args[0] === "create";
  if (
    !list &&
    !(
      args.length === 6 &&
      (create || args[0] === "update") &&
      args[2] === (create ? "--settings" : "--changes") &&
      args[4] === "--revision"
    )
  )
    throw new Error(
      "Usage: clankie project list | create PROJECT --settings FILE.json --revision REVISION | update PROJECT --changes FILE.json --revision REVISION",
    );
  let command: unknown;
  if (!list) {
    if ((await stat(args[3]!)).size > 16 * 1024) throw new Error("Project changes are too large");
    const text = await readFile(args[3]!, "utf8");
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
  const response = await (options.fetchImpl ?? fetch)(
    new URL(
      list ? PROJECTS_PATH : create ? PROJECT_CREATE_SETTINGS_PATH : PROJECT_UPDATE_SETTINGS_PATH,
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
