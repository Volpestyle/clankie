import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import {
  FileCredentialStore,
  mintOperatorToken,
  OPERATOR_CREDENTIAL_PROVIDER_ID,
} from "@clankie/credential-broker";
import { ProjectSchema, ProjectsSettingsSchema } from "@clankie/protocol/projects";
import {
  PROJECT_TRACKING_APPLY_PATH,
  PROJECT_TRACKING_PATH,
  type TrackerChoice,
  type TrackingRepoStatus,
} from "@clankie/protocol/project-tracking";
import { SettingsStore } from "@clankie/settings";
import {
  githubRestApi,
  renderTrackingBlock,
  TRACKING_BRANCH,
  TRACKING_CLOSE,
  TRACKING_OPEN,
} from "@clankie/work-items";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createProjectTrackingService } from "../src/project-tracking.ts";
import { suggestProjectTracking } from "../src/project-tracking-inference.ts";
import { runProjectCommand } from "../../tui/src/command/project.ts";
import { startLoopbackForge } from "./helpers/loopback-forge.ts";

const run = promisify(execFile);
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const GITHUB: TrackerChoice = {
  provider: "github",
  publicBoard: "fixture/public",
  privateBoard: "fixture/private",
};
const GUIDE = "# Guide\n\nThe owner's words, kept exactly.\n";
const CRLF_GUIDE = "# Guide\r\n\r\nCafé — the owner's words, no final newline";
const WITH_BLOCK = (block: string) =>
  `# Before\n\n  ${block}\n\nAfter, with a fenced example:\n\n\`\`\`\n${TRACKING_OPEN}\n\`\`\`\n`;
const OLD_BLOCK = `${TRACKING_OPEN}\nold words\n${TRACKING_CLOSE}`;

async function fixture(push: "lead" | "owner" = "lead") {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "project-tracking-")));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const forge = await startLoopbackForge();
  cleanups.push(() => forge.stop());
  await forge.addRepo(GITHUB.publicBoard, { "README.md": { content: "Where public work goes.\n" } });
  const credentials = new FileCredentialStore(join(directory, "credentials.json"));
  const token = mintOperatorToken();
  await credentials.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: token });
  const settings = new SettingsStore(join(directory, "settings.json"));
  await settings.update((current) => ({
    ...current,
    projects: ProjectsSettingsSchema.parse({
      projects: [{ id: "garden", name: "Garden", autonomy: { fleet: { push } } }],
    }),
  }));
  const service = createProjectTrackingService({
    settings,
    forge: async () => githubRestApi({ token: "loopback", baseUrl: forge.baseUrl }),
  });
  const body = await createClankieApp({
    settings,
    captain: createStubCaptain({}),
    projectTracking: service,
    clock: () => new Date(),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === `Bearer ${token}` ? { operatorId: "owner" } : undefined,
  });
  cleanups.push(() => body.close());
  const cli = (...args: string[]) =>
    runProjectCommand(["tracking", "garden", ...args], {
      env: { CLANKIE_OPERATOR_TOKEN: token },
      operatorCredentialStore: credentials,
      host: "http://127.0.0.1:1",
      fetchImpl: async (url, init) => body.app.fetch(new Request(url, init)),
    }) as Promise<{
      repos: TrackingRepoStatus[];
      offer?: { text: string };
      tracking?: { repos: string[] };
    }>;
  return { forge, settings, service, cli, body, token };
}

const byRepo = (statuses: readonly TrackingRepoStatus[], repo: string) =>
  statuses.find((status) => status.repo === repo)!;

