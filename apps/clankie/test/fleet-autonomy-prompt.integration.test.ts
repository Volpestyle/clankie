import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ProjectsSettingsSchema, type Project } from "@clankie/protocol/projects";
import {
  SettingsStore,
  projectsRevision,
  updateProjectSettings,
  observeLocalProjectWorktreeRoot,
  addProjectWorktreeRoot,
} from "@clankie/settings";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { ConversationJournal } from "../src/captain/conversation-journal.ts";

// Real persisted settings, project workspace resolution, native-seat attachment,
// instruction loading and captain prompt entrypoint. No model or eval runs.
const exec = promisify(execFile);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fleet-autonomy-prompt-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const state = join(root, "state");
  const global = join(root, "global");
  const garden = join(root, "garden");
  const other = join(root, "other");
  await Promise.all([state, global, garden, other].map((path) => mkdir(path)));
  await writeFile(join(garden, "AGENTS.md"), "Garden workspace instructions from its actual folder.\n");
  const settings = new SettingsStore(join(state, "settings.json"));
  const unused = (): never => {
    throw new Error("Prompt reads must not invoke agent or model capabilities");
  };
  const deps: CaptainDeps = {
    herdrAvailable: () => false,
    mcp: { catalog: unused, call: unused },
    email: { list: unused, read: unused, search: unused, send: unused },
    browser: { catalog: unused, call: unused },
    media: { generateImage: unused, generateVideo: unused, finishedRenders: unused },
    embodiment: { submitIntent: unused, getSession: unused, getLiveSession: unused },
    activity: { current: unused },
    presence: { listSessions: unused, listVoiceHistory: unused, listRecentVoiceSpeech: unused },
    memory: { appendEpisode: unused, recallEpisodeCard: unused, searchEpisodeCard: unused },
  };
  const captain = createCaptain(deps, {
    repoRoot: root,
    stateDir: state,
    workingDirectory: global,
    settings,
  });
  cleanups.push(() => captain.close());
  const nativeConversation = async (cwd: string) => {
    const result = await captain.serveOperatorConversation({
      schemaVersion: 1,
      op: "create",
      scope: { kind: "workspace", workspaceId: cwd },
      title: "Native project lead",
    });
    if (result.op !== "create") throw new Error("Expected workspace conversation");
    const id = result.conversation.conversationId;
    expect(await captain.pollSeatEvents(0, undefined, id)).toEqual([]);
    expect(
      captain.syncSeatTranscript(id, {
        sessionId: `native-${id}`,
        entries: [{ type: "message", id: "native-proof", role: "agent", text: "Native lead attached" }],
        activity: "waiting",
      }),
    ).toBe(true);
    expect(new ConversationJournal(join(state, "conversations")).read(id)).toContainEqual(
      expect.objectContaining({ type: "message", role: "captain", text: "Native lead attached" }),
    );
    return id;
  };
  const prompt = (conversationId: string) =>
    captain.lanePrompt({
      lane: "operator",
      sections: ["fleet"],
      conversationId,
      harness: "claude",
    });
  const project = (id: string, path: string, autonomy?: Project["autonomy"]): Project =>
    ProjectsSettingsSchema.parse({
      projects: [
        {
          id,
          name: id,
          workspaces: [{ id: "repo", machineId: "local", platform: "posix", path }],
          ...(autonomy ? { autonomy } : {}),
        },
      ],
    }).projects[0]!;
  return { root, settings, captain, global, garden, other, nativeConversation, prompt, project };
}

function policy(prompt: string, closure: "lead" | "owner", machineSetup: "lead" | "owner") {
  expect(prompt).toContain(`Work closure: ${closure}.`);
  expect(prompt).toContain(`Machine setup: ${machineSetup}.`);
  expect(prompt.match(/^Work closure:/gmu)).toHaveLength(1);
  expect(prompt.match(/^Machine setup:/gmu)).toHaveLength(1);
}

it("gives an attached native conversation explicit lead defaults from an absent settings file", async () => {
  const f = await fixture();
  const id = await f.nativeConversation(f.global);
  const prompt = await f.prompt(id);
  policy(prompt, "lead", "lead");
  expect(prompt).toContain("landed, relevant checks pass, and evidence is attached");
  expect(prompt).toContain("already-linked machines");
  expect(prompt).toContain(
    "no steering of existing lanes, restarts, credentials, accounts, or destructive actions",
  );
  expect(prompt).toContain(`# Selected conversation\n${id}\nWorkspace: ${f.global}`);
});

it("inherits each project field independently using the native conversation's canonical workspace", async () => {
  const f = await fixture();
  await f.settings.update((current) => ({
    ...current,
    autonomy: { fleet: { closure: "owner", machineSetup: "owner" } },
    projects: ProjectsSettingsSchema.parse({
      projects: [
        f.project("garden", f.garden, { fleet: { closure: "lead" } }),
        f.project("other", f.other, { fleet: { machineSetup: "lead" } }),
      ],
    }),
  }));
  const garden = await f.nativeConversation(f.garden);
  const other = await f.nativeConversation(f.other);
  const global = await f.nativeConversation(f.global);
  const gardenPrompt = await f.prompt(garden);
  policy(gardenPrompt, "lead", "owner");
  expect(gardenPrompt).toContain("Garden workspace instructions from its actual folder.");
  policy(await f.prompt(other), "owner", "lead");
  policy(await f.prompt(global), "owner", "owner");
});

