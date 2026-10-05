import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  FileCredentialStore,
  mintOperatorToken,
  OPERATOR_CREDENTIAL_PROVIDER_ID,
} from "@clankie/credential-broker";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { SettingsStore } from "@clankie/settings";
import { createProjectRoutes } from "../../clankie/src/project-routes.ts";
import { runProjectSettingsCommand } from "../src/command/project-settings.ts";
import { runProjectsMenu } from "../src/project-menu.ts";
import type { ClankieFaceShell } from "../src/shell/shell.ts";

/** The modal drives the CLI client, which talks to the service's real project routes over its settings file. */
it("edits and creates projects from the modal through the revision-bearing project API", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "project-menu-")));
  try {
    const garden = join(directory, "garden");
    const orchard = join(directory, "orchard");
    await mkdir(garden);
    await mkdir(orchard);
    const settings = new SettingsStore(join(directory, "settings.json"));
    await settings.update((current) => ({
      ...current,
      projects: ProjectsSettingsSchema.parse({
        projects: [
          {
            id: "garden",
            name: "Garden",
            workspaces: [{ id: "primary", machineId: "local", path: garden, platform: "posix" }],
            roles: [{ role: "builder", harness: "codex" }],
          },
        ],
      }),
    }));
    const routes = createProjectRoutes(async () => true, settings);
    const store = new FileCredentialStore(join(directory, "credentials.json"));
    const token = mintOperatorToken();
    await store.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: token });
    const client = {
      env: { CLANKIE_OPERATOR_TOKEN: token },
      operatorCredentialStore: store,
      host: "http://clankie.test",
      fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) =>
        routes.request(new URL(String(url)).pathname, init)) as typeof fetch,
    };

    const choices: (string | undefined)[] = ["project:garden", "cap", "name", undefined, "create", undefined];
    const texts = ["3", "Garden Path", "orchard", "Orchard", orchard];
    const readSelect = vi.fn(async (_options: unknown) => choices.shift());
    const renderLine = vi.fn();
    const shell = {
      setupFlow: {
        begin: vi.fn(),
        end: vi.fn(),
        setStatus: vi.fn(),
        readSelect,
        readText: vi.fn(async () => texts.shift()),
        renderLine,
      },
      insertCommandResult: vi.fn(),
    } as unknown as ClankieFaceShell;
    await runProjectsMenu(shell, {
      settings: (args) => runProjectSettingsCommand(args, client),
      workspace: vi.fn(),
      roles: vi.fn(),
    });

    expect(renderLine.mock.calls.filter(([, tone]) => tone === "error")).toEqual([]);
    const top = readSelect.mock.calls[0]![0] as { options: { value: string; hint?: string }[] };
    expect(top.options[0]).toMatchObject({ value: "project:garden", hint: "garden · 1 role" });
    const saved = (await settings.load()).projects.projects;
    expect(saved.find((p) => p.id === "garden")).toMatchObject({ name: "Garden Path", workerCap: 3 });
    expect(saved.find((p) => p.id === "orchard")).toMatchObject({
      name: "Orchard",
      workspaces: [{ path: orchard }],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