it("takes a setting from the CLI through proposal, merge, read-back, drift and a tracker change", async () => {
  const { forge, settings, service, cli } = await fixture();
  await forge.addRepo("fixture/linked", {
    "AGENTS.md": { content: GUIDE },
    "CLAUDE.md": { content: "AGENTS.md", mode: "120000" },
  });
  await forge.addRepo("fixture/included", {
    "AGENTS.md": { content: CRLF_GUIDE },
    "CLAUDE.md": { content: "@AGENTS.md\n" },
  });
  await forge.addRepo("fixture/both", {
    "AGENTS.md": { content: "Agents only, see CLAUDE.md for more.\n" },
    "CLAUDE.md": { content: GUIDE },
  });
  await forge.addRepo("fixture/block", { "CLAUDE.md": { content: WITH_BLOCK(OLD_BLOCK) } });
  await forge.addRepo("fixture/bare", { "README.md": { content: "No guide here.\n" } });
  await forge.addRepo("fixture/broken", { "CLAUDE.md": { content: `${TRACKING_OPEN}\nnever closed\n` } });
  const repos = ["linked", "included", "both", "block", "bare", "broken"].map((name) => `fixture/${name}`);
  const block = renderTrackingBlock(GITHUB, "public");

  const first = await cli(
    "--provider",
    "github",
    "--public-board",
    GITHUB.publicBoard,
    "--private-board",
    GITHUB.privateBoard,
    ...repos.flatMap((repo) => ["--repo", repo]),
  );
  expect((await settings.load()).projects.projects[0]!.tracking).toEqual({ repos, tracker: GITHUB });

  // Each guide rule, and the bytes outside the markers, read from the proposal branch itself.
  expect(byRepo(first.repos, "fixture/linked")).toMatchObject({ state: "proposed", guide: "AGENTS.md" });
  expect(await forge.read("fixture/linked", TRACKING_BRANCH, "AGENTS.md")).toBe(`${GUIDE}\n${block}\n`);
  expect(byRepo(first.repos, "fixture/included")).toMatchObject({ state: "proposed", guide: "AGENTS.md" });
  expect(await forge.read("fixture/included", TRACKING_BRANCH, "AGENTS.md")).toBe(
    `${CRLF_GUIDE}\r\n\r\n${block.replaceAll("\n", "\r\n")}\r\n`,
  );
  expect(await forge.read("fixture/included", TRACKING_BRANCH, "CLAUDE.md")).toBe("@AGENTS.md\n");
  expect(byRepo(first.repos, "fixture/both")).toMatchObject({ state: "proposed", guide: "CLAUDE.md" });
  expect(await forge.read("fixture/block", TRACKING_BRANCH, "CLAUDE.md")).toBe(WITH_BLOCK(block));
  expect(byRepo(first.repos, "fixture/bare")).toMatchObject({ state: "proposed", guide: "CLAUDE.md" });
  expect(await forge.read("fixture/bare", TRACKING_BRANCH, "CLAUDE.md")).toBe(`${block}\n`);
  expect(byRepo(first.repos, "fixture/broken")).toMatchObject({
    state: "refused",
    reason: "malformed_markers",
  });
  expect(forge.pulls("fixture/broken")).toEqual([]);
  // A symlinked guide stays a symlink.
  expect((await forge.read("fixture/linked", TRACKING_BRANCH, "CLAUDE.md")).trim()).toBe("AGENTS.md");

  // Proposing changed no default branch.
  expect(await forge.read("fixture/linked", "main", "AGENTS.md")).toBe(GUIDE);

  // Repeating either pass writes nothing.
  let mark = forge.requests.length;
  await cli("apply");
  await service.sweep();
  expect(forge.writesSince(mark)).toEqual([]);

  // The repo's own rule lands it, and only then does the read-back confirm it.
  const before = await cli();
  expect(byRepo(before.repos, "fixture/linked").state).toBe("proposed");
  await forge.merge("fixture/linked", 1);
  const merged = await cli();
  expect(byRepo(merged.repos, "fixture/linked")).toMatchObject({
    state: "in_step",
    guide: "AGENTS.md",
    confirmedPull: { number: 1 },
  });

  // Drift: someone edits inside the block and outside it. Only the block comes back.
  const edited = `${GUIDE}A line the owner added.\n\n${block.replace("GitHub issues", "Jira")}\n`;
  await forge.push("fixture/linked", "main", { "AGENTS.md": { content: edited } });
  expect(byRepo((await cli()).repos, "fixture/linked")).toMatchObject({
    state: "drifted",
    reason: "block_differs",
  });
  await service.sweep();
  expect(forge.pulls("fixture/linked").map((pull) => pull.state)).toEqual(["closed", "open"]);
  expect(await forge.read("fixture/linked", TRACKING_BRANCH, "AGENTS.md")).toBe(
    `${GUIDE}A line the owner added.\n\n${block}\n`,
  );

  // Closing a proposal is an answer: the sweep leaves it, the owner's apply reopens it.
  forge.close("fixture/both", 1);
  mark = forge.requests.length;
  await service.sweep();
  expect(forge.writesSince(mark)).toEqual([]);
  expect(byRepo((await cli()).repos, "fixture/both")).toMatchObject({
    state: "declined",
    pull: { number: 1 },
  });
  await cli("apply");
  expect(forge.pulls("fixture/both").map((pull) => pull.state)).toEqual(["closed", "open"]);

  // Someone's commit on the proposal branch is theirs: nothing replaces it.
  await forge.push("fixture/bare", TRACKING_BRANCH, { "NOTES.md": { content: "mine\n" } });
  const tip = await forge.head("fixture/bare", TRACKING_BRANCH);

  // A tracker change refreshes open proposals in place and only offers to move issues.
  const openBefore = repos.map((repo) => forge.pulls(repo).length);
  const moved = await cli("--provider", "linear", "--public-board", "VUH", "--private-board", "VUH-PRIVATE");
  expect(moved.offer?.text).toContain("Existing issues stay where they are");
  expect(moved.tracking?.repos).toEqual(repos);
  expect(repos.map((repo) => forge.pulls(repo).length)).toEqual(openBefore);
  expect(await forge.read("fixture/block", TRACKING_BRANCH, "CLAUDE.md")).toBe(
    WITH_BLOCK(
      renderTrackingBlock({ provider: "linear", publicBoard: "VUH", privateBoard: "VUH-PRIVATE" }, "public"),
    ),
  );
  expect(byRepo(moved.repos!, "fixture/bare")).toMatchObject({
    state: "refused",
    reason: expect.stringContaining("proposal_branch_edited"),
  });
  expect(await forge.head("fixture/bare", TRACKING_BRANCH)).toBe(tip);

  // The whole run never reached for an issue or a merge.
  expect(forge.requests.filter((request) => /issues|merge/u.test(request.path))).toEqual([]);
}, 120_000);

