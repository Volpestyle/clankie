import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  FileCredentialStore,
  mintOperatorToken,
  OPERATOR_CREDENTIAL_PROVIDER_ID,
} from "@clankie/credential-broker";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { runAgentsCommand } from "../src/command/agents.ts";
import { runClaudeAccountsCommand } from "../src/command/claude-accounts.ts";
import { SettingsStore } from "@clankie/settings";

it("edits the whole role through the owner revision API, preserving unrelated roles and rejecting unknown models", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hire-profile-cli-"));
  try {
    const credentials = new FileCredentialStore(join(dir, "credentials.json"));
    const token = mintOperatorToken();
    await credentials.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: token });
    const catalog = join(dir, "models.json");
    await writeFile(
      catalog,
      JSON.stringify({ openai: { models: { "gpt-6.1-sol": { id: "gpt-6.1-sol", name: "GPT-6.1-Sol" } } } }),
    );
    const snapshot = {
      revision: "a".repeat(64),
      settings: ProjectsSettingsSchema.parse({
        projects: [
          {
            id: "game",
            name: "Game",
            roles: [
              { role: "implementer", hireNaming: "Keep", concurrencyCap: 2 },
              { role: "reviewer", model: "kept" },
            ],
          },
        ],
      }),
    };
    const fetchImpl = vi.fn(async () => Response.json(snapshot));
    const options = {
      env: { CLANKIE_OPERATOR_TOKEN: token, CLANKIE_MODELS_PATH: catalog },
      operatorCredentialStore: credentials,
      host: "http://127.0.0.1:1",
      fetchImpl,
    };
    await runAgentsCommand(
      [
        "role",
        "implementer",
        "--project",
        "game",
        "--harness",
        "codex",
        "--model",
        "sol 6.1",
        "--effort",
        "xhigh",
        "--subagent-model",
        "sol 6.1",
        "--subagent-effort",
        "medium",
        "--delegation",
        "native-first",
        "--account",
        "second",
        "--placement",
        "new-tab",
      ],
      options,
    );
    const body = JSON.parse((fetchImpl.mock.calls[1] as unknown as [unknown, RequestInit])[1].body as string);
    expect(body.expectedRevision).toBe(snapshot.revision);
    expect(body.changes.roles).toEqual([
      {
        role: "implementer",
        hireNaming: "Keep",
        concurrencyCap: 2,
        harness: "codex",
        model: "sol 6.1",
        effort: "xhigh",
        subagents: { model: "sol 6.1", effort: "medium" },
        delegation: "native-first",
        account: "second",
        placement: "new-tab",
      },
      { role: "reviewer", model: "kept" },
    ]);
    await expect(
      runAgentsCommand(["role", "implementer", "--project", "game", "--model", "retired-model"], options),
    ).rejects.toThrow("unavailable or retired");
    expect(fetchImpl).toHaveBeenCalledTimes(3); // The failed validation only read, never wrote.
    snapshot.settings.projects[0]!.roles[0]!.subagents = null;
    await runAgentsCommand(["role", "implementer", "--project", "game", "--cap", "3"], options);
    const updated = JSON.parse(
      (fetchImpl.mock.calls[4] as unknown as [unknown, RequestInit])[1].body as string,
    );
    expect(updated.changes.roles[0]).toMatchObject({ subagents: null, concurrencyCap: 3 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("registers an existing alternate Claude profile without reading or modifying login", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-profile-"));
  try {
    const settings = new SettingsStore(join(dir, "settings.json"));
    const result = await runClaudeAccountsCommand(["add", dir, "--label", "second"], { settings, env: {} });
    expect(result.accounts).toEqual(expect.arrayContaining([expect.objectContaining({ label: "second" })]));
    await expect(runClaudeAccountsCommand(["add", dir, "--label", "default"], { settings })).rejects.toThrow(
      "implicit",
    );
    await runClaudeAccountsCommand(["remove", "second"], { settings });
    expect((await settings.load()).claudeAccounts).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
