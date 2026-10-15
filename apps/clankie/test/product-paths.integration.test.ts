import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { serve } from "@hono/node-server";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  FileCredentialStore,
  mintOperatorToken,
  OPERATOR_CREDENTIAL_PROVIDER_ID,
} from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import {
  ProjectSchema,
  ProjectsSettingsSchema,
  PROJECTS_PATH,
  PROJECT_UPDATE_SETTINGS_PATH,
} from "@clankie/protocol/projects";
import { createProjectRoutes } from "../src/project-routes.ts";
import { runProjectSettingsCommand } from "../../tui/src/command/project-settings.ts";

it("CLI persists product paths through real HTTP, fences revisions and preserves the plain client contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "product-paths-"));
  const store = new SettingsStore(join(root, "settings.json"));
  await store.update((current) => ({
    ...current,
    projects: ProjectsSettingsSchema.parse({ projects: [{ id: "kh2", name: "KH2 Multiplayer" }] }),
  }));
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const token = mintOperatorToken();
  await credentials.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: token });
  const app = createProjectRoutes(
    async (request) => (request.headers.get("authorization") === `Bearer ${token}` ? true : "forbidden"),
    store,
  );
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  try {
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No HTTP address");
    const host = `http://127.0.0.1:${address.port}`;
    const options = { host, env: {}, operatorCredentialStore: credentials };
    const list = async () => {
      const result = await runProjectSettingsCommand(["list"], options);
      if (!result || !("settings" in result)) throw new Error("No project snapshot");
      return result;
    };
    const initial = await list();
    const paths = [
      "inject/",
      "common/",
      "server/",
      "runtime/",
      "tools/launcher/",
      "tools/packaging/",
      "content/",
    ];
    const file = join(root, "changes.json");
    await writeFile(file, JSON.stringify({ productPaths: paths }));
    const args = ["update", "kh2", "--changes", file, "--revision", initial.revision];
    await runProjectSettingsCommand(args, options);
    const saved = await list();
    expect(saved.productPaths).toBe(true);
    expect(saved.settings.projects[0]?.productPaths).toEqual(paths);
    expect((await store.load()).projects.projects[0]?.productPaths).toEqual(paths);
    await expect(runProjectSettingsCommand(args, options)).rejects.toThrow("Project settings changed");

    const plain = await fetch(`${host}${PROJECTS_PATH}`, {
      headers: { authorization: `Bearer ${token}` },
    }).then((response) => response.json());
    expect(plain).not.toHaveProperty("productPaths");
    expect(plain.settings.projects[0]).not.toHaveProperty("productPaths");
    expect(
      z.object(ProjectSchema.shape).strict().omit({ productPaths: true }).parse(plain.settings.projects[0])
        .id,
    ).toBe("kh2");
    expect(plain.revision).toBe(saved.revision);

    for (const invalid of [
      [],
      ["/etc/"],
      ["../src/"],
      ["src/../secret"],
      ["C:/src"],
      ["C:\\src"],
      ["\\\\host\\share"],
      ["src/\u0000"],
      ["a".repeat(257)],
      Array(33).fill("src/"),
    ]) {
      const response = await fetch(`${host}${PROJECT_UPDATE_SETTINGS_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          projectId: "kh2",
          expectedRevision: saved.revision,
          changes: { productPaths: invalid },
        }),
      });
      expect(response.status).toBe(400);
    }
    expect((await list()).revision).toBe(saved.revision);
    await writeFile(file, JSON.stringify({ productPaths: null }));
    await runProjectSettingsCommand(
      ["update", "kh2", "--changes", file, "--revision", saved.revision],
      options,
    );
    expect((await list()).settings.projects[0]).not.toHaveProperty("productPaths");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});
