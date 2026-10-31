import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  InMemoryCredentialStore,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import {
  addProjectWorktreeRoot,
  observeLocalProjectWorktreeRoot,
  projectsRevision,
  SettingsStore,
} from "@clankie/settings";
import { WatchingMachineRefused } from "@clankie/protocol";
import { createCaptain } from "../src/captain/captain.ts";
import {
  createOperatorService,
  type CreateOperatorServiceContext,
} from "../src/captain/captain-operator-service.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import { createCaptainModelRuntime } from "../src/captain/model.ts";
import { routeLaneRun } from "../src/captain/lane-route.ts";
import { guardWatchedRequests } from "../src/captain/watch-request.ts";
import type { LaneSession } from "../src/captain/captain-types.ts";
import { ExecutionConnections } from "../src/herdr-session.ts";
import { WATCH_TURN_REFUSAL, createWatchGate } from "../src/watch.ts";
import { runAutonomyCommand } from "../../tui/src/command/fleet.ts";
import { fleetSettingsClient } from "../../tui/test/fixtures/fleet-settings-client.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

/** Real settings on disk, the real owner route and CLI, and the real hire controller. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clankie-watch-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const settings = new SettingsStore(join(root, "settings.json"));
  const client = fleetSettingsClient(settings);
  const runtimes = new ExecutionConnections({
    settings,
    primary: { binding: () => undefined, status: () => "disabled" },
  });
  const path = join(root, "owned-watches.json");
  const watches = new HerdrWatchStore(path, {
    requireWorkerAccess: (fleet) => runtimes.requireAccess(fleet, "workers"),
  });
  cleanups.push(async () => watches.close());
  return {
    root,
    settings,
    runtimes,
    watches,
    path,
    dial: (level: string) => runAutonomyCommand([level], client),
  };
}

it("Watch holds every machine at Portal: no hire, move or delivery, and no machine refusal to fix", async () => {
  const f = await fixture();
  expect((await f.dial("watch")).level).toBe("watch");

  // Seeing stays open; acting does not.
  await expect(f.runtimes.requireAccess(undefined, "portal")).resolves.toBeDefined();
  await expect(f.runtimes.requireAccess(undefined, "workers")).rejects.toBeInstanceOf(WatchingMachineRefused);
  await expect(f.runtimes.requireAccess(undefined, "shell")).rejects.toThrow("only watching");

  const hire = await f.watches.spawnSeat({
    schemaVersion: 1,
    harness: "codex",
    title: "Watched",
    workingDirectory: f.root,
  });
  expect(hire).toMatchObject({
    outcome: "failed",
    reason: "not_ready",
    detail: expect.stringContaining("only watching"),
  });
  await expect(stat(`${f.path}.project-hires.json`)).rejects.toThrow();
  expect(
    await f.watches.moveSeat({
      seatId: "watched-seat",
      subject: "Watched",
      harness: "codex",
      title: "Watched",
      workingDirectory: f.root,
    }),
  ).toMatchObject({ outcome: "failed", detail: expect.stringContaining("only watching") });
  expect(await f.watches.deliverToSeat("watched-seat", "Do work")).toMatchObject({
    outcome: "undelivered",
    deliveryStage: "rejected",
    detail: expect.stringContaining("only watching"),
  });
  // The owner chose Watch: doctor gets no "raise this machine's access" item.
  await expect(stat(`${f.settings.path}.access-refusals`)).rejects.toThrow();

  // Any level lets him act again, at the machine's own access.
  expect((await f.dial("off")).level).toBe("off");
  await expect(f.runtimes.requireAccess(undefined, "workers")).resolves.toBeDefined();
});

it("Watch refuses a model turn before any model is chosen, so nothing reaches a provider", async () => {
  const f = await fixture();
  const watch = createWatchGate(f.settings);
  const models = await createCaptainModelRuntime(f.root, { refuse: () => watch.refuse(WATCH_TURN_REFUSAL) });
  await f.dial("watch");
  await expect(models.resolveSelection()).rejects.toThrow(WATCH_TURN_REFUSAL);
  await expect(models.resolveRoute("operator")).rejects.toThrow(WATCH_TURN_REFUSAL);
  // Leaving Watch lifts the refusal; whatever the machine's model setup says comes next.
  await f.dial("off");
  await expect(watch.refuse(WATCH_TURN_REFUSAL)).resolves.toBeUndefined();
});

it("Watch compacts no session: a trimmed lane keeps its compaction for when Clankie acts again", async () => {
  const f = await fixture();
  const watch = createWatchGate(f.settings);
  const models = await createCaptainModelRuntime(f.root, { refuse: () => watch.refuse(WATCH_TURN_REFUSAL) });
  const compactions: string[] = [];
  const lane = {
    purpose: "operator" as const,
    budget: { compactBeforeNextRun: true },
    // Compaction sends the session's history to a model; it is the only call this lane can make.
    session: { compact: async () => void compactions.push("compacted") } as unknown as LaneSession["session"],
  };
  await f.dial("watch");
  await expect(routeLaneRun(lane, models)).rejects.toThrow(WATCH_TURN_REFUSAL);
  expect(compactions).toEqual([]);
  expect(lane.budget.compactBeforeNextRun).toBe(true);
});

it("Watch joins the settings revision, so a client that read Off before Watch gets a conflict", async () => {
  const f = await fixture();
  const client = fleetSettingsClient(f.settings);
  const read = async () =>
    (await (
      await client.fetchImpl(`${client.host}/v1/operator/fleet-settings`, {
        headers: { authorization: `Bearer ${client.env.CLANKIE_OPERATOR_TOKEN}` },
      })
    ).json()) as { revision: string };
  await f.dial("off");
  const stale = await read();
  await f.dial("watch");
  const write = await client.fetchImpl(`${client.host}/v1/operator/fleet-settings`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${client.env.CLANKIE_OPERATOR_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      schemaVersion: 1,
      expectedRevision: stale.revision,
      changes: { autonomyLevel: "off" },
    }),
  });
  expect(write.status).toBe(409);
  expect((await f.settings.load()).autonomy.watch).toBe(true);
});

it("Watch stops a turn already running and its compaction: nothing after the switch reaches the provider", async () => {
  const f = await fixture();
  const core = createFauxCore({ provider: "watched", api: "faux-watched", models: [{ id: "default" }] });
  const sent: string[] = [];
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerProvider("watched", {
    api: "faux-watched" as Api,
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "loopback",
    // As a real transport does: shape the body, then send only on a live signal.
    streamSimple: (model, context, options) => {
      const body = { model: model.id, messages: context.messages.length };
      void Promise.resolve(options?.onPayload?.(body, model)).then(() => {
        if (options?.signal?.aborted !== true) sent.push(`request with ${String(body.messages)} message(s)`);
      });
      return core.streamSimple(model, context, options);
    },
    models: [
      {
        id: "default",
        name: "default",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 4_000,
      },
    ],
  });
  const watch = createWatchGate(f.settings);
  // Keep almost nothing recent, so this short session has history to compact.
  const settingsManager = SettingsManager.inMemory({ compaction: { keepRecentTokens: 1 } });
  const loader = new DefaultResourceLoader({
    cwd: f.root,
    agentDir: f.root,
    systemPrompt: "You are under test.",
    noExtensions: true,
    noPromptTemplates: true,
    settingsManager,
  });
  await loader.reload();
  // The owner turns Watch on while the turn's tool is running.
  const look = defineTool({
    name: "look",
    label: "Look",
    description: "Looks around.",
    parameters: Type.Object({}),
    execute: async () => {
      await f.dial("watch");
      return { content: [{ type: "text" as const, text: "seen" }], details: undefined };
    },
  });
  const { session } = await createAgentSession({
    cwd: f.root,
    model: runtime.getModel("watched", "default") as Model<Api>,
    thinkingLevel: "off",
    modelRuntime: runtime,
    customTools: [look],
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(f.root),
    settingsManager,
    noTools: "builtin",
  });
  guardWatchedRequests(session, watch);
  await session.bindExtensions({ mode: "print" });
  core.setResponses([
    fauxAssistantMessage(fauxToolCall("look", {})),
    fauxAssistantMessage("answered"),
    fauxAssistantMessage("summary"),
  ]);
  await session.prompt("look around", { expandPromptTemplates: false }).catch(() => undefined);
  await session.waitForIdle();
  await new Promise((resolve) => setTimeout(resolve, 50));
  // Compaction sends the whole history to a model, so it is refused too.
  const compacted = await session.compact().then(
    () => "compacted",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  expect(compacted).not.toBe("compacted");
  // Only the request from before Watch went out; the tool result stayed home.
  expect(sent).toEqual([expect.stringMatching(/^request with/)]);
  expect(
    session.sessionManager.getEntries().some((entry: { type: string }) => entry.type === "compaction"),
  ).toBe(false);
});

it("Watch removes no worktree, even through the prune route a lead or worker can call", async () => {
  const exec = promisify(execFile);
  const git = (cwd: string, args: string[]) => exec("git", ["-C", cwd, ...args]);
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-watch-prune-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const agents = join(root, "agents");
  await mkdir(repo);
  await mkdir(agents);
  await git(repo, ["init", "--quiet", "--initial-branch=main"]);
  await git(repo, ["config", "user.name", "Watch fixture"]);
  await git(repo, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(repo, "source.txt"), "retained\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "--quiet", "-m", "fixture baseline"]);
  await git(repo, ["clone", "--quiet", "--bare", repo, join(root, "origin.git")]);
  await git(repo, ["remote", "add", "origin", join(root, "origin.git")]);
  await git(repo, ["fetch", "--quiet", "origin"]);
  let projects = ProjectsSettingsSchema.parse({
    projects: [
      {
        id: "watched",
        name: "Watched",
        workspaces: [{ id: "owner", machineId: "local", platform: "posix", path: repo }],
      },
    ],
  });
  const request = {
    projectId: "watched",
    machineId: "local",
    platform: "posix" as const,
    path: agents,
    repoPath: repo,
    expectedRevision: projectsRevision(projects),
  };
  projects = addProjectWorktreeRoot(projects, request, (await observeLocalProjectWorktreeRoot(request))!);
  await writeFile(join(root, "settings.json"), JSON.stringify({ schemaVersion: 1, projects }));
  const settings = new SettingsStore(join(root, "settings.json"));
  const tree = join(agents, "landed");
  await git(repo, ["worktree", "add", "--quiet", "--detach", tree, "main"]);
  const captain = createCaptain(
    {
      herdrAvailable: () => false,
      presence: { listSessions: async () => [] },
      embodiment: { getLiveSession: async () => undefined },
    } as unknown as CaptainDeps,
    { repoRoot: root, stateDir: join(root, "state"), workingDirectory: root, settings },
  );
  cleanups.push(() => captain.close());
  await runAutonomyCommand(["watch"], fleetSettingsClient(settings));
  const pruned = await captain.pruneWorktree!(repo, tree).catch((error: unknown) => ({
    outcome: "refused",
    detail: error instanceof Error ? error.message : String(error),
  }));
  expect(pruned).not.toMatchObject({ outcome: "removed" });
  expect(JSON.stringify(pruned)).toContain("only watching");
  await expect(stat(tree)).resolves.toBeDefined();
});

it.each([
  ["with unlanded work still to check", undefined],
  ["with a recorded reason to leave unlanded work", "landed elsewhere"],
])(
  "Watch chosen while a seat close is under way stops it before the exit (%s)",
  async (_, unlandedReason) => {
    const { settings, dial } = await fixture();
    const exits: string[] = [];
    const serve = createOperatorService({
      shutdown: new AbortController(),
      personas: { ready: async () => {} },
      settingsStore: settings,
      settings: () => settings.load(),
      deps: {},
      herdrWatches: {
        tidy: {
          // The owner chooses Watch while the close waits on its worktree check.
          seatWorktreeHold: async () => {
            await dial("watch");
            return [];
          },
        },
        // Herdr's own close: the guard runs right before the exit, and a refusal closes nothing.
        closeSeat: async (seatId: string, guard?: () => Promise<void>) => {
          try {
            await guard?.();
          } catch {
            return false;
          }
          exits.push(seatId);
          return true;
        },
      },
    } as unknown as CreateOperatorServiceContext);
    const result = await serve({
      op: "close_seat",
      schemaVersion: 1,
      seatId: "w1:p1",
      ...(unlandedReason === undefined ? {} : { unlandedReason }),
    });
    expect(result).toMatchObject({ op: "close_seat", closed: false });
    expect(exits).toEqual([]);
  },
);
