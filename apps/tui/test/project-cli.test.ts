import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
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
    await expect(runProjectCommand(["add", "kh2", "--workspace", repo], options)).rejects.toThrow(
      "already exists",
    );
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
