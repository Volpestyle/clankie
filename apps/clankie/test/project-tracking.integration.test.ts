import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
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
import {
  createProjectTrackingService,
  startProjectTrackingSweep,
  trackedRepoFile,
  type TrackedRepoStore,
} from "../src/project-tracking.ts";
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

async function fixture(
  push: "lead" | "owner" = "lead",
  extraProject: object = {},
  others: object[] = [],
  trackedRepos?: (directory: string) => TrackedRepoStore,
  /** An HTTP status to answer with in the forge's place, for the calls that should fail. */
  gate?: (method: string, path: string) => number | undefined,
) {
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
      projects: [{ id: "garden", name: "Garden", autonomy: { fleet: { push } }, ...extraProject }, ...others],
    }),
  }));
  const alerts: string[] = [];
  const alerting = { delivered: true };
  const service = createProjectTrackingService({
    settings,
    forge: async () =>
      githubRestApi({
        token: "loopback",
        baseUrl: forge.baseUrl,
        fetch: async (url, init) => {
          const status = gate?.(init?.method ?? "GET", new URL(String(url)).pathname);
          return status ? new Response("{}", { status }) : fetch(url, init);
        },
      }),
    suggest: suggestProjectTracking,
    alert: async (text) => {
      alerts.push(text);
      return alerting.delivered;
    },
    ...(trackedRepos ? { trackedRepos: trackedRepos(directory) } : {}),
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
      suggestion?: { publicBoard?: string };
    }>;
  return { forge, settings, service, cli, body, token, alerts, alerting, directory };
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

  // The pull body is outside the block's audience check, so it never holds the block.
  expect(closed.body).not.toContain("secret-board");
  expect(closed.body).not.toContain(TRACKING_OPEN);

  // Each pass asks the forge again: a repo made public gets a fresh proposal naming only the public board.
  forge.setVisibility("fixture/closed", "public");
  await service.sweep();
  const flipped = await proposed("fixture/closed");
  expect(`${flipped.guide}${flipped.body}`).not.toContain("secret-board");
  expect(forge.pulls("fixture/closed").map((pull) => pull.state)).toEqual(["closed", "open"]);

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

const SECRET = "https://linear.app/fixture/project/secret-board";
const saveFlags = (repos: readonly string[], privateBoard = SECRET) => [
  "--provider",
  "github",
  "--public-board",
  GITHUB.publicBoard,
  "--private-board",
  privateBoard,
  ...repos.flatMap((repo) => ["--repo", repo]),
];
const PUBLIC_BLOCK = renderTrackingBlock({ ...GITHUB, privateBoard: SECRET }, "public");
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Anywhere a reader of the repo could still find the board, apart from history already merged. */
async function exposed({ forge }: Fixture, repo: string) {
  const branch = await forge.read(repo, TRACKING_BRANCH, "CLAUDE.md").catch(() => "");
  return [branch, ...forge.pulls(repo).map((pull) => pull.body)].filter((text) =>
    text.includes("secret-board"),
  );
}
const REPO = "fixture/r";

for (const [name, seen] of [
  ["public", "public"],
  ["internal", "internal"],
  ["unconfirmed", "unknown"],
] as const)
  it(`withdraws a proposal naming the private board when a repo turns ${name}`, async () => {
    const context = await fixture();
    const { forge, service, cli } = context;
    await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } }, "private");
    await cli(...saveFlags([REPO]));
    expect(await forge.read(REPO, TRACKING_BRANCH, "CLAUDE.md")).toContain("secret-board");
    forge.setVisibility(REPO, seen);
    await service.sweep();
    expect(forge.pulls(REPO).map((pull) => pull.state)).toEqual(["closed", "open"]);
    expect(await exposed(context, REPO)).toEqual([]);
  }, 60_000);

it("withdraws when the default branch already holds the public block", async () => {
  const context = await fixture();
  const { forge, service, cli } = context;
  await forge.addRepo(REPO, { "CLAUDE.md": { content: `${GUIDE}\n${PUBLIC_BLOCK}\n` } }, "private");
  await cli(...saveFlags([REPO]));
  forge.setVisibility(REPO, "public");
  await service.sweep();
  expect(forge.pulls(REPO).map((pull) => pull.state)).toEqual(["closed"]);
  await expect(forge.head(REPO, TRACKING_BRANCH)).rejects.toThrow();
  expect((await cli()).repos[0]).toMatchObject({ state: "in_step" });
}, 60_000);

it("withdraws on the way to a refusal, and the refusal still stands", async () => {
  const context = await fixture();
  const { forge, service, cli } = context;
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } }, "private");
  await cli(...saveFlags([REPO]));
  await forge.push(REPO, "main", { "CLAUDE.md": { content: `${GUIDE}\n${TRACKING_OPEN}\nunclosed\n` } });
  forge.setVisibility(REPO, "public");
  await service.sweep();
  expect(forge.pulls(REPO).map((pull) => pull.state)).toEqual(["closed"]);
  await expect(forge.head(REPO, TRACKING_BRANCH)).rejects.toThrow();
  expect((await cli()).repos[0]).toMatchObject({ state: "refused", reason: "malformed_markers" });
}, 60_000);

it("withdraws through the owner's apply, which reports the pull it closed", async () => {
  const context = await fixture("owner");
  const { forge, cli } = context;
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } }, "private");
  await cli(...saveFlags([REPO]));
  forge.setVisibility(REPO, "public");
  const applied = await cli("apply");
  expect(applied.repos[0]).toMatchObject({ state: "proposed", withdrawnPull: { number: 1 } });
  expect(await exposed(context, REPO)).toEqual([]);
}, 60_000);

it("withdraws a proposal even when someone else's commit tops it", async () => {
  const context = await fixture();
  const { forge, service, cli } = context;
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } }, "private");
  await cli(...saveFlags([REPO]));
  await forge.push(REPO, TRACKING_BRANCH, { "NOTES.md": { content: "mine\n" } });
  forge.setVisibility(REPO, "public");
  await service.sweep();
  expect(forge.pulls(REPO)[0]!.state).toBe("closed");
  expect(await exposed(context, REPO)).toEqual([]);
}, 60_000);

it("finds the board in a proposal whose markers someone broke", async () => {
  const context = await fixture();
  const { forge, service, cli } = context;
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } }, "private");
  await cli(...saveFlags([REPO]));
  const proposed = await forge.read(REPO, TRACKING_BRANCH, "CLAUDE.md");
  await forge.push(REPO, TRACKING_BRANCH, {
    "CLAUDE.md": { content: proposed.replace(TRACKING_CLOSE, "") },
  });
  forge.setVisibility(REPO, "public");
  await service.sweep();
  expect(forge.pulls(REPO)[0]!.state).toBe("closed");
  expect(await exposed(context, REPO)).toEqual([]);
}, 60_000);

it("withdraws a block naming an earlier private board, and a closed proposal's leftover branch", async () => {
  const context = await fixture();
  const { forge, service, cli } = context;
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } }, "private");
  await forge.addRepo("fixture/left", { "CLAUDE.md": { content: GUIDE } }, "private");
  await cli(...saveFlags([REPO, "fixture/left"]));
  forge.close("fixture/left", 1);
  await cli("--private-board", "fixture/another-private", "--no-apply");
  forge.setVisibility(REPO, "public");
  forge.setVisibility("fixture/left", "public");
  await service.sweep();
  expect(await exposed(context, REPO)).toEqual([]);
  expect(await exposed(context, "fixture/left")).toEqual([]);
  expect(forge.pulls(REPO)[0]!.state).toBe("closed");
}, 60_000);

it("leaves a proposal alone while the repo stays private, and a fenced example alone once public", async () => {
  const { forge, service, cli } = await fixture();
  const example = `Example:\n\n\`\`\`\n${renderTrackingBlock({ ...GITHUB, privateBoard: SECRET }, "private")}\n\`\`\`\n`;
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } }, "private");
  await forge.addRepo("fixture/example", { "CLAUDE.md": { content: example } }, "public");
  await cli(...saveFlags([REPO, "fixture/example"]));
  const mark = forge.requests.length;
  await service.sweep();
  expect(forge.writesSince(mark)).toEqual([]);
  expect(forge.pulls(REPO).map((pull) => pull.state)).toEqual(["open"]);
  expect(forge.pulls("fixture/example").map((pull) => pull.state)).toEqual(["open"]);
}, 60_000);