it("names the private board only in a repo the forge confirms is private", async () => {
  const { forge, service, cli } = await fixture();
  const secret = "https://linear.app/fixture/project/secret-board";
  const tracker = { ...GITHUB, privateBoard: secret };
  await forge.addRepo("fixture/open", { "CLAUDE.md": { content: GUIDE } }, "public");
  await forge.addRepo("fixture/closed", { "CLAUDE.md": { content: GUIDE } }, "private");
  await forge.addRepo("fixture/unknown", { "CLAUDE.md": { content: GUIDE } }, "unknown");
  await forge.addRepo("fixture/internal", { "CLAUDE.md": { content: GUIDE } }, "internal");
  const proposed = async (repo: string) => ({
    guide: await forge.read(repo, TRACKING_BRANCH, "CLAUDE.md"),
    body: forge.pulls(repo)[0]!.body,
  });

  const saved = await cli(
    "--provider",
    "github",
    "--public-board",
    tracker.publicBoard,
    "--private-board",
    secret,
    ...["open", "closed", "unknown", "internal"].flatMap((name) => ["--repo", `fixture/${name}`]),
  );
  expect(saved.repos.map((repo) => repo.state)).toEqual(Array(4).fill("proposed"));

  for (const repo of ["fixture/open", "fixture/unknown", "fixture/internal"]) {
    const { guide, body } = await proposed(repo);
    expect(guide).toBe(`${GUIDE}\n${renderTrackingBlock(tracker, "public")}\n`);
    expect(guide).toContain(`Public work: ${tracker.publicBoard}`);
    expect(`${guide}${body}`).not.toContain("secret-board");
  }
  const closed = await proposed("fixture/closed");
  expect(closed.guide).toBe(`${GUIDE}\n${renderTrackingBlock(tracker, "private")}\n`);
  expect(closed.guide).toContain(`Private work: ${secret}`);

  // Each pass asks the forge again: a repo made public loses the name from its open proposal.
  forge.setVisibility("fixture/closed", "public");
  await service.sweep();
  const flipped = await proposed("fixture/closed");
  expect(`${flipped.guide}${flipped.body}`).not.toContain("secret-board");

  // A public board the forge won't confirm as public is refused rather than published.
  for (const [board, seen] of [
    ["fixture/hidden", "private"],
    ["https://github.com/fixture/hidden-issues/issues", "unknown"],
    ["fixture/missing", undefined],
  ] as const) {
    const slug = board.replace("https://github.com/", "").replace("/issues", "");
    if (seen) await forge.addRepo(slug, { "README.md": { content: "Board.\n" } }, seen);
    await forge.addRepo(`fixture/${seen ?? "none"}-repo`, { "CLAUDE.md": { content: GUIDE } });
    const mark = forge.requests.length;
    const refused = await cli("--public-board", board, "--repo", `fixture/${seen ?? "none"}-repo`);
    expect(refused.repos[0]).toMatchObject({ state: "refused", reason: "public_board_not_public" });
    expect(forge.writesSince(mark)).toEqual([]);
  }

  // One board for both would put the private board in every public block.
  await expect(cli("--public-board", secret.toUpperCase())).rejects.toThrow("separate boards");
}, 120_000);

