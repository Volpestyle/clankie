import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { SettingsStore } from "@clankie/settings";
import { createCaptain } from "../src/captain/captain.ts";
import { AutonomyStore } from "../src/captain/autonomy.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";

// #430: Auto routing's workspace match only takes a lead bound to no project, but
// the lead roster held only the default chat and project-bound chats, so an Auto
// project with no explicit lead always ran its rounds in the default chat. Real
// Captain, real Auto cadence tick and durable round record; no Herdr, model or tracker.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function rounds(root: string): Promise<{ conversationId: string; projectId: string }[]> {
  const text = await readFile(join(root, "auto-rounds", "rounds.jsonl"), "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as { type: string; conversationId: string; velocity?: { projectId: string } },
    )
    .filter((entry) => entry.type === "measurement")
    .map((entry) => ({ conversationId: entry.conversationId, projectId: entry.velocity!.projectId }));
}

async function autoRound(options: { leads: (workspace: string, elsewhere: string) => string[][] }) {
  const root = await mkdtemp(join(tmpdir(), "auto-workspace-lead-round-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "game");
  const elsewhere = join(root, "other");
  await mkdir(workspace);
  await mkdir(elsewhere);
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    projects: ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "game",
          name: "Game",
          auto: true,
          workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: workspace }],
        },
      ],
    }),
  }));
  const autonomy = new AutonomyStore(join(root, "autonomy.json"));
  autonomy.command("global-default", { action: "set_enabled", enabled: false });
  autonomy.close();
  const boot = () =>
    createCaptain({ herdrAvailable: () => false, embodiment: {} } as unknown as CaptainDeps, {
      repoRoot: root,
      stateDir: root,
      workingDirectory: root,
      settings,
      autoRoundIntervalMs: 250,
    });
  // The chats exist before Auto is on, so no tick can route without them.
  const setup = boot();
  const created: string[] = [];
  for (const [folder, title] of options.leads(workspace, elsewhere)) {
    const result = await setup.serveOperatorConversation({
      op: "create",
      schemaVersion: 1,
      scope: { kind: "workspace", workspaceId: folder! },
      title: title!,
    });
    if (result.op !== "create") throw new Error("Workspace chat was not created");
    created.push(result.conversation.conversationId);
  }
  await setup.close();
  const switched = new AutonomyStore(join(root, "autonomy.json"));
  switched.command("global-default", { action: "set_enabled", enabled: true });
  switched.close();
  const captain = boot();
  cleanups.push(() => captain.close());
  await expect.poll(() => rounds(root), { timeout: 15_000, interval: 100 }).not.toEqual([]);
  return { created, rounds: await rounds(root) };
}

it("an Auto project with no explicit lead runs its round in the one chat scoped to its workspace (#430)", async () => {
  const { created, rounds: recorded } = await autoRound({
    leads: (workspace, elsewhere) => [
      [workspace, "Game lead"],
      [elsewhere, "Other folder's lead"],
    ],
  });
  expect(recorded[0]).toEqual({ conversationId: created[0], projectId: "game" });
  expect(recorded.every((round) => round.conversationId === created[0])).toBe(true);
});

it("two chats scoped to the project's workspace leave its round with the default chat", async () => {
  const { rounds: recorded } = await autoRound({
    leads: (workspace) => [
      [workspace, "First"],
      [workspace, "Second"],
    ],
  });
  expect(recorded[0]).toEqual({ conversationId: "global-default", projectId: "game" });
});