it("alerts the owner instead of writing when pushing is theirs, once per exposure", async () => {
  const context = await fixture("owner");
  const { forge, service, cli, alerts, alerting } = context;
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } }, "private");
  await cli(...saveFlags([REPO]));
  await service.sweep();
  expect(alerts).toEqual([]);
  forge.setVisibility(REPO, "public");

  const mark = forge.requests.length;
  alerting.delivered = false;
  await service.sweep();
  alerting.delivered = true;
  await service.sweep();
  await service.sweep();
  expect(forge.writesSince(mark)).toEqual([]);
  // The undelivered alert was retried; the delivered one was not repeated.
  expect(alerts).toHaveLength(2);
  expect(alerts[1]).toContain("its proposal #1");
  expect(alerts[1]).toContain("clankie project tracking garden apply");
  expect(alerts.join("")).not.toContain("secret-board");
  expect((await cli()).repos[0]).toMatchObject({
    state: "refused",
    reason: "private_board_exposed",
    pull: { number: 1 },
  });
}, 60_000);

it("alerts when a merged block keeps naming the private board", async () => {
  const { forge, service, cli, alerts } = await fixture("owner");
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } }, "private");
  await cli(...saveFlags([REPO]));
  await forge.merge(REPO, 1);
  forge.setVisibility(REPO, "public");
  const mark = forge.requests.length;

  // The merged branch is still there, and it names the board too.
  await service.sweep();
  expect(alerts.at(-1)).toContain(`its ${TRACKING_BRANCH} branch`);

  // Deleted on merge, the default branch is all that is left.
  await forge.deleteBranch(REPO, TRACKING_BRANCH);
  await service.sweep();
  expect(alerts.at(-1)).toContain("its default branch");
  expect((await cli()).repos[0]).toMatchObject({ state: "drifted", reason: "private_board_published" });
  expect(forge.writesSince(mark)).toEqual([]);
  expect(alerts.join("")).not.toContain("secret-board");
}, 60_000);

it("alerts when the forge refuses the withdrawal", async () => {
  const context = await fixture();
  const { forge, service, cli, alerts } = context;
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } }, "private");
  await cli(...saveFlags([REPO]));
  forge.setVisibility(REPO, "public");
  forge.archive(REPO);
  await service.sweep();
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toContain("its proposal #1");
  expect(alerts[0]).not.toContain("secret-board");
}, 60_000);

it("closes the pull when the branch can't be deleted, alerts, and finishes the job later", async () => {
  const context = await fixture();
  const { forge, service, cli, alerts } = context;
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } }, "private");
  await cli(...saveFlags([REPO]));
  forge.setVisibility(REPO, "public");
  forge.protectBranch(REPO, TRACKING_BRANCH);
  await service.sweep();
  expect(forge.pulls(REPO)[0]!.state).toBe("closed");
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toContain("its proposal #1");
  forge.allowDelete(REPO, TRACKING_BRANCH);
  await service.sweep();
  expect(await exposed(context, REPO)).toEqual([]);
}, 60_000);

it("leaves merged history to the owner and proposes the public block over it", async () => {
  const context = await fixture();
  const { forge, service, cli } = context;
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } }, "private");
  await cli(...saveFlags([REPO]));
  await forge.merge(REPO, 1);
  const merged = await forge.head(REPO, "main");
  forge.setVisibility(REPO, "public");
  await service.sweep();
  expect(await forge.head(REPO, "main")).toBe(merged);
  expect(await forge.read(REPO, TRACKING_BRANCH, "CLAUDE.md")).toBe(`${GUIDE}\n${PUBLIC_BLOCK}\n`);
}, 60_000);

for (const board of [
  "github.com/fixture/hidden",
  "https://www.github.com/fixture/hidden",
  "http://github.com/fixture/hidden",
  "https://GitHub.com/fixture/hidden",
  "https://github.com/fixture/hidden.git",
  "git@github.com:fixture/hidden.git",
  "https://github.com/fixture/hidden/issues/new",
  "https://github.com/fixture/hidden/issues?q=is%3Aopen",
  "https://github.com/fixture/hidden#readme",
])
  it(`refuses a private repo as the public board, spelled ${board}`, async () => {
    const { forge, cli } = await fixture();
    await forge.addRepo("fixture/hidden", { "README.md": { content: "Board.\n" } }, "private");
    await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } });
    const result = await cli(
      "--provider",
      "github",
      "--public-board",
      board,
      "--private-board",
      "fixture/private",
      "--repo",
      REPO,
    );
    expect(result.repos[0]).toMatchObject({ state: "refused", reason: "public_board_not_public" });
    expect(forge.pulls(REPO)).toEqual([]);
  }, 60_000);

for (const [provider, board] of [
  ["github", "https://github.com/users/fixture/projects/3"],
  ["github", "https://github.com/fixture"],
  ["github", "Issues"],
  ["github", "https://github.com.example.org/fixture/public"],
  ["linear", "https://github.com/fixture"],
  ["linear", "https://github.com.example.org/fixture/public"],
  ["linear", "https://raw.githubusercontent.com/fixture/hidden/main/README.md"],
  ["linear", "raw.githubusercontent.com/fixture/hidden"],
  ["linear", "https://fixture.github.io/hidden"],
  ["linear", "https://gist.github.com/fixture/abc"],
  ["linear", "https://gh.io/hidden"],
  ["linear", "https://git.io/hidden"],
  ["linear", "git.io/hidden"],
  ["linear", "https://octo.ghe.com/fixture/hidden"],
  ["linear", "fixture/hidden"],
  ["linear", "fixture/hidden.git"],
  ["linear", "fixture/hidden/issues"],
] as const)
  it(`refuses a ${provider} public board that names no confirmed public repo: ${board}`, async () => {
    const { forge, cli } = await fixture();
    await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } });
    const result = await cli(
      "--provider",
      provider,
      "--public-board",
      board,
      "--private-board",
      "fixture/private",
      "--repo",
      REPO,
    );
    expect(result.repos[0]).toMatchObject({ state: "refused", reason: "public_board_not_public" });
    expect(forge.pulls(REPO)).toEqual([]);
  }, 60_000);

it("takes any spelling of a public repo as the board, and a board with no repo on the owner's word", async () => {
  const { forge, cli } = await fixture();
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } });
  await forge.addRepo("fixture/two", { "CLAUDE.md": { content: GUIDE } });
  const spelled = await cli(
    ...saveFlags([REPO]).map((flag) =>
      flag === GITHUB.publicBoard ? "https://www.github.com/fixture/public/issues" : flag,
    ),
  );
  expect(spelled.repos[0]).toMatchObject({ state: "proposed" });
  const linear = await cli("--provider", "linear", "--public-board", "VUH", "--repo", "fixture/two");
  expect(linear.repos[0]).toMatchObject({ state: "proposed" });
  // A Linear address that only mentions GitHub in its words is still the owner's word.
  const worded = await cli(
    "--public-board",
    "https://linear.app/fixture/project/github-migration-1a2b",
    "--repo",
    "fixture/two",
  );
  expect(worded.repos[0]).toMatchObject({ state: "proposed" });
}, 60_000);

for (const [publicBoard, privateBoard] of [
  ["fixture/public", "https://github.com/fixture/public/issues"],
  ["https://www.github.com/Fixture/Public", "git@github.com:fixture/public.git"],
])
  it(`counts ${publicBoard} and ${privateBoard} as one board`, async () => {
    const { forge, cli } = await fixture();
    await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } });
    await expect(
      cli(
        "--provider",
        "github",
        "--public-board",
        publicBoard!,
        "--private-board",
        privateBoard!,
        "--repo",
        REPO,
      ),
    ).rejects.toThrow("separate boards");
  }, 60_000);

