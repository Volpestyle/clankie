import { readFile, stat } from "node:fs/promises";
import {
  inspectOperatorCredential,
  resolveOperatorCredential,
  type CredentialStore,
} from "@clankie/credential-broker";
import {
  PROJECTS_PATH,
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
  if (
    !list &&
    !(args.length === 6 && args[0] === "update" && args[2] === "--changes" && args[4] === "--revision")
  )
    throw new Error("Usage: clankie project list | update PROJECT --changes FILE.json --revision REVISION");
  let command: unknown;
  if (!list) {
    if ((await stat(args[3]!)).size > 16 * 1024) throw new Error("Project changes are too large");
    const text = await readFile(args[3]!, "utf8");
    if (Buffer.byteLength(text) > 16 * 1024) throw new Error("Project changes are too large");
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
    new URL(list ? PROJECTS_PATH : PROJECT_UPDATE_SETTINGS_PATH, commandHost(options)),
    {
      method: list ? "GET" : "POST",
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      ...(list ? {} : { body: JSON.stringify(command) }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (response.status === 409)
    throw new Error(
      "Project settings changed or these edits conflict with an assigned role. Read the saved settings and review your changes.",
    );
  if (!response.ok) throw new Error(`Project settings request refused (${response.status})`);
  const text = await response.text();
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error("Project settings response is too large");
  return ProjectsSnapshotSchema.parse(JSON.parse(text));
}