it("refreshes global and project policy on the same native conversation without restarting or reopening it", async () => {
  const f = await fixture();
  await f.settings.update((current) => ({
    ...current,
    projects: ProjectsSettingsSchema.parse({
      projects: [f.project("garden", f.garden, { fleet: { closure: "owner" } })],
    }),
  }));
  const id = await f.nativeConversation(f.garden);
  policy(await f.prompt(id), "owner", "lead");
  // A separate SettingsStore writes the real file, proving the prompt does not
  // retain the startup snapshot or rely on an in-process notification.
  const writer = new SettingsStore(f.settings.path);
  await writer.update((current) => ({
    ...current,
    autonomy: { fleet: { closure: "lead", machineSetup: "owner" } },
  }));
  policy(await f.prompt(id), "owner", "owner");
  await writer.update((current) => ({
    ...current,
    projects: updateProjectSettings(current.projects, {
      projectId: "garden",
      expectedRevision: projectsRevision(current.projects),
      changes: { autonomy: { fleet: { machineSetup: "lead" } } },
    }),
  }));
  policy(await f.prompt(id), "owner", "lead");
  await writer.update((current) => ({
    ...current,
    projects: updateProjectSettings(current.projects, {
      projectId: "garden",
      expectedRevision: projectsRevision(current.projects),
      changes: { autonomy: { fleet: { closure: null } } },
    }),
  }));
  policy(await f.prompt(id), "lead", "lead");
  await writer.update((current) => ({
    ...current,
    autonomy: { fleet: { closure: "owner", machineSetup: "owner" } },
  }));
  policy(await f.prompt(id), "owner", "lead");
  expect(f.captain.seatContext(id)).toEqual({ conversationId: id, cwd: f.garden });
});

it("refuses ambiguous project attribution instead of selecting a permissive override or global fallback", async () => {
  const f = await fixture();
  await f.settings.update((current) => ({
    ...current,
    autonomy: { fleet: { closure: "lead", machineSetup: "lead" } },
    projects: ProjectsSettingsSchema.parse({
      projects: [f.project("garden", f.garden, { fleet: { closure: "owner", machineSetup: "owner" } })],
    }),
  }));
  const id = await f.nativeConversation(f.garden);
  policy(await f.prompt(id), "owner", "owner");
  await f.settings.update((current) => ({
    ...current,
    projects: ProjectsSettingsSchema.parse({
      projects: [
        ...current.projects.projects,
        f.project("conflicting", f.garden, { fleet: { closure: "lead", machineSetup: "lead" } }),
      ],
    }),
  }));
  await expect(f.prompt(id)).rejects.toThrow(/ambiguous|more than one project/u);
  await expect(f.prompt("unknown-conversation")).rejects.toThrow("Unknown captain conversation");
});

it("resolves a real approved sibling Git worktree and refuses unknown namespace folders and conflicting legitimate matches", async () => {
  const f = await fixture();
  await exec("git", ["init", "--quiet", f.garden]);
  await exec("git", ["-C", f.garden, "add", "AGENTS.md"]);
  await exec("git", [
    "-C",
    f.garden,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  const namespace = join(f.root, "worktrees");
  await mkdir(namespace);
  const worktree = join(namespace, "active");
  await exec("git", ["-C", f.garden, "worktree", "add", "--quiet", "-b", "fixture-worker", worktree]);
  await f.settings.update((current) => ({
    ...current,
    projects: ProjectsSettingsSchema.parse({
      projects: [f.project("garden", f.garden, { fleet: { closure: "owner", machineSetup: "owner" } })],
    }),
  }));
  const input = {
    projectId: "garden",
    machineId: "local",
    platform: "posix" as const,
    path: namespace,
    repoPath: f.garden,
  };
  const observed = await observeLocalProjectWorktreeRoot(input);
  expect(observed).toBeDefined();
  await f.settings.update((current) => ({
    ...current,
    projects: addProjectWorktreeRoot(
      current.projects,
      {
        ...input,
        expectedRevision: projectsRevision(current.projects),
      },
      observed!,
    ),
  }));
  const id = await f.nativeConversation(worktree);
  policy(await f.prompt(id), "owner", "owner");
  const nested = join(worktree, "src");
  await mkdir(nested);
  policy(await f.prompt(await f.nativeConversation(nested)), "owner", "owner");

  const unregistered = join(namespace, "unregistered");
  await mkdir(unregistered);
  const unknown = await f.nativeConversation(unregistered);
  await expect(f.prompt(unknown)).rejects.toThrow(/worktree could not be verified/u);

  // Both native Git registration under Garden's approved namespace and this
  // independently approved canonical workspace are genuine observations. An
  // overlapping saved policy must refuse attribution, even when one is lead.
  await f.settings.update((current) => ({
    ...current,
    projects: ProjectsSettingsSchema.parse({
      projects: [
        ...current.projects.projects,
        f.project("conflicting", worktree, { fleet: { closure: "lead", machineSetup: "lead" } }),
      ],
    }),
  }));
  await expect(f.prompt(id)).rejects.toThrow(/ambiguous/u);
});