async function declinedThenMerged({ forge, cli }: Fixture) {
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } });
  await cli(...saveFlags([REPO]));
  await forge.merge(REPO, 1);
  const merged = await forge.read(REPO, "main", "CLAUDE.md");
  await forge.push(REPO, "main", { "CLAUDE.md": { content: merged.replace("GitHub issues", "Jira") } });
  await cli("apply");
  forge.close(REPO, 2);
}

it("keeps a declined proposal declined after a comment moves an older pull ahead of it", async () => {
  const context = await fixture();
  const { forge, service, cli } = context;
  await declinedThenMerged(context);
  forge.comment(REPO, 1);
  const mark = forge.requests.length;
  await service.sweep();
  expect(forge.writesSince(mark)).toEqual([]);
  expect((await cli()).repos[0]).toMatchObject({ state: "declined", pull: { number: 2 } });
}, 60_000);

it("finds a declined proposal on a later page of the forge's list", async () => {
  const context = await fixture();
  const { forge, service } = context;
  await declinedThenMerged(context);
  await forge.seedMergedPulls(REPO, 101, TRACKING_BRANCH);
  const mark = forge.requests.length;
  await service.sweep();
  expect(forge.writesSince(mark)).toEqual([]);
}, 60_000);

it("counts only this block's closed proposal as declined", async () => {
  const { forge, service, cli } = await fixture();
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } });
  await cli(...saveFlags([REPO]));
  forge.close(REPO, 1);
  await cli("--public-board", "fixture/public", "--private-board", "fixture/private", "--no-apply");
  expect((await cli()).repos[0]).toMatchObject({ state: "declined" }); // same public block
  await forge.addRepo("fixture/other-public", { "README.md": { content: "Board.\n" } });
  await cli("--public-board", "fixture/other-public", "--no-apply");
  expect((await cli()).repos[0]).toMatchObject({ state: "drifted" });
  await service.sweep();
  expect(forge.pulls(REPO).map((pull) => pull.state)).toEqual(["closed", "open"]);
}, 60_000);

it("only shows a suggestion: repo content saves nothing, overrides nothing and writes nothing", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "project-tracking-suggest-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const path = await checkout(root, "a", REPO, ["EVIL-1 a", "EVIL-2 b", "EVIL-3 c"]);
  const { forge, settings, cli } = await fixture("lead", {
    workspaces: [{ id: "a", machineId: "local", platform: "posix", path }],
  });
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } });
  const before = (await settings.load()).projects;
  const mark = forge.requests.length;

  const shown = await cli("--accept-suggestion", "--private-board", "fixture/private");
  expect(shown.suggestion?.publicBoard).toBe("EVIL");
  expect((await settings.load()).projects).toEqual(before);
  expect(forge.writesSince(mark)).toEqual([]);

  // Saved values survive a later flag and a later suggestion alike.
  await cli(...saveFlags([REPO]));
  const saved = (await settings.load()).projects.projects[0]!.tracking;
  await cli("--accept-suggestion");
  expect((await settings.load()).projects.projects[0]!.tracking).toEqual(saved);
  expect(saved?.tracker.publicBoard).toBe(GITHUB.publicBoard);
  expect(forge.pulls(REPO)).toHaveLength(1);
}, 60_000);

it("refuses a repo two projects both claim, and writes for neither", async () => {
  const tracking = (publicBoard: string, privateBoard: string, repos: string[]) => ({
    repos,
    tracker: { provider: "linear", publicBoard, privateBoard },
  });
  const { forge, service, cli } = await fixture(
    "lead",
    { tracking: tracking("AAA", "AAA-P", ["fixture/r"]) },
    [
      {
        id: "other",
        name: "Other",
        autonomy: { fleet: { push: "lead" } },
        tracking: tracking("BBB", "BBB-P", ["Fixture/R", "fixture/own"]),
      },
    ],
  );
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } }, "private");
  await forge.addRepo("fixture/own", { "CLAUDE.md": { content: GUIDE } }, "private");
  await service.sweep();
  expect(forge.pulls(REPO)).toEqual([]);
  expect(forge.pulls("fixture/own")).toHaveLength(1);
  expect((await cli()).repos[0]).toMatchObject({
    state: "refused",
    reason: "repo_in_two_projects: also in other",
  });
  expect((await cli("apply")).repos[0]).toMatchObject({ state: "refused" });
}, 60_000);

it("still withdraws an exposed proposal in a repo two projects claim", async () => {
  const context = await fixture();
  const { forge, settings, service, cli } = context;
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } }, "private");
  await cli(...saveFlags([REPO]));
  await settings.update((current) => ({
    ...current,
    projects: {
      ...current.projects,
      projects: [
        ...current.projects.projects,
        ProjectSchema.parse({
          id: "other",
          name: "Other",
          tracking: { repos: [REPO], tracker: { ...GITHUB, publicBoard: "fixture/public2" } },
        }),
      ],
    },
  }));
  forge.setVisibility(REPO, "public");
  await service.sweep();
  expect(forge.pulls(REPO).map((pull) => pull.state)).toEqual(["closed"]);
  expect(await exposed(context, REPO)).toEqual([]);
}, 60_000);

it("finds a block behind inline code that starts a line, and replaces one above an unclosed fence", async () => {
  const { forge, cli } = await fixture();
  const guide = `\`\`\`pnpm\`\`\` is the tool.\n\n${OLD_BLOCK}\n\n\`\`\`\nstill open\n`;
  await forge.addRepo(REPO, { "CLAUDE.md": { content: guide } });
  await forge.addRepo("fixture/open-fence", { "CLAUDE.md": { content: `${GUIDE}\n\`\`\`\nopen\n` } });
  const result = await cli(...saveFlags([REPO, "fixture/open-fence"]));
  expect(result.repos[0]).toMatchObject({ state: "proposed" });
  expect(await forge.read(REPO, TRACKING_BRANCH, "CLAUDE.md")).toBe(guide.replace(OLD_BLOCK, PUBLIC_BLOCK));
  expect(result.repos[1]).toMatchObject({ state: "refused", reason: "unclosed_code_fence" });
}, 60_000);

it("proposes against the repo's own default branch", async () => {
  const { forge, cli } = await fixture();
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } }, "public", "trunk");
  expect((await cli(...saveFlags([REPO]))).repos[0]).toMatchObject({ state: "proposed" });
  expect(forge.pulls(REPO)[0]!.base.ref).toBe("trunk");
  await forge.merge(REPO, 1);
  expect((await cli()).repos[0]).toMatchObject({ state: "in_step", confirmedPull: { number: 1 } });
}, 60_000);

it("replaces its own proposal when the default branch has moved past it", async () => {
  const { forge, cli } = await fixture();
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } });
  await forge.addRepo("fixture/other-public", { "README.md": { content: "Board.\n" } });
  await cli(...saveFlags([REPO]));
  await forge.push(REPO, "main", { "OTHER.md": { content: "moved on\n" } });
  const moved = await cli("--public-board", "fixture/other-public");
  expect(moved.repos[0]).toMatchObject({ state: "proposed", pull: { number: 1 } });
  expect(await forge.read(REPO, TRACKING_BRANCH, "OTHER.md")).toBe("moved on\n");
  expect(await forge.read(REPO, TRACKING_BRANCH, "CLAUDE.md")).toContain("fixture/other-public");
}, 60_000);

it("keeps an open proposal's description in step with what it now changes", async () => {
  const { forge, cli } = await fixture();
  await forge.addRepo(REPO, { "README.md": { content: "No guide.\n" } });
  await forge.addRepo("fixture/other-public", { "README.md": { content: "Board.\n" } });
  await cli(...saveFlags([REPO]));
  expect(forge.pulls(REPO)[0]!.body).toContain("creates `CLAUDE.md`");
  await forge.push(REPO, "main", { "AGENTS.md": { content: GUIDE } });
  await cli("--public-board", "fixture/other-public");
  expect(forge.pulls(REPO)[0]!.body).toContain("in `AGENTS.md`");
}, 60_000);

