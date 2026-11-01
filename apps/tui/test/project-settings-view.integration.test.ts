import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import {
  FileCredentialStore,
  mintOperatorToken,
  OPERATOR_CREDENTIAL_PROVIDER_ID,
} from "@clankie/credential-broker";
import { PROJECTS_PATH, ProjectsSettingsSchema, ProjectsSnapshotSchema } from "@clankie/protocol/projects";
import { SettingsStore } from "@clankie/settings";
import { createClankieApp } from "../../clankie/src/app.ts";
import { countOutsideProjects, projectStatuses } from "../../clankie/src/captain/auto-projects.ts";
import { createStubCaptain } from "../../clankie/src/captain/port.ts";

const execute = promisify(execFile);
const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/clankie.ts");

it("project settings reads as plain words, flags a stale focus and a gone reviewer, and says where waiting questions are (#180, #182-#184)", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "project-settings-view-")));
  let server: Server | undefined;
  let closeApp: (() => Promise<void>) | undefined;
  try {
    const workspace = join(root, "repo");
    await mkdir(join(workspace, ".clankie"), { recursive: true });
    // The project moved to GitHub issues; its focus still names Linear.
    await writeFile(
      join(workspace, ".clankie", "tracking.json"),
      JSON.stringify({
        schemaVersion: 1,
        backend: "github",
        github: { repo: "owner/garden" },
        decidedBy: "owner",
        decidedAt: new Date().toISOString(),
      }),
    );
    const settings = new SettingsStore(join(root, "settings.json"));
    await settings.update((current) => ({
      ...current,
      projects: ProjectsSettingsSchema.parse({
        projects: [
          {
            id: "garden",
            name: "Garden",
            workspaces: [{ id: "repo", machineId: "local", platform: "posix", path: workspace }],
            auto: true,
            focus: "VUH Urgent/High backlog in the Clankie Linear project",
            review: { seat: "pc/term_gone" },
          },
        ],
      }),
    }));
    // Pending owner questions as the service reads them: one here, two raised outside any project.
    const questions = [workspace, "/elsewhere", "/elsewhere/too"];
    const token = mintOperatorToken();
    const credentialsFile = join(root, "credentials.json");
    await new FileCredentialStore(credentialsFile).set(OPERATOR_CREDENTIAL_PROVIDER_ID, {
      type: "api",
      key: token,
    });
    const service = await createClankieApp({
      captain: createStubCaptain({
        projectStatus: async (projects) => ({
          projects: await projectStatuses(projects, [workspace], questions),
          needsYou: questions.length,
        }),
        // The real captain resolves the seat through Herdr; this one is gone.
        projectHealth: async (projects) => ({
          needsYouOutsideProjects: countOutsideProjects(projects, questions),
          reviewSeatLive: { garden: false },
        }),
      }),
      settings,
      authenticateOperator: async (request) =>
        request.headers.get("authorization") === `Bearer ${token}` ? { operatorId: "owner" } : undefined,
    });
    closeApp = () => service.close();
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const result = await service.app.request(request.url!, {
        method: request.method ?? "GET",
        headers: {
          authorization: String(request.headers.authorization ?? ""),
          "content-type": "application/json",
        },
        ...(request.method === "GET" ? {} : { body: Buffer.concat(chunks) }),
      });
      response.writeHead(result.status, { "content-type": "application/json" });
      response.end(await result.text());
    });
    await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const host = `http://127.0.0.1:${address.port}`;
    const cli = async (...args: string[]) =>
      (
        await execute(process.execPath, [CLI, "project", "settings", "garden", ...args], {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            NO_COLOR: "1",
            HOME: join(root, "home"),
            XDG_CONFIG_HOME: join(root, "config"),
            XDG_STATE_HOME: join(root, "state"),
            CLANKIE_CREDENTIALS_FILE: credentialsFile,
            CLANKIE_CONTROL_PLANE_URL: host,
          },
          timeout: 60_000,
        })
      ).stdout;

    const view = await cli();
    expect(view.split("\n")[0]).toBe("Garden (garden)");
    expect(view).toContain("Tracker: GitHub issues in owner/garden\n");
    expect(view).toContain("Focus: VUH Urgent/High backlog in the Clankie Linear project\n");
    expect(view).toMatch(/Stale: it names Linear, but this project tracks GitHub issues in owner\/garden\./u);
    expect(view).toContain("Reviewer: seat pc/term_gone (gone)\n");
    expect(view).toMatch(/Stale: no live seat answers to it/u);
    expect(view).toContain("1 waiting on you here");
    expect(view).toContain(
      "Waiting on you overall: 3, 2 not raised in any project's workspace. See them with: clankie feed",
    );
    expect(view.trimEnd().split("\n").at(-1)).toBe(
      "Everything saved, as JSON: clankie project settings garden --json",
    );
    // No raw store dump in the plain read.
    expect(view).not.toContain('"revision"');

    // --json keeps the whole snapshot for agents, health fields included.
    const raw = JSON.parse(await cli("--json")) as Record<string, unknown>;
    expect(raw.projectId).toBe("garden");
    expect(raw.needsYouOutsideProjects).toBe(2);
    expect(raw.reviewSeatLive).toEqual({ garden: false });
    // A client that never asks for health keeps its strict shape.
    const plain = ProjectsSnapshotSchema.parse(
      await (
        await fetch(`${host}${PROJECTS_PATH}?includeAutonomy=true`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).json(),
    );
    expect(plain.needsYouOutsideProjects).toBeUndefined();
    expect(plain.reviewSeatLive).toBeUndefined();
  } finally {
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    await closeApp?.();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
