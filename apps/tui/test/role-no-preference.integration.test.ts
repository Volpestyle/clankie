import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  FileCredentialStore,
  mintOperatorToken,
  OPERATOR_CREDENTIAL_PROVIDER_ID,
} from "@clankie/credential-broker";
import { SpawnOperatorSeatSchema } from "@clankie/protocol";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { SettingsStore } from "@clankie/settings";
import { createProjectRoutes } from "../../clankie/src/project-routes.ts";
import { ProjectHires } from "../../clankie/src/captain/project-hires.ts";
import { runAgentsCommand } from "../src/command/agents.ts";
import { runFleetCommand } from "../src/command/fleet.ts";
import { runProjectSettingsCommand } from "../src/command/project-settings.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * `auto` is the owner's "no preference" for a role's model and effort: the CLI
 * talks to the service's real project routes over a settings file, and the hire
 * ledger then launches with no model or effort unless Clankie picks one.
 */
it("clears pinned role model and effort to no preference through the CLI, project update and hire", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "role-no-preference-")));
  try {
    const settings = new SettingsStore(join(root, "settings.json"));
    const pinned = {
      harness: "codex" as const,
      model: "gpt-6.1-sol",
      effort: "xhigh" as const,
      subagents: { model: "gpt-6.1-sol", effort: "medium" as const },
      delegation: "native-first" as const,
      account: "second",
      placement: "new-tab" as const,
    };
    await settings.update((current) => ({
      ...current,
      fleet: { ...current.fleet, hire: { harness: "codex" } },
      projects: ProjectsSettingsSchema.parse({
        projects: [
          {
            id: "game",
            name: "Game",
            roles: [
              { role: "builder", ...pinned },
              { role: "reviewer", ...pinned },
            ],
          },
        ],
      }),
    }));
    const routes = createProjectRoutes(async () => true, settings);
    const store = new FileCredentialStore(join(root, "credentials.json"));
    const token = mintOperatorToken();
    await store.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: token });
    const catalog = join(root, "models.json");
    await writeFile(
      catalog,
      JSON.stringify({ openai: { models: { "gpt-6.1-sol": { id: "gpt-6.1-sol" } } } }),
    );
    // The service validates every pinned role model against its registry; share the fixture catalog.
    vi.stubEnv("CLANKIE_MODELS_PATH", catalog);
    const client = {
      env: { CLANKIE_OPERATOR_TOKEN: token, CLANKIE_MODELS_PATH: catalog },
      operatorCredentialStore: store,
      host: "http://clankie.test",
      fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) =>
        routes.request(new URL(String(url)).pathname, init)) as typeof fetch,
    };
    const kept = { harness: "codex", delegation: "native-first", account: "second", placement: "new-tab" };

    // `agents role … auto` (the CLI and the /agents roles editor's path).
    await runAgentsCommand(
      [
        "role",
        "builder",
        "--project",
        "game",
        "--model",
        "auto",
        "--effort",
        "auto",
        "--subagent-model",
        "auto",
        "--subagent-effort",
        "auto",
      ],
      client,
    );
    // `project update` with `auto` in a changes file, read-before-write with the revision.
    const snapshot = (await runProjectSettingsCommand(["list"], client)) as {
      revision: string;
      settings: { projects: { roles: Record<string, unknown>[] }[] };
    };
    const roles = snapshot.settings.projects[0]!.roles.map((role) =>
      role.role === "reviewer"
        ? { ...role, model: "auto", effort: "auto", subagents: { model: "auto", effort: "auto" } }
        : role,
    );
    const changes = join(root, "changes.json");
    await writeFile(changes, JSON.stringify({ roles }));
    await runProjectSettingsCommand(
      ["update", "game", "--changes", changes, "--revision", snapshot.revision],
      client,
    );

    const saved = (await settings.load()).projects.projects[0]!.roles;
    expect(saved).toEqual([
      { role: "builder", ...kept },
      { role: "reviewer", ...kept },
    ]);
    const status = await runFleetCommand(["status"], { settings });
    for (const entry of status.roleProfiles) {
      expect(entry.profile).toEqual(kept);
    }

    // At hire time, no preference launches without a model or effort; Clankie may still choose one.
    const fresh = await settings.load();
    const ledger = new ProjectHires(join(root, "project-hires.json"));
    const hire = (title: string, extra: Record<string, unknown> = {}) =>
      SpawnOperatorSeatSchema.parse({
        schemaVersion: 1,
        role: "builder",
        title,
        workingDirectory: join(root, title),
        deliverable: `VUH-${title}`,
        ...extra,
      });
    const open = ledger.reserve(fresh.projects, "game", hire("Ada"), fresh.fleet.hire).request;
    expect(open).not.toHaveProperty("model");
    expect(open).not.toHaveProperty("effort");
    expect(open).not.toHaveProperty("subagents");
    const chosen = ledger.reserve(
      fresh.projects,
      "game",
      hire("Bea", { model: "gpt-6.1-sol", effort: "high" }),
      fresh.fleet.hire,
    ).request;
    expect(chosen).toMatchObject({ model: "gpt-6.1-sol", effort: "high", ...kept });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