it("refuses an archived repo and a renamed one without a write", async () => {
  const { forge, cli } = await fixture();
  await forge.addRepo("fixture/old", { "CLAUDE.md": { content: GUIDE } });
  await forge.addRepo("fixture/moved", { "CLAUDE.md": { content: GUIDE } });
  forge.archive("fixture/old");
  forge.rename("fixture/moved", "fixture/new-name");
  const mark = forge.requests.length;
  const { repos } = await cli(...saveFlags(["fixture/old", "fixture/moved"]));
  expect(repos[0]).toMatchObject({ state: "refused", reason: "repository_archived" });
  expect(repos[1]).toMatchObject({ state: "refused", reason: "repository_moved: now fixture/new-name" });
  expect(forge.writesSince(mark).filter((write) => write.path.includes("fixture/"))).toEqual([]);
}, 60_000);

it("does not take a fork's pull on the same branch name for its own proposal", async () => {
  const { forge, cli } = await fixture();
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } });
  const fork = await forge.forkPull(REPO, "fixture/r-fork", TRACKING_BRANCH);
  const gone = await forge.forkPull(REPO, null, TRACKING_BRANCH);
  const result = await cli(...saveFlags([REPO]));
  expect(result.repos[0]).toMatchObject({ state: "proposed", pull: { number: 3 } });
  expect(forge.pulls(REPO)[fork - 1]!.body).toBe("");
  expect(forge.pulls(REPO)[gone - 1]!.state).toBe("open");
}, 60_000);

it("keeps a foreign commit on a closed proposal's branch", async () => {
  const { forge, cli } = await fixture();
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } });
  await cli(...saveFlags([REPO]));
  forge.close(REPO, 1);
  await forge.push(REPO, TRACKING_BRANCH, { "NOTES.md": { content: "mine\n" } });
  const tip = await forge.head(REPO, TRACKING_BRANCH);
  const after = await cli("apply");
  expect(after.repos[0]).toMatchObject({
    state: "refused",
    reason: expect.stringContaining("proposal_branch_edited"),
  });
  expect(await forge.head(REPO, TRACKING_BRANCH)).toBe(tip);
}, 60_000);

it("refuses a guide that links elsewhere and one that is not UTF-8, with no write", async () => {
  const { forge, cli } = await fixture();
  await forge.addRepo("fixture/link", { "CLAUDE.md": { content: "docs/guide.md", mode: "120000" } });
  await forge.addRepo("fixture/bytes", {
    "CLAUDE.md": { content: Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]) },
  });
  const mark = forge.requests.length;
  const { repos } = await cli(...saveFlags(["fixture/link", "fixture/bytes"]));
  expect(repos[0]).toMatchObject({
    state: "refused",
    reason: expect.stringContaining("unsupported_guide"),
  });
  expect(repos[1]).toMatchObject({ state: "refused", reason: "guide_not_utf8: CLAUDE.md" });
  expect(forge.writesSince(mark)).toEqual([]);
}, 60_000);

const PRIVATE_BLOCK = renderTrackingBlock({ ...GITHUB, privateBoard: SECRET }, "private");
const writes = ({ forge }: Fixture, mark: number) =>
  forge.writesSince(mark).map((request) => `${request.method} ${request.path}`);
const DEFAULT_BRANCH_ALERT = "its default branch still names the private board";

for (const deleted of [false, true])
  it(`alerts on a merged block when the sweep proposes over it, branch ${deleted ? "deleted" : "kept"}`, async () => {
    const { forge, service, cli, alerts } = await fixture();
    await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } }, "private");
    await cli(...saveFlags([REPO]));
    await forge.merge(REPO, 1);
    if (deleted) await forge.deleteBranch(REPO, TRACKING_BRANCH);
    forge.setVisibility(REPO, "public");
    // The pass that writes the proposal is the one that tells the owner.
    await service.sweep();
    expect(alerts).toHaveLength(1);
    await service.sweep();
    expect(await forge.read(REPO, "main", "CLAUDE.md")).toContain("secret-board");
    expect((await cli()).repos[0]).toMatchObject({ state: "proposed", reason: "private_board_published" });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain(DEFAULT_BRANCH_ALERT);
    expect(alerts[0]).not.toContain("secret-board");
  }, 60_000);

it("alerts on a merged block while a public proposal is open under push: owner", async () => {
  const { forge, service, cli, alerts } = await fixture("owner");
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } }, "private");
  await cli(...saveFlags([REPO]));
  await forge.merge(REPO, 1);
  forge.setVisibility(REPO, "public");
  await cli("apply");
  await service.sweep();
  expect(alerts.join("")).toContain(DEFAULT_BRANCH_ALERT);
}, 60_000);

const REFUSED_OVER_A_MERGED_BLOCK: [string, string, (context: Fixture) => Promise<unknown>][] = [
  ["archived", "repository_archived", async ({ forge }) => forge.archive(REPO)],
  ["moved", "repository_moved", async ({ forge }) => forge.rename(REPO, "fixture/renamed")],
  [
    "a board gone private",
    "public_board_not_public",
    async ({ forge }) => forge.setVisibility(GITHUB.publicBoard, "private"),
  ],
  [
    "broken markers",
    "malformed_markers",
    async ({ forge }) =>
      forge.push(REPO, "main", {
        "CLAUDE.md": { content: `${GUIDE}\n${PRIVATE_BLOCK.replace(TRACKING_CLOSE, "")}\n` },
      }),
  ],
  [
    "a second block",
    "duplicate_blocks",
    async ({ forge }) => forge.push(REPO, "main", { "AGENTS.md": { content: `${OLD_BLOCK}\n` } }),
  ],
  [
    "a guide that links elsewhere",
    "unsupported_guide",
    async ({ forge }) =>
      forge.push(REPO, "main", {
        "AGENTS.md": { content: "docs/guide.md", mode: "120000" },
      }),
  ],
  [
    "bytes that aren't UTF-8",
    "guide_not_utf8",
    async ({ forge }) =>
      forge.push(REPO, "main", {
        "CLAUDE.md": { content: Buffer.from(`${PRIVATE_BLOCK}\n\xe9`, "latin1") },
      }),
  ],
];
for (const [name, reason, arrange] of REFUSED_OVER_A_MERGED_BLOCK)
  it(`alerts on a merged block in a repo refused for ${name}`, async () => {
    const context = await fixture("owner");
    const { forge, service, cli, alerts } = context;
    await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } }, "private");
    await cli(...saveFlags([REPO]));
    await forge.merge(REPO, 1);
    await forge.deleteBranch(REPO, TRACKING_BRANCH);
    await arrange(context);
    forge.setVisibility(REPO, "public");
    const mark = forge.requests.length;
    await service.sweep();
    expect(alerts.join("")).toContain(DEFAULT_BRANCH_ALERT);
    expect(forge.writesSince(mark)).toEqual([]);
    // The refusal is still what the owner reads.
    const status = (await cli()).repos[0]!;
    expect(status.state).toBe("refused");
    expect(status.reason).toContain(reason);
  }, 60_000);

it("names both places when a proposal and the default branch hold the board", async () => {
  const { forge, service, cli, alerts } = await fixture("owner");
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } }, "private");
  await cli(...saveFlags([REPO]));
  await forge.merge(REPO, 1);
  await forge.push(REPO, TRACKING_BRANCH, { "NOTES.md": { content: "still here\n" } });
  forge.setVisibility(REPO, "public");
  await service.sweep();
  expect(alerts[0]).toContain(`its default branch and its ${TRACKING_BRANCH} branch still name`);
}, 60_000);

