import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  FileCredentialStore,
  mintOperatorToken,
  OPERATOR_CREDENTIAL_PROVIDER_ID,
} from "@clankie/credential-broker";
import {
  ProjectsSettingsSchema,
  PROJECTS_PATH,
  PROJECT_ADD_WORKTREE_ROOT_PATH,
  PROJECT_REMOVE_WORKTREE_ROOT_PATH,
} from "@clankie/protocol/projects";
import { projectsRevision } from "@clankie/settings";
import { runProjectCommand } from "../src/command/project.ts";

it("CLI uses owner API revision and native remote observation rather than approving filesystem strings locally", async () => {
  const directory = await mkdtemp(join(tmpdir(), "worktree-cli-"));
  try {
    const credentials = new FileCredentialStore(join(directory, "credentials.json"));
    const token = mintOperatorToken();
    await credentials.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: token });
    const settings = ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "repo",
          name: "Repo",
          workspaces: [{ id: "main", machineId: "pc", platform: "windows", path: "D:\\repo" }],
          worktreeRoots: [
            {
              id: "root",
              machineId: "pc",
              platform: "windows",
              path: "D:\\worktrees",
              repoPath: "D:\\repo",
              commonDirectory: "D:\\repo\\.git",
            },
          ],
        },
      ],
    });
    const calls: { path: string; body?: unknown }[] = [];
    const fetchImpl = (async (url: URL | RequestInfo, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      const path = new URL(String(url)).pathname;
      calls.push({ path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      return Response.json({ settings, revision: projectsRevision(settings) });
    }) as typeof fetch;
    const options = {
      env: { CLANKIE_OPERATOR_TOKEN: token },
      operatorCredentialStore: credentials,
      fetchImpl,
      host: "http://127.0.0.1:1",
    };
    await runProjectCommand(
      [
        "add",
        "repo",
        "--worktree-root",
        "D:\\worktrees",
        "--repo",
        "D:\\repo",
        "--machine",
        "pc",
        "--platform",
        "windows",
      ],
      options,
    );
    await runProjectCommand(
      [
        "remove-worktree-root",
        "repo",
        "--worktree-root",
        "D:\\worktrees",
        "--machine",
        "pc",
        "--platform",
        "windows",
      ],
      options,
    );
    expect(calls).toEqual([
      { path: PROJECTS_PATH },
      {
        path: PROJECT_ADD_WORKTREE_ROOT_PATH,
        body: {
          projectId: "repo",
          machineId: "pc",
          platform: "windows",
          path: "D:\\worktrees",
          repoPath: "D:\\repo",
          expectedRevision: projectsRevision(settings),
        },
      },
      { path: PROJECTS_PATH },
      {
        path: PROJECT_REMOVE_WORKTREE_ROOT_PATH,
        body: { projectId: "repo", rootId: "root", expectedRevision: projectsRevision(settings) },
      },
    ]);
    await expect(
      runProjectCommand(["add", "repo", "--worktree-root", "/root", "--repo", "/repo"], {
        ...options,
        env: { CLANKIE_OPERATOR_TOKEN: "wrong" },
      }),
    ).rejects.toThrow("canonical operator");
    expect(calls).toHaveLength(4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("ordinary workspace approval cannot cross another project's enrolled root", async () => {
  const { mkdir, realpath } = await import("node:fs/promises");
  const { SettingsStore } = await import("@clankie/settings");
  const directory = await realpath(await mkdtemp(join(tmpdir(), "worktree-cli-overlap-")));
  try {
    const root = join(directory, "worktrees");
    const child = join(root, "child");
    await mkdir(child, { recursive: true });
    const credentials = new FileCredentialStore(join(directory, "credentials.json"));
    const token = mintOperatorToken();
    await credentials.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: token });
    const settings = new SettingsStore(join(directory, "settings.json"));
    await settings.update((current) => ({
      ...current,
      projects: ProjectsSettingsSchema.parse({
        projects: [
          {
            id: "repo",
            name: "Repo",
            worktreeRoots: [
              {
                id: "root",
                machineId: "local",
                platform: "posix",
                path: root,
                repoPath: join(directory, "repo"),
                commonDirectory: join(directory, "repo", ".git"),
              },
            ],
          },
        ],
      }),
    }));
    await expect(
      runProjectCommand(["add", "foreign", "--workspace", child], {
        settings,
        operatorCredentialStore: credentials,
        env: { CLANKIE_OPERATOR_TOKEN: token },
      }),
    ).rejects.toThrow("overlaps");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
