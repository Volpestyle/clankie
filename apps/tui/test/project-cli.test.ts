import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import {
  FileCredentialStore,
  mintOperatorToken,
  OPERATOR_CREDENTIAL_PROVIDER_ID,
} from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { runProjectCommand } from "../src/command/project.ts";

it("creates an owner-approved canonical local workspace without grants and rejects duplicate/overlapping paths", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-project-cli-")));
  const settings = new SettingsStore(join(root, "settings.json"));
  const token = mintOperatorToken();
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  await credentials.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: token });
  const options = {
    settings,
    operatorCredentialStore: credentials,
    env: { CLANKIE_OPERATOR_TOKEN: token },
  };
  const repo = join(root, "repo");
  await mkdir(repo);
  const child = join(repo, "child");
  await mkdir(child);
  const alias = join(root, "alias");
  await symlink(repo, alias);
  try {
    await expect(
      runProjectCommand(["add", "kh2", "--workspace", repo], {
        ...options,
        env: { CLANKIE_OPERATOR_TOKEN: "wrong" },
      }),
    ).rejects.toThrow("operator credential");
    await expect(runProjectCommand(["add", "kh2", "--workspace", alias], options)).rejects.toThrow(
      "canonical",
    );
    const result = await runProjectCommand(["add", "kh2", "--workspace", repo], options);
    expect(result.project).toMatchObject({
      id: "kh2",
      grants: [],
      roles: [],
      workspaces: [{ machineId: "local", path: repo }],
    });
    const saved = await settings.load();
    await expect(runProjectCommand(["add", "kh2", "--workspace", repo], options)).rejects.toThrow("overlaps");
    for (const path of [repo, child, root])
      await expect(runProjectCommand(["add", "rivals", "--workspace", path], options)).rejects.toThrow(
        "overlaps",
      );
    expect(await settings.load()).toEqual(saved);
    expect(saved.projects.assignments).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("appends a sibling workspace while preserving the entire existing project and unrelated settings", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-project-append-")));
  const settings = new SettingsStore(join(root, "settings.json"));
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const token = mintOperatorToken();
  await credentials.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: token });
  const options = { settings, operatorCredentialStore: credentials, env: { CLANKIE_OPERATOR_TOKEN: token } };
  const repo = join(root, "repo");
  const worktree = join(root, "worktree");
  await mkdir(repo);
  await mkdir(worktree);
  try {
    await runProjectCommand(["add", "clankie", "--workspace", repo], options);
    await settings.update((current) => ({
      ...current,
      projects: {
        ...current.projects,
        assignments: [{ projectId: "clankie", personaId: "builder-one", role: "builder" }],
        projects: current.projects.projects.map((project) => ({
          ...project,
          name: "Clankie",
          workerCap: 7,
          roles: [
            { role: "builder", harness: "codex", model: "gpt-6-astra", effort: "medium", concurrencyCap: 3 },
          ],
          trackerRef: { workspaceId: "primary", path: ".clankie/tracking.json" },
          labelRoleMap: [{ label: "implementation", role: "builder" }],
          grants: [
            {
              id: "issues",
              server: "linear",
              accountId: "owner",
              tools: [{ name: "get_issue", arguments: {}, forbiddenArguments: [] }],
            },
          ],
        })),
      },
    }));
    const before = await settings.load();
    await expect(
      runProjectCommand(["add", "clankie", "--workspace", worktree], {
        ...options,
        env: { CLANKIE_OPERATOR_TOKEN: "wrong" },
      }),
    ).rejects.toThrow("operator credential");
    expect(await settings.load()).toEqual(before);
    const result = await runProjectCommand(["add", "clankie", "--workspace", worktree], options);
    expect(result.project.workspaces).toHaveLength(2);
    expect(result.project.workspaces[1]).toMatchObject({
      id: expect.stringMatching(/^workspace-[a-f0-9]{48}$/u),
      path: worktree,
    });
    const expected = structuredClone(before);
    expected.projects.projects[0]!.workspaces.push(result.project.workspaces[1]!);
    expect(await settings.load()).toEqual(expected);
    expect(result.project).toEqual(expected.projects.projects[0]);
    await expect(runProjectCommand(["add", "clankie", "--workspace", worktree], options)).rejects.toThrow(
      "overlaps",
    );
    await expect(runProjectCommand(["add", "clankie", "--workspace", root], options)).rejects.toThrow(
      "overlaps",
    );
    expect(await settings.load()).toEqual(expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["settings", "credential"])("refuses an append when %s changes before commit", async (change) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-project-fence-")));
  const settings = new SettingsStore(join(root, "settings.json"));
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const token = mintOperatorToken();
  await credentials.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: token });
  const options = { settings, operatorCredentialStore: credentials, env: { CLANKIE_OPERATOR_TOKEN: token } };
  const repo = join(root, "repo");
  const sibling = join(root, "sibling");
  await mkdir(repo);
  await mkdir(sibling);
  try {
    await runProjectCommand(["add", "clankie", "--workspace", repo], options);
    const before = await settings.load();
    const update = settings.update.bind(settings);
    vi.spyOn(settings, "update").mockImplementation((mutate, guard) =>
      update(mutate, async () => {
        if (change === "settings") {
          await new SettingsStore(settings.path).update((current) => ({
            ...current,
            projects: {
              ...current.projects,
              projects: current.projects.projects.map((p) => ({ ...p, workerCap: 2 })),
            },
          }));
        } else {
          await credentials.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: mintOperatorToken() });
        }
        await guard?.();
      }),
    );
    await expect(runProjectCommand(["add", "clankie", "--workspace", sibling], options)).rejects.toThrow(
      change === "settings" ? "Settings changed" : "credential changed",
    );
    const saved = await settings.load();
    expect(saved.projects.projects[0]!.workspaces).toEqual(before.projects.projects[0]!.workspaces);
    if (change === "settings") expect(saved.projects.projects[0]!.workerCap).toBe(2);
    else expect(saved).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("removes an absent workspace explicitly while preserving policy and other settings", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-project-remove-")));
  const settings = new SettingsStore(join(root, "settings.json"));
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const token = mintOperatorToken();
  await credentials.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: token });
  const options = { settings, operatorCredentialStore: credentials, env: { CLANKIE_OPERATOR_TOKEN: token } };
  const repo = join(root, "repo");
  await mkdir(repo);
  try {
    await runProjectCommand(["add", "clankie", "--workspace", repo], options);
    await rm(repo, { recursive: true });
    const before = await settings.load();
    await expect(
      runProjectCommand(["remove-workspace", "clankie", "--workspace", repo], {
        ...options,
        env: { CLANKIE_OPERATOR_TOKEN: "wrong" },
      }),
    ).rejects.toThrow("operator credential");
    const result = await runProjectCommand(["remove-workspace", "clankie", "--workspace", repo], options);
    expect(result.project.workspaces).toEqual([]);
    before.projects.projects[0]!.workspaces = [];
    expect(await settings.load()).toEqual(before);
    await expect(
      runProjectCommand(["remove-workspace", "clankie", "--workspace", repo], options),
    ).rejects.toThrow("Unknown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("approves and removes exact remote machine/platform paths without consulting the local filesystem", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-project-remote-")));
  const settings = new SettingsStore(join(root, "settings.json"));
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const token = mintOperatorToken();
  await credentials.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: token });
  const options = { settings, operatorCredentialStore: credentials, env: { CLANKIE_OPERATOR_TOKEN: token } };
  const path = "C:\\code\\kh2";
  const args = ["kh2", "--workspace", path, "--machine", "pc", "--platform", "windows"];
  try {
    const added = await runProjectCommand(["add", ...args], options);
    expect(added.project.workspaces[0]).toMatchObject({ machineId: "pc", platform: "windows", path });
    await expect(runProjectCommand(["add", ...args], options)).rejects.toThrow("overlaps");
    await expect(
      runProjectCommand(
        [
          "add",
          "other",
          "--workspace",
          "C:\\code\\kh2\\..\\elsewhere",
          "--machine",
          "pc",
          "--platform",
          "windows",
        ],
        options,
      ),
    ).rejects.toThrow("canonical");
    await expect(
      runProjectCommand(
        ["remove-workspace", "kh2", "--workspace", path, "--machine", "other-pc", "--platform", "windows"],
        options,
      ),
    ).rejects.toThrow("Unknown");
    expect((await runProjectCommand(["remove-workspace", ...args], options)).project.workspaces).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