it("closes only this repo's own proposal: no other pull, branch or repo", async () => {
  const context = await fixture();
  const { forge, service, cli } = context;
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } }, "private");
  await forge.addRepo("fixture/stays", { "CLAUDE.md": { content: GUIDE } }, "private");
  await cli(...saveFlags([REPO, "fixture/stays"]));
  const others = [
    await forge.forkPull(REPO, "stranger/r", TRACKING_BRANCH),
    await forge.forkPull(REPO, null, TRACKING_BRANCH),
    await forge.forkPull(REPO, REPO, "feature"),
    await forge.forkPull(REPO, REPO, `${TRACKING_BRANCH}-2`),
  ];
  forge.setVisibility(REPO, "public");
  const main = await forge.head(REPO, "main");
  const mark = forge.requests.length;
  await service.sweep();
  expect(writes(context, mark).filter((write) => /^(?:DELETE|PATCH)/u.test(write))).toEqual([
    `PATCH /repos/${REPO}/pulls/1`,
    `DELETE /repos/${REPO}/git/refs/heads/${TRACKING_BRANCH}`,
  ]);
  expect(writes(context, mark).every((write) => write.includes(`/repos/${REPO}/`))).toBe(true);
  for (const number of others) expect(forge.pulls(REPO)[number - 1]!.state).toBe("open");
  expect(await forge.head(REPO, "main")).toBe(main);
  expect(forge.pulls("fixture/stays")[0]!.state).toBe("open");
}, 60_000);

const LEAVING: [string, (context: Fixture) => Promise<unknown>][] = [
  ["cleared", ({ cli }) => cli("clear")],
  ["dropped", ({ cli }) => cli("--repo", "fixture/keep", "--no-apply")],
];
for (const [how, leave] of LEAVING) {
  it(`withdraws a proposal naming the board from a repo ${how} from the setting`, async () => {
    const context = await fixture();
    const { forge, service, cli, alerts } = context;
    await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } }, "private");
    await forge.addRepo("fixture/keep", { "CLAUDE.md": { content: GUIDE } }, "private");
    await cli(...saveFlags([REPO, "fixture/keep"]));
    await leave(context);
    const mark = forge.requests.length;
    await service.sweep();
    // While it is still private: nothing will be watching when it turns public.
    expect(forge.pulls(REPO)[0]!.state).toBe("closed");
    expect(await exposed(context, REPO)).toEqual([]);
    expect(writes(context, mark)).toEqual(
      expect.arrayContaining([
        `PATCH /repos/${REPO}/pulls/1`,
        `DELETE /repos/${REPO}/git/refs/heads/${TRACKING_BRANCH}`,
      ]),
    );
    expect(forge.pulls(REPO)).toHaveLength(1);
    expect(alerts).toEqual([]);
    if (how === "dropped") expect(forge.pulls("fixture/keep")[0]!.state).toBe("open");

    const settled = forge.requests.length;
    await service.sweep();
    expect(writes(context, settled).filter((write) => write.includes(REPO))).toEqual([]);
  }, 60_000);

  it(`alerts instead of writing when a repo is ${how} under push: owner, until the proposal goes`, async () => {
    const context = await fixture("owner");
    const { forge, service, cli, alerts, alerting } = context;
    await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } }, "private");
    await forge.addRepo("fixture/keep", { "CLAUDE.md": { content: GUIDE } }, "private");
    await cli(...saveFlags([REPO, "fixture/keep"]));
    await leave(context);
    const mark = forge.requests.length;
    alerting.delivered = false;
    await service.sweep();
    alerting.delivered = true;
    await service.sweep();
    await service.sweep();
    expect(forge.writesSince(mark)).toEqual([]);
    const about = alerts.filter((alert) => alert.startsWith(REPO));
    expect(about).toHaveLength(2);
    expect(about[1]).toContain(`${REPO} left project garden's tracking setting`);
    expect(about[1]).toContain("its proposal #1");
    expect(about[1]).not.toContain("secret-board");
    // Once the owner has dealt with it the repo is forgotten, so it can't alert again.
    forge.close(REPO, 1);
    await forge.deleteBranch(REPO, TRACKING_BRANCH);
    await service.sweep();
    const reads = forge.requests.length;
    await service.sweep();
    expect(forge.requests.slice(reads).filter((request) => request.path.includes(REPO))).toEqual([]);
  }, 60_000);
}

it("keeps a proposal when its repo comes back, or moves to another project, before the sweep", async () => {
  const { forge, service, cli, settings } = await fixture();
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } }, "private");
  await forge.addRepo("fixture/moved", { "CLAUDE.md": { content: GUIDE } }, "private");
  await forge.addRepo("fixture/keep", { "CLAUDE.md": { content: GUIDE } }, "private");
  await cli(...saveFlags([REPO, "fixture/moved", "fixture/keep"]));
  await cli("--repo", "fixture/keep", "--no-apply");
  await cli("--repo", "fixture/keep", "--repo", REPO, "--no-apply");
  await settings.update((current) => ({
    ...current,
    projects: ProjectsSettingsSchema.parse({
      projects: [
        ...current.projects.projects,
        ProjectSchema.parse({
          id: "shed",
          name: "Shed",
          tracking: {
            repos: ["FIXTURE/moved"],
            tracker: { ...GITHUB, privateBoard: SECRET },
          },
        }),
      ],
    }),
  }));
  await service.sweep();
  expect(forge.pulls(REPO)[0]!.state).toBe("open");
  expect(forge.pulls("fixture/moved")[0]!.state).toBe("open");
}, 60_000);

it("finds a repo that left the setting after a restart, and retries one the forge refused", async () => {
  const context = await fixture("lead", {}, [], (directory) =>
    trackedRepoFile(join(directory, "tracked.json")),
  );
  const { forge, settings, cli, directory } = context;
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } }, "private");
  await cli(...saveFlags([REPO]));
  await cli("clear");
  forge.protectBranch(REPO, TRACKING_BRANCH);
  const alerts: string[] = [];
  const restarted = createProjectTrackingService({
    settings,
    forge: async () => githubRestApi({ token: "loopback", baseUrl: forge.baseUrl }),
    alert: async (text) => Boolean(alerts.push(text)),
    trackedRepos: trackedRepoFile(join(directory, "tracked.json")),
  });
  await restarted.sweep();
  expect(forge.pulls(REPO)[0]!.state).toBe("closed");
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toContain("left project garden's tracking setting");
  forge.allowDelete(REPO, TRACKING_BRANCH);
  await restarted.sweep();
  expect(await exposed(context, REPO)).toEqual([]);
}, 60_000);

it("carries on with the sweep when the tracked repos can't be read, and saves nothing over them", async () => {
  const saves: unknown[] = [];
  const context = await fixture("lead", {}, [], () => ({
    load: async () => {
      throw new Error("unreadable");
    },
    save: async (repos) => void saves.push(repos),
  }));
  const { forge, service, cli } = context;
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } }, "private");
  await cli(...saveFlags([REPO]));
  forge.setVisibility(REPO, "public");
  await service.sweep();
  expect(forge.pulls(REPO)[0]!.state).toBe("closed");
  expect(saves).toEqual([]);
}, 60_000);

it("finds the configured board in a block a commit wrapped in a fence", async () => {
  const context = await fixture();
  const { forge, service, cli } = context;
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } }, "private");
  await cli(...saveFlags([REPO]));
  const proposed = await forge.read(REPO, TRACKING_BRANCH, "CLAUDE.md");
  await forge.push(REPO, TRACKING_BRANCH, {
    "CLAUDE.md": {
      content: proposed
        .replace(TRACKING_OPEN, `\`\`\`\n${TRACKING_OPEN}`)
        .replace(TRACKING_CLOSE, `${TRACKING_CLOSE}\n\`\`\``),
    },
  });
  forge.setVisibility(REPO, "public");
  await service.sweep();
  expect(forge.pulls(REPO)[0]!.state).toBe("closed");
  expect(await exposed(context, REPO)).toEqual([]);
}, 60_000);

it("alerts once on a default branch that names the board in a fence, without churning its proposal", async () => {
  const context = await fixture();
  const { forge, service, cli, alerts } = context;
  await forge.addRepo(REPO, { "CLAUDE.md": { content: `${GUIDE}\n\`\`\`\n${PRIVATE_BLOCK}\n\`\`\`\n` } });
  await cli(...saveFlags([REPO]));
  const mark = forge.requests.length;
  await service.sweep();
  await service.sweep();
  expect(forge.writesSince(mark)).toEqual([]);
  expect(forge.pulls(REPO).map((pull) => pull.state)).toEqual(["open"]);
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toContain(DEFAULT_BRANCH_ALERT);
}, 60_000);

