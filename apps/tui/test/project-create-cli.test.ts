import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  FileCredentialStore,
  mintOperatorToken,
  OPERATOR_CREDENTIAL_PROVIDER_ID,
} from "@clankie/credential-broker";
import { PROJECT_CREATE_SETTINGS_PATH, ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { runHeadlessCaptainCommand } from "../bin/headless-captain.ts";
import * as projectSettings from "../src/command/project-settings.ts";
import { buildConsoleCommands } from "../src/commands.ts";
import type { ClankieFaceShell } from "../src/shell/shell.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "project-create-cli-"));
  roots.push(root);
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const token = mintOperatorToken();
  await credentials.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: token });
  const proposal = {
    name: "Garden",
    workspacePath: "/fixture/garden",
    workerCap: 0,
    roles: [{ role: "builder", concurrencyCap: null }],
    fleet: { size: "large" },
  };
  const file = join(root, "proposal with spaces.json");
  await writeFile(file, JSON.stringify(proposal));
  const snapshot = {
    revision: "b".repeat(64),
    settings: ProjectsSettingsSchema.parse({ projects: [{ id: "garden", name: "Garden" }] }),
  };
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    Response.json(snapshot, { status: 201 }),
  );
  const options = {
    env: { CLANKIE_OPERATOR_TOKEN: token },
    operatorCredentialStore: credentials,
    host: "http://127.0.0.1:1",
    fetchImpl,
  };
  const args = ["create", "garden", "--settings", file, "--revision", "a".repeat(64)];
  return { file, proposal, token, snapshot, fetchImpl, options, args };
}
it("the headless create command sends explicit reviewed settings/revision through the owner API once", async () => {
  const f = await fixture();
  let output = "";
  expect(
    await runHeadlessCaptainCommand(["project", ...f.args], {
      ...f.options,
      repoRoot: "/unused",
      stdout: {
        write: (value) => {
          output += value;
        },
      },
    }),
  ).toBe(0);
  expect(JSON.parse(output)).toEqual(f.snapshot);
  expect(f.fetchImpl).toHaveBeenCalledOnce();
  const [url, init] = f.fetchImpl.mock.calls[0]!;
  expect(new URL(String(url)).pathname).toBe(PROJECT_CREATE_SETTINGS_PATH);
  expect(JSON.parse(init!.body as string)).toEqual({
    ...f.proposal,
    projectId: "garden",
    expectedRevision: "a".repeat(64),
  });
  expect(new Headers(init!.headers).get("authorization")).toBe(`Bearer ${f.token}`);
});
it.each([
  { projectId: "overwrite" },
  { expectedRevision: "b".repeat(64) },
  { machineId: "remote" },
  { grants: [] },
  { workspaces: [] },
])("rejects hidden authority or command overrides in a proposal: %j", async (extra) => {
  const f = await fixture();
  await writeFile(f.file, JSON.stringify({ ...f.proposal, ...extra }));
  await expect(projectSettings.runProjectSettingsCommand(f.args, f.options)).rejects.toThrow();
  expect(f.fetchImpl).not.toHaveBeenCalled();
});
it.each([401, 403, 409])("does not retry a refused create (%s)", async (status) => {
  const f = await fixture();
  f.fetchImpl.mockResolvedValueOnce(Response.json({ error: "project_create_conflict" }, { status }));
  await expect(projectSettings.runProjectSettingsCommand(f.args, f.options)).rejects.toThrow();
  expect(f.fetchImpl).toHaveBeenCalledOnce();
});
it("requires the canonical broker credential before making a create request", async () => {
  const f = await fixture();
  await expect(
    projectSettings.runProjectSettingsCommand(f.args, {
      ...f.options,
      env: { CLANKIE_OPERATOR_TOKEN: "wrong" },
    }),
  ).rejects.toThrow("canonical operator credential");
  expect(f.fetchImpl).not.toHaveBeenCalled();
});
it("the TUI /project create passes quoted arguments to the same client and surfaces refusal", async () => {
  const f = await fixture();
  const run = vi.spyOn(projectSettings, "runProjectSettingsCommand").mockResolvedValue(f.snapshot);
  const insertCommandResult = vi.fn();
  const shell = { insertCommandResult } as unknown as ClankieFaceShell;
  const command = buildConsoleCommands({}).find((item) => item.name === "project")!;
  await command.run(`create garden --settings "${f.file}" --revision ${"a".repeat(64)}`, shell);
  expect(run).toHaveBeenCalledWith(f.args);
  expect(insertCommandResult).toHaveBeenLastCalledWith(
    "/project",
    JSON.stringify(f.snapshot, null, 2),
    "success",
  );
  run.mockRejectedValueOnce(new Error("Project creation conflicted"));
  await command.run(`create garden --settings "${f.file}" --revision ${"a".repeat(64)}`, shell);
  expect(insertCommandResult).toHaveBeenLastCalledWith("/project", "Project creation conflicted", "error");
  expect(run).toHaveBeenCalledTimes(2);
});

it("reports an unavailable existing tracker explicitly without retry or setup", async () => {
  const f = await fixture();
  f.fetchImpl.mockResolvedValueOnce(Response.json({ error: "project_tracker_unavailable" }, { status: 409 }));
  await expect(projectSettings.runProjectSettingsCommand(f.args, f.options)).rejects.toThrow(
    "no tracker was created",
  );
  expect(f.fetchImpl).toHaveBeenCalledOnce();
});