it("keeps the setting and every pass behind owner authority", async () => {
  const { forge, body, token } = await fixture();
  const path = `${PROJECT_TRACKING_PATH}?projectId=garden`;
  expect((await body.app.request(path)).status).toBe(401);
  expect((await body.app.request(PROJECT_TRACKING_APPLY_PATH, { method: "POST" })).status).toBe(401);
  const owner = { authorization: `Bearer ${token}` };
  expect((await body.app.request(path, { headers: owner })).status).toBe(200);
  expect(forge.requests).toEqual([]);
  // A client that does not opt in keeps its shape.
  const plain = await body.app.request("/v1/operator/projects", { headers: owner });
  expect(await plain.json()).not.toHaveProperty("projectTracking");
}, 60_000);

it("only reads during a sweep when pushing is the owner's call", async () => {
  const { forge, settings, service, cli } = await fixture("owner");
  await forge.addRepo("fixture/one", { "CLAUDE.md": { content: GUIDE } });
  await settings.update((current) => ({
    ...current,
    projects: {
      ...current.projects,
      projects: [
        ProjectSchema.parse({
          ...current.projects.projects[0]!,
          tracking: { repos: ["fixture/one"], tracker: GITHUB },
        }),
      ],
    },
  }));
  await service.sweep();
  expect(forge.writesSince(0)).toEqual([]);
  expect(byRepo((await cli()).repos, "fixture/one")).toMatchObject({ state: "drifted" });
  await cli("apply");
  expect(forge.pulls("fixture/one")).toHaveLength(1);
}, 60_000);

async function checkout(root: string, name: string, origin: string, messages: string[]) {
  const path = join(root, name);
  await mkdir(path);
  const git = (...args: string[]) =>
    run("git", ["-C", path, "-c", "user.name=F", "-c", "user.email=f@example.invalid", ...args]);
  await git("init", "--quiet");
  await git("remote", "add", "origin", `https://github.com/${origin}.git`);
  await writeFile(join(path, "README.md"), "fixture\n");
  await git("add", ".");
  for (const message of messages) await git("commit", "--quiet", "--allow-empty", "-m", message);
  return path;
}

it("answers from the repos when the signals agree and asks when they do not", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "project-tracking-signals-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const linear = ["VUH-1 one", "VUH-2 two", "VUH-3 three"];
  const github = ["Fixes #1", "Closes #2", "Fixes #3"];
  const workspace = (id: string, path: string) => ({ id, machineId: "local", platform: "posix", path });
  const a = await checkout(root, "a", "fixture/a", linear);
  const b = await checkout(root, "b", "fixture/b", linear);
  const c = await checkout(root, "c", "fixture/c", github);
  const quiet = await checkout(root, "quiet", "fixture/quiet", ["Initial commit"]);

  const project = (workspaces: ReturnType<typeof workspace>[], extra = {}) =>
    ProjectSchema.parse({ id: "garden", name: "Garden", workspaces, ...extra });
  expect(await suggestProjectTracking(project([workspace("a", a), workspace("b", b)]))).toMatchObject({
    repos: ["fixture/a", "fixture/b"],
    provider: "linear",
    publicBoard: "VUH",
    question: "Which board takes private work?",
  });
  const split = await suggestProjectTracking(project([workspace("a", a), workspace("c", c)]));
  expect(split?.provider).toBeUndefined();
  expect(split?.question).toContain("both GitHub and Linear");
  expect((await suggestProjectTracking(project([workspace("q", quiet)])))?.question).toContain(
    "No signal names a tracker",
  );

  // A saved setting stays quiet until the signals move, then it is a proposal, never a change.
  const tracking = { repos: ["fixture/c"], tracker: GITHUB };
  expect(await suggestProjectTracking(project([workspace("c", c)], { tracking }))).toBeUndefined();
  expect(await suggestProjectTracking(project([workspace("a", a)], { tracking }))).toMatchObject({
    provider: "linear",
    movedFromSetting: true,
  });
}, 60_000);