it("doesn't take a longer name for the private board", async () => {
  const { forge, service, cli, alerts } = await fixture();
  await forge.addRepo(REPO, { "CLAUDE.md": { content: `${GUIDE}\nSee fixture/private-notes.\n` } });
  await cli(...saveFlags([REPO], "fixture/private"));
  await service.sweep();
  expect(alerts).toEqual([]);
  expect(forge.pulls(REPO).map((pull) => pull.state)).toEqual(["open"]);
}, 60_000);

it("doesn't take the public block's own words for the private board", async () => {
  const { forge, service, cli, alerts } = await fixture();
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } });
  await cli(...saveFlags([REPO], "repo"));
  await forge.merge(REPO, 1);
  await service.sweep();
  expect(alerts).toEqual([]);
  expect((await cli()).repos[0]).toMatchObject({ state: "in_step" });
}, 60_000);

it("finds an earlier board behind broken markers, on the branch and on the default branch", async () => {
  const context = await fixture("owner");
  const { forge, service, cli, alerts } = context;
  const broken = `${GUIDE}\n${PRIVATE_BLOCK.replace(TRACKING_CLOSE, "")}\n`;
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } }, "private");
  await forge.addRepo("fixture/onmain", { "CLAUDE.md": { content: broken } }, "private");
  await cli(...saveFlags([REPO, "fixture/onmain"]));
  await forge.push(REPO, TRACKING_BRANCH, { "CLAUDE.md": { content: broken } });
  await cli("--private-board", "fixture/another-private", "--no-apply");
  forge.setVisibility(REPO, "public");
  forge.setVisibility("fixture/onmain", "public");
  await service.sweep();
  expect(alerts.join("")).toContain(`${REPO} is no longer confirmed private, and its proposal #1`);
  expect(alerts.join("")).toContain(`fixture/onmain is no longer confirmed private, and its default branch`);
}, 60_000);

it("sweeps once at start, so a restart doesn't put the next pass an interval off", async () => {
  let passes = 0;
  let finish = () => {};
  const sweep = startProjectTrackingSweep(
    {
      sweep: () => {
        passes += 1;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    },
    () => {},
    60 * 60 * 1000,
  );
  cleanups.push(async () => sweep.stop());
  expect(passes).toBe(1);
  finish();
}, 60_000);

it("withdraws even when the default branch's guide can't be read", async () => {
  const context = await fixture();
  const { forge, service, cli } = context;
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } }, "private");
  await cli(...saveFlags([REPO]));
  await forge.push(REPO, "main", { "CLAUDE.md": { content: "x".repeat(1024 * 1024 + 1) } });
  forge.setVisibility(REPO, "public");
  await service.sweep();
  expect(forge.pulls(REPO)[0]!.state).toBe("closed");
  expect(await exposed(context, REPO)).toEqual([]);
}, 60_000);

type Gate = (method: string, path: string) => number | undefined;
/** A gate the test turns on once the repo is arranged. */
const failing = (decide: Gate) => {
  const switched = { on: false };
  const gate: Gate = (method, path) => (switched.on ? decide(method, path) : undefined);
  return { switched, gate };
};
const gitBlobSha = (content: string) =>
  createHash("sha1")
    .update(`blob ${String(Buffer.byteLength(content))}\0${content}`)
    .digest("hex");
const REF = `/repos/${REPO}/git/ref/heads/${TRACKING_BRANCH}`;

/** A merged proposal, so the default branch of a repo that then turned public names the board. */
async function publishBoard({ forge, cli }: Fixture, guides: Record<string, { content: string }> = {}) {
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE }, ...guides }, "private");
  await cli(...saveFlags([REPO]));
  await forge.merge(REPO, 1);
  await forge.deleteBranch(REPO, TRACKING_BRANCH);
  forge.setVisibility(REPO, "public");
}

const AGENTS_GUIDE = "# Agents\n\nThe owner's other guide.\n";
const FAILURE_ROUTES: [string, "lead" | "owner", Gate][] = [
  ["a token that can't write", "lead", (method) => (method === "GET" ? undefined : 403)],
  [
    "a refused tree",
    "lead",
    (method, path) => (method === "POST" && path.endsWith("/git/trees") ? 403 : undefined),
  ],
  [
    "a refused pull",
    "lead",
    (method, path) => (method === "POST" && path.endsWith("/pulls") ? 422 : undefined),
  ],
  [
    "a failed pull list",
    "lead",
    (method, path) => (method === "GET" && path.endsWith("/pulls") ? 502 : undefined),
  ],
  [
    "a failed pull list, only reading",
    "owner",
    (method, path) => (method === "GET" && path.endsWith("/pulls") ? 502 : undefined),
  ],
  [
    "a failed board read",
    "lead",
    (method, path) => (method === "GET" && path === "/repos/fixture/public" ? 502 : undefined),
  ],
  [
    "a failed board read, only reading",
    "owner",
    (method, path) => (method === "GET" && path === "/repos/fixture/public" ? 502 : undefined),
  ],
  ["a failed branch read", "lead", (method, path) => (method === "GET" && path === REF ? 502 : undefined)],
  [
    "a failed branch read, only reading",
    "owner",
    (method, path) => (method === "GET" && path === REF ? 502 : undefined),
  ],
  [
    "one guide that won't read",
    "lead",
    (method, path) => (method === "GET" && path.endsWith(gitBlobSha(AGENTS_GUIDE)) ? 502 : undefined),
  ],
  [
    "one guide that won't read, only reading",
    "owner",
    (method, path) => (method === "GET" && path.endsWith(gitBlobSha(AGENTS_GUIDE)) ? 502 : undefined),
  ],
];
for (const [name, push, decide] of FAILURE_ROUTES)
  it(`alerts once on a published board through ${name}`, async () => {
    const { switched, gate } = failing(decide);
    const context = await fixture(push, {}, [], undefined, gate);
    await publishBoard(context, { "AGENTS.md": { content: AGENTS_GUIDE } });
    switched.on = true;
    for (let pass = 0; pass < 3; pass += 1) await context.service.sweep();
    expect(context.alerts).toHaveLength(1);
    expect(context.alerts[0]).toContain(
      `${REPO} is no longer confirmed private, and its default branch still names`,
    );
    expect(context.alerts[0]).not.toContain("secret-board");
    expect(context.forge.pulls(REPO)).toHaveLength(1);
  }, 60_000);

it("reports a published board to the owner's own read and apply when the forge fails after it", async () => {
  const { switched, gate } = failing((method, path) =>
    method === "GET" && path.endsWith("/pulls") ? 502 : undefined,
  );
  const context = await fixture("lead", {}, [], undefined, gate);
  await publishBoard(context);
  switched.on = true;
  expect((await context.cli()).repos[0]).toMatchObject({
    state: "unavailable",
    reason: expect.stringMatching(/^private_board_published: GitHub GET/u) as string,
  });
  expect((await context.cli("apply")).repos[0]!.reason).toMatch(/^private_board_published: GitHub GET/u);
}, 60_000);

it("doesn't alert again because a different call failed on the next pass", async () => {
  let failure: string | undefined;
  const context = await fixture("lead", {}, [], undefined, (method, path) =>
    failure && method === "GET" && path.endsWith(failure) ? 502 : undefined,
  );
  await publishBoard(context);
  failure = "/pulls";
  await context.service.sweep();
  failure = "/repos/fixture/public";
  await context.service.sweep();
  expect(context.alerts).toHaveLength(1);
}, 60_000);

/** A public repo naming the board on its default branch and in an open pull, whose next read after a delete fails. */
async function failsAfterWithdrawing(push: "lead" | "owner" = "lead") {
  let deleted = false;
  const context = await fixture(push, {}, [], undefined, (method, path) => {
    deleted ||= method === "DELETE";
    return deleted && method === "GET" && path === `/repos/${REPO}` ? 502 : undefined;
  });
  const { forge, cli } = context;
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } }, "private");
  await cli(...saveFlags([REPO]));
  await forge.merge(REPO, 1);
  await forge.push(REPO, TRACKING_BRANCH, { "NOTES.md": { content: "still here\n" } });
  await githubRestApi({ token: "person", baseUrl: forge.baseUrl }).request("POST", `repos/${REPO}/pulls`, {
    title: "Theirs",
    head: TRACKING_BRANCH,
    base: "main",
    body: "",
  });
  forge.setVisibility(REPO, "public");
  return context;
}

it("keeps the owner's alert when the read after a withdrawal fails", async () => {
  const { service, forge, alerts } = await failsAfterWithdrawing();
  await service.sweep();
  expect(forge.pulls(REPO)[1]!.state).toBe("closed");
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toContain("its default branch still names");
}, 60_000);

it("still names the pull it closed when the read after a withdrawal fails", async () => {
  const { cli } = await failsAfterWithdrawing();
  const [status] = (await cli("apply")).repos;
  expect(status).toMatchObject({ state: "unavailable", withdrawnPull: { number: 2 } });
  expect(status!.reason).toMatch(/^private_board_published: /u);
}, 60_000);

it("alerts on a proposal it can't list the pulls for, and withdraws it once it can", async () => {
  const { switched, gate } = failing((method, path) =>
    method === "GET" && path.endsWith("/pulls") ? 502 : undefined,
  );
  const context = await fixture("lead", {}, [], undefined, gate);
  const { forge, service, cli, alerts } = context;
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } }, "private");
  await cli(...saveFlags([REPO]));
  forge.setVisibility(REPO, "public");
  switched.on = true;
  await service.sweep();
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toContain(`its ${TRACKING_BRANCH} branch still names`);
  expect(forge.pulls(REPO)[0]!.state).toBe("open");
  switched.on = false;
  await service.sweep();
  expect(forge.pulls(REPO)[0]!.state).toBe("closed");
  expect(await exposed(context, REPO)).toEqual([]);
}, 60_000);

it("withdraws on what the branch's other guide says when one of them won't read", async () => {
  const { switched, gate } = failing((method, path) =>
    method === "GET" && path.endsWith(gitBlobSha(AGENTS_GUIDE)) ? 502 : undefined,
  );
  const context = await fixture("lead", {}, [], undefined, gate);
  const { forge, service, cli } = context;
  await forge.addRepo(
    REPO,
    { "CLAUDE.md": { content: GUIDE }, "AGENTS.md": { content: AGENTS_GUIDE } },
    "private",
  );
  await cli(...saveFlags([REPO]));
  forge.setVisibility(REPO, "public");
  switched.on = true;
  await service.sweep();
  expect(forge.pulls(REPO)[0]!.state).toBe("closed");
  expect(await exposed(context, REPO)).toEqual([]);
}, 60_000);

const FOREIGN_BLOCK = `${TRACKING_OPEN}\n## Theirs\n- Private work: someone-elses-board\n${TRACKING_CLOSE}\n`;
/** Someone who is not Clankie: their branch of that name, their commit, their open pull. */
async function foreignBranch({ forge }: Fixture, repo: string) {
  const api = githubRestApi({ token: "person", baseUrl: forge.baseUrl });
  await api.request("POST", `repos/${repo}/git/refs`, {
    ref: `refs/heads/${TRACKING_BRANCH}`,
    sha: await forge.head(repo, "main"),
  });
  await forge.push(repo, TRACKING_BRANCH, { "CLAUDE.md": { content: FOREIGN_BLOCK } });
  await api.request("POST", `repos/${repo}/pulls`, {
    title: "Mine",
    head: TRACKING_BRANCH,
    base: "main",
    body: "",
  });
}
const repoRequests = ({ forge }: Fixture, mark: number) =>
  forge.requests.slice(mark).filter((request) => request.path.includes(REPO));
/** Tracked and proposed to, then dropped, with another repo keeping the setting alive. */
async function departing(context: Fixture, seen: "private" | "public" = "private") {
  const { forge, cli } = context;
  await forge.addRepo("fixture/keep", { "CLAUDE.md": { content: GUIDE } }, "private");
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } }, seen);
  await cli(...saveFlags([REPO, "fixture/keep"]));
}
const drop = ({ cli }: Fixture) => cli("--repo", "fixture/keep", "--no-apply");

it("leaves alone a branch of that name Clankie never wrote once its repo leaves the setting", async () => {
  const context = await fixture();
  const { forge, service, cli, alerts } = context;
  await forge.addRepo("fixture/keep", { "CLAUDE.md": { content: GUIDE } }, "private");
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } }, "private");
  await foreignBranch(context, REPO);
  await cli(...saveFlags([REPO, "fixture/keep"]));
  await drop(context);
  const tip = await forge.head(REPO, TRACKING_BRANCH);
  const mark = forge.requests.length;
  await service.sweep();
  expect(forge.writesSince(mark).filter((write) => write.path.includes(REPO))).toEqual([]);
  expect(await forge.head(REPO, TRACKING_BRANCH)).toBe(tip);
  expect(forge.pulls(REPO)[0]!.state).toBe("open");
  expect(alerts).toEqual([]);
  const forgotten = forge.requests.length;
  await service.sweep();
  expect(repoRequests(context, forgotten)).toEqual([]);
}, 60_000);

it("tells the owner about a proposal someone else committed on once its repo leaves, and doesn't touch it", async () => {
  const context = await fixture();
  const { forge, service, alerts } = context;
  await departing(context);
  await forge.push(REPO, TRACKING_BRANCH, { "NOTES.md": { content: "a person's work\n" } });
  await drop(context);
  const mark = forge.requests.length;
  await service.sweep();
  expect(forge.writesSince(mark).filter((write) => write.path.includes(REPO))).toEqual([]);
  expect(forge.pulls(REPO)[0]!.state).toBe("open");
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toContain(
    `${REPO} left project garden's tracking setting, and its proposal #1 still names`,
  );
  forge.close(REPO, 1);
  await forge.deleteBranch(REPO, TRACKING_BRANCH);
  await service.sweep();
  const forgotten = forge.requests.length;
  await service.sweep();
  expect(repoRequests(context, forgotten)).toEqual([]);
}, 60_000);

it("only reports Clankie's block for an earlier board once its repo leaves, because that isn't this board", async () => {
  const context = await fixture("lead", {}, [], (directory) =>
    trackedRepoFile(join(directory, "tracked.json")),
  );
  const { forge, settings, cli, directory } = context;
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } }, "private");
  await cli(...saveFlags([REPO]));
  await cli("clear");
  const record = join(directory, "tracked.json");
  await writeFile(record, (await readFile(record, "utf8")).replace("secret-board", "later-board"));
  const alerts: string[] = [];
  const restarted = createProjectTrackingService({
    settings,
    forge: async () => githubRestApi({ token: "loopback", baseUrl: forge.baseUrl }),
    alert: async (text) => Boolean(alerts.push(text)),
    trackedRepos: trackedRepoFile(record),
  });
  const mark = forge.requests.length;
  await restarted.sweep();
  expect(forge.writesSince(mark)).toEqual([]);
  expect(forge.pulls(REPO)[0]!.state).toBe("open");
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toContain("its proposal #1 still names");
}, 60_000);

it("alerts on a public departed repo whose default branch names the board, then forgets it", async () => {
  const context = await fixture();
  const { forge, service, alerts, alerting } = context;
  await departing(context);
  await forge.merge(REPO, 1);
  await forge.deleteBranch(REPO, TRACKING_BRANCH);
  await drop(context);
  forge.setVisibility(REPO, "public");
  alerting.delivered = false;
  await service.sweep();
  alerting.delivered = true;
  await service.sweep();
  expect(alerts).toHaveLength(2);
  expect(alerts[1]).toContain(
    `${REPO} left project garden's tracking setting, it is no longer confirmed private`,
  );
  expect(alerts[1]).toContain("its default branch still names");
  expect(alerts[1]).not.toContain("secret-board");
  const forgotten = forge.requests.length;
  await service.sweep();
  expect(repoRequests(context, forgotten)).toEqual([]);
  expect(alerts).toHaveLength(2);
}, 60_000);

it("forgets a private departed repo whose merged block names the board, without an alert", async () => {
  const context = await fixture();
  const { forge, service, alerts } = context;
  await departing(context);
  await forge.merge(REPO, 1);
  await forge.deleteBranch(REPO, TRACKING_BRANCH);
  await drop(context);
  await service.sweep();
  expect(alerts).toEqual([]);
  const forgotten = forge.requests.length;
  await service.sweep();
  expect(repoRequests(context, forgotten)).toEqual([]);
}, 60_000);

it("alerts on a public departed repo through a failed branch read, and keeps it until that read works", async () => {
  const { switched, gate } = failing((method, path) => (method === "GET" && path === REF ? 502 : undefined));
  const context = await fixture("lead", {}, [], undefined, gate);
  const { forge, service, alerts } = context;
  await departing(context);
  await forge.merge(REPO, 1);
  await drop(context);
  forge.setVisibility(REPO, "public");
  switched.on = true;
  await service.sweep();
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toContain("its default branch still names");
  const retried = forge.requests.length;
  await service.sweep();
  expect(repoRequests(context, retried).length).toBeGreaterThan(0);
  switched.on = false;
  await service.sweep();
  await expect(forge.head(REPO, TRACKING_BRANCH)).rejects.toThrow();
  const forgotten = forge.requests.length;
  await service.sweep();
  expect(repoRequests(context, forgotten)).toEqual([]);
}, 60_000);

it("names both places when a public departed repo keeps the board on its default branch and proposal", async () => {
  const context = await fixture("owner");
  const { forge, service, alerts } = context;
  await departing(context);
  await forge.merge(REPO, 1);
  await drop(context);
  forge.setVisibility(REPO, "public");
  await service.sweep();
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toContain(`its default branch and its ${TRACKING_BRANCH} branch still name`);
}, 60_000);

it("keeps a departed repo whose default branch can't be read, since it can't say what's there", async () => {
  let unreadable: string | undefined;
  const context = await fixture("lead", {}, [], undefined, (method, path) =>
    unreadable && method === "GET" && path.endsWith(unreadable) ? 502 : undefined,
  );
  const { forge, service, alerts } = context;
  await departing(context);
  await forge.merge(REPO, 1);
  await forge.deleteBranch(REPO, TRACKING_BRANCH);
  await drop(context);
  forge.setVisibility(REPO, "public");
  unreadable = gitBlobSha(await forge.read(REPO, "main", "CLAUDE.md"));
  await service.sweep();
  expect(alerts).toEqual([]);
  unreadable = undefined;
  await service.sweep();
  expect(alerts).toHaveLength(1);
}, 60_000);

it("withdraws from a departed repo with an unreadable default branch, and keeps it to read that later", async () => {
  let unreadable: string | undefined;
  const context = await fixture("lead", {}, [], undefined, (method, path) =>
    unreadable && method === "GET" && path.endsWith(`/git/commits/${unreadable}`) ? 502 : undefined,
  );
  const { forge, service, alerts } = context;
  await departing(context);
  await forge.push(REPO, "main", { "CLAUDE.md": { content: `${SECRET}\n` } });
  await drop(context);
  forge.setVisibility(REPO, "public");
  unreadable = await forge.head(REPO, "main");
  await service.sweep();
  expect(forge.pulls(REPO)[0]!.state).toBe("closed");
  expect(alerts).toEqual([]);
  unreadable = undefined;
  await service.sweep();
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toContain("its default branch still names");
}, 60_000);

it("keeps a departed repo whose branch guide won't read, and withdraws once it does", async () => {
  let unreadable: string | undefined;
  const context = await fixture("lead", {}, [], undefined, (method, path) =>
    unreadable && method === "GET" && path.endsWith(unreadable) ? 502 : undefined,
  );
  const { forge, service } = context;
  await departing(context);
  await drop(context);
  unreadable = gitBlobSha(await forge.read(REPO, TRACKING_BRANCH, "CLAUDE.md"));
  await service.sweep();
  expect(forge.pulls(REPO)[0]!.state).toBe("open");
  unreadable = undefined;
  await service.sweep();
  expect(forge.pulls(REPO)[0]!.state).toBe("closed");
}, 60_000);

it("leaves a departed repo's clean proposal alone, and forgets the repo", async () => {
  const context = await fixture();
  const { forge, service, alerts } = context;
  await departing(context, "public");
  await drop(context);
  const mark = forge.requests.length;
  await service.sweep();
  expect(forge.writesSince(mark).filter((write) => write.path.includes(REPO))).toEqual([]);
  expect(forge.pulls(REPO)[0]!.state).toBe("open");
  expect(alerts).toEqual([]);
  const forgotten = forge.requests.length;
  await service.sweep();
  expect(repoRequests(context, forgotten)).toEqual([]);
}, 60_000);

const entry = (repo: string, over: object = {}) => ({
  repo,
  projectId: "garden",
  tracker: { provider: "github", publicBoard: GITHUB.publicBoard, privateBoard: SECRET },
  ...over,
});
for (const [name, text] of [
  ["truncated", '[{"repo":"stranger/never","projectI'],
  ["not a list", "{}"],
  ["missing fields", '[{"repo":"stranger/never"}]'],
  ["a slug that climbs", JSON.stringify([entry("../../user")])],
  ["an extra field", JSON.stringify([{ ...entry("stranger/never"), branch: "main" }])],
  [
    "a board over two lines",
    JSON.stringify([
      entry("stranger/never", { tracker: { provider: "github", publicBoard: "a", privateBoard: "b\nc" } }),
    ]),
  ],
] as const)
  it(`trusts nothing in a tracked-repos file holding ${name}, and leaves the file as it was`, async () => {
    const context = await fixture("lead", {}, [], (directory) =>
      trackedRepoFile(join(directory, "tracked.json")),
    );
    const { forge, service, cli, directory } = context;
    const path = join(directory, "tracked.json");
    await writeFile(path, text, { mode: 0o600 });
    await forge.addRepo("stranger/never", { "CLAUDE.md": { content: GUIDE } }, "private");
    await foreignBranch(context, "stranger/never");
    await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } }, "private");
    await cli(...saveFlags([REPO]), "--no-apply");
    const mark = forge.requests.length;
    await service.sweep();
    expect(forge.requests.slice(mark).filter((request) => request.path.includes("stranger"))).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(text);
    expect(forge.pulls(REPO)).toHaveLength(1);
  }, 60_000);

it("picks up a tracked-repos file fixed by hand without a restart", async () => {
  const context = await fixture("lead", {}, [], (directory) =>
    trackedRepoFile(join(directory, "tracked.json")),
  );
  const { forge, service, cli, directory } = context;
  const path = join(directory, "tracked.json");
  await writeFile(path, "{", { mode: 0o600 });
  await forge.addRepo("fixture/keep", { "CLAUDE.md": { content: GUIDE } }, "private");
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } }, "private");
  await cli(...saveFlags([REPO, "fixture/keep"]));
  await drop(context);
  await service.sweep();
  expect(forge.pulls(REPO)[0]!.state).toBe("open");
  await writeFile(path, JSON.stringify([entry(REPO)]), { mode: 0o600 });
  await service.sweep();
  expect(forge.pulls(REPO)[0]!.state).toBe("closed");
}, 60_000);

it("keeps the tracked-repos file owner-only, even over a looser one, and leaves no pending file", async () => {
  const context = await fixture("lead", {}, [], (directory) =>
    trackedRepoFile(join(directory, "tracked.json")),
  );
  const { forge, service, cli, directory } = context;
  const path = join(directory, "tracked.json");
  await writeFile(path, "[]");
  await chmod(path, 0o644);
  await forge.addRepo(REPO, { "CLAUDE.md": { content: GUIDE } }, "private");
  await cli(...saveFlags([REPO]));
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  await service.sweep();
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await readdir(directory)).filter((file) => file.endsWith(".pending"))).toEqual([]);
  expect(await readFile(path, "utf8")).toContain("secret-board");
}, 60_000);
