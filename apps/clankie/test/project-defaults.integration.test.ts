import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm, readFile, rename, truncate } from "node:fs/promises";
import { realpathSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import type { ResourceSnapshot } from "@clankie/fleet-resources";
import { inferProjectDefaults } from "../src/captain/project-defaults.ts";
import { defaultRun } from "../src/work-items.ts";
import { projectOnboarding } from "../src/captain/project-onboarding.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import type { QuestionAuthority } from "../src/captain/conversation-questions.ts";
import type { ProjectProposalResult } from "@clankie/protocol/projects";
import { ProjectProposalTweakSchema } from "@clankie/protocol/projects";
import { runConversationsCommand } from "../../tui/src/command/conversations.ts";

const exec = promisify(execFile);
const roots: string[] = [];
const stores: ConversationStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
// Governor snapshot recorded from `clankie fleet resources` on 2026-10-06.
const resources: ResourceSnapshot = {
  schemaVersion: 1,
  policy: {
    heavySlots: null,
    simulatorSlots: 1,
    simulatorIdleMs: 600000,
    maxLoadRatio: 1.5,
    minAvailableMemoryMb: 4096,
  },
  capacity: { heavySlots: 2, simulatorSlots: 1, used: 0, simulatorUsed: 0, lightSlots: 2, lightUsed: 0 },
  pressure: {
    sampledAtMs: 1791293548249,
    loadRatio: 0.4051106770833333,
    availableMemoryMb: 48021.015625,
    healthy: true,
  },
  leases: [],
  queue: [],
  lightLeases: [],
  lightQueue: [],
};
async function repo(files: Record<string, string> = {}) {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "defaults-first-")));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), text);
  }
  await exec("git", ["init", "--quiet", root]);
  return root;
}
async function commit(root: string, message: string) {
  await exec(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      message,
    ],
    { cwd: root },
  );
}

it("no tracker proposes local work, baseline roles and small fleet without writing", async () => {
  const root = await repo({ "src/main.go": "package main" });
  const { draft, question } = await inferProjectDefaults(root, resources);
  expect(question).toBeUndefined();
  expect(draft).toMatchObject({
    trackerSetup: { backend: "default" },
    roles: [{ role: "builder" }, { role: "reviewer" }],
    fleet: { size: "small" },
    workerCap: 2,
  });
  expect(draft!.evidence).toContain("builder: Implement changes in this repository.");
  expect(existsSync(join(root, ".clankie"))).toBe(false);
});

it("saved config wins; UI and suite propose designer/tester with reasons", async () => {
  const saved = {
    schemaVersion: 1,
    backend: "linear",
    linear: { team: "APP", project: "my-app" },
    decidedBy: "owner",
    decidedAt: "2026-10-06T00:00:00Z",
  };
  const root = await repo({
    ".clankie/tracking.json": JSON.stringify(saved),
    "src/App.tsx": "export const App = () => null;",
    "test/journey.test.ts": "",
  });
  const { draft } = await inferProjectDefaults(root, resources);
  expect(draft!.trackerSetup).toBeUndefined();
  expect(draft!.roles!.map((role) => role.role)).toEqual(["builder", "reviewer", "designer", "tester"]);
  expect(draft!.evidence).toContain("designer: The repository contains an app UI.");
  expect(draft!.evidence).toContain("tester: The repository contains a test suite.");
  expect(JSON.parse(await readFile(join(root, ".clankie/tracking.json"), "utf8"))).toEqual(saved);
});

it("native SwiftUI and manifest-declared suites produce roles; malformed manifests stay untrusted data", async () => {
  const root = await repo({
    "Sources/App.swift": "import SwiftUI\nstruct App {}",
    "package.json": JSON.stringify({ scripts: { test: "swift test" } }),
    "nested/package.json": "null",
  });
  const { draft } = await inferProjectDefaults(root, resources);
  expect(draft!.roles!.map((role) => role.role)).toEqual(["builder", "reviewer", "designer", "tester"]);
});

it("bounded inference preserves UTF-16 character limits for multibyte manifests and Swift prefixes", async () => {
  const root = await repo({
    "package.json": JSON.stringify({ note: "€".repeat(40_000), scripts: { test: "swift test" } }),
    "Sources/App.swift": `// ${"€".repeat(70_000)}\nimport SwiftUI\n`,
  });
  // Large sparse generated tails must not be allocated just to inspect the prefix.
  await truncate(join(root, "Sources/App.swift"), 128 * 1024 * 1024);
  const { draft } = await inferProjectDefaults(root, resources);
  expect(draft!.roles!.map((role) => role.role)).toEqual(["builder", "reviewer", "designer", "tester"]);
});

it("oversized manifests and Swift imports beyond the character prefix do not infer roles", async () => {
  const root = await repo({
    "package.json": `${JSON.stringify({ dependencies: { react: "1" }, scripts: { test: "test" } })}${" ".repeat(100_000)}`,
    "Sources/App.swift": `// ${"€".repeat(100_000)}\nimport SwiftUI\n`,
  });
  await truncate(join(root, "Sources/App.swift"), 128 * 1024 * 1024);
  const { draft } = await inferProjectDefaults(root, resources);
  expect(draft!.roles!.map((role) => role.role)).toEqual(["builder", "reviewer"]);
  await truncate(join(root, "package.json"), 128 * 1024 * 1024);
  expect((await inferProjectDefaults(root, resources)).draft!.roles!.map((role) => role.role)).toEqual([
    "builder",
    "reviewer",
  ]);
});

it("reads a linked Linear project plus actual commit history", async () => {
  const root = await repo({ "AGENTS.md": "Use https://linear.app/workspace/project/my-project/overview" });
  await commit(root, "APP-12 work");
  const { draft } = await inferProjectDefaults(root, resources);
  expect(draft!.trackerSetup).toMatchObject({
    backend: "linear",
    linearTeam: "APP",
    linearProject: "my-project",
  });
});

it("infers a Linear team from real branches without instruction hints", async () => {
  const root = await repo();
  await commit(root, "initial");
  await exec("git", ["branch", "work/APP-12-feature"], { cwd: root });
  expect((await inferProjectDefaults(root, resources)).draft!.trackerSetup).toMatchObject({
    backend: "linear",
    linearTeam: "APP",
  });
});

it("infers history-only Linear while ignoring model/standard/version keys", async () => {
  const root = await repo();
  for (let n = 1; n <= 5; n++) await commit(root, `APP-${n} work GPT-5 ADR-0001`);
  expect((await inferProjectDefaults(root, resources)).draft!.trackerSetup).toMatchObject({
    backend: "linear",
    linearTeam: "APP",
  });
});

it("preserves an existing file tracker", async () => {
  const root = await repo({ "tasks/one.md": "# One\n" });
  expect((await inferProjectDefaults(root, resources)).draft!.trackerSetup).toMatchObject({
    backend: "markdown",
    directory: "tasks",
  });
});

it("competing Linear teams ask exactly one question and offer no proposal", async () => {
  const root = await repo();
  await commit(root, "initial");
  for (const branch of ["app-1-a", "app-2-b", "web-1-a", "web-2-b"])
    await exec("git", ["branch", branch], { cwd: root });
  const result = await inferProjectDefaults(root, resources);
  expect(result.draft).toBeUndefined();
  expect(result.question).toContain("more than one Linear team");
  expect(existsSync(join(root, ".clankie"))).toBe(false);
});

it("competing Linear projects and a lone TODO require a decision", async () => {
  const root = await repo({
    "AGENTS.md": "https://linear.app/w/project/one and https://linear.app/w/project/two",
  });
  expect((await inferProjectDefaults(root, resources)).question).toContain("more than one Linear project");
  const todo = await repo({ "TODO.md": "- work" });
  expect((await inferProjectDefaults(todo, resources)).question).toContain("single task list");
});

it.each([1, 0])("governor capacity %i caps the proposal", async (slots) => {
  const root = await repo();
  const result = await inferProjectDefaults(root, {
    ...resources,
    capacity: { ...resources.capacity, heavySlots: slots },
  });
  expect(result.draft).toMatchObject({ workerCap: slots, fleet: { size: "solo" } });
});
it("pressure and unavailable observations refuse new workers", async () => {
  const root = await repo();
  for (const state of [
    undefined,
    { ...resources, pressure: { ...resources.pressure, healthy: false, reason: "memory" as const } },
  ])
    expect((await inferProjectDefaults(root, state)).draft).toMatchObject({
      workerCap: 0,
      fleet: { size: "solo" },
    });
});

it("large active repos propose four workers, capped by the observed governor", async () => {
  const root = await repo(
    Object.fromEntries(Array.from({ length: 1000 }, (_, n) => [`src/file${n}.ts`, "export {};"])),
  );
  for (let n = 0; n < 50; n++) await commit(root, `change ${n}`);
  expect((await inferProjectDefaults(root, resources)).draft).toMatchObject({
    workerCap: 2,
    fleet: { size: "small" },
  });
  expect(
    (await inferProjectDefaults(root, { ...resources, capacity: { ...resources.capacity, heavySlots: 4 } }))
      .draft,
  ).toMatchObject({ workerCap: 4, fleet: { size: "large" } });
});

// Explicit live provider gate: real GitHub HTTP and native git, without owner credentials.
it.runIf(process.env.PROJECT_TRACKER_LIVE === "1")(
  "detects actual GitHub issues and asks when Linear is also in use",
  async () => {
    const root = await repo();
    await exec("git", ["remote", "add", "origin", "https://github.com/cli/cli.git"], { cwd: root });
    const run = async (command: string, args: readonly string[], cwd: string) => {
      if (command !== "gh") return defaultRun(command, args, cwd);
      const response = await fetch(`https://api.github.com/${args[1]}`, {
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw Error(`GitHub read: ${response.status}`);
      const issues = (await response.json()) as Array<{ pull_request?: unknown }>;
      return String(issues.filter((issue) => issue.pull_request === undefined).length);
    };
    expect((await inferProjectDefaults(root, resources, run)).draft!.trackerSetup).toEqual({
      backend: "github",
      githubRepo: "cli/cli",
    });
    await writeFile(
      join(root, "AGENTS.md"),
      "Use https://linear.app/w/issue/APP-1 and https://linear.app/w/issue/APP-2",
    );
    const ambiguous = await inferProjectDefaults(root, resources, run);
    expect(ambiguous.draft).toBeUndefined();
    expect(ambiguous.question).toContain("more than one place");
  },
);

async function conversation(root: string) {
  const state = await repo();
  const settings = new SettingsStore(join(state, "settings.json"));
  let valid = true;
  const owner: QuestionAuthority = {
    principal: { kind: "device", id: "original" },
    authorize: async () => valid,
    current: () => true,
  };
  let proposed: unknown;
  const store = new ConversationStore(
    join(state, "conversations"),
    async (id, _message, _publish, context) => {
      proposed = await store.proposeProjectDefaults(id, context);
    },
  );
  stores.push(store);
  store.projectOnboarding = projectOnboarding(settings, () => resources);
  const created = await store.serve({
    op: "create",
    schemaVersion: 1,
    title: "Onboarding",
    scope: { kind: "workspace", workspaceId: root },
  });
  if (created.op !== "create") throw Error("create failed");
  const id = created.conversation.conversationId;
  const sent = await store.serve(
    {
      op: "send",
      schemaVersion: 1,
      turn: {
        schemaVersion: 1,
        kind: "message",
        conversationId: id,
        surfaceClientId: "fixture",
        expectedRevision: 0,
        message: "onboard",
      },
    },
    owner,
  );
  if (sent.op !== "send" || sent.result.status !== "accepted") throw Error("send failed");
  await store.awaitRun(sent.result.runId);
  return {
    store,
    settings,
    owner,
    id,
    proposed,
    state,
    revoke: () => {
      valid = false;
    },
  };
}

it("one inferred proposal → one-field tweak → exact accept saves tracker and confirmed station roles once", async () => {
  const root = await repo({ "src/App.tsx": "", "test/journey.test.ts": "" });
  const f = await conversation(root);
  const initial = f.proposed as ProjectProposalResult;
  expect(initial.status).toBe("pending");
  expect((await f.settings.load()).projects.projects).toEqual([]);
  expect(existsSync(join(root, ".clankie/tracking.json"))).toBe(false);
  const before = initial.proposal!;
  const tweaked = await f.store.serve(
    {
      op: "project_proposal_tweak",
      schemaVersion: 1,
      ...before.target,
      change: { field: "name", value: "Reviewed name" },
    },
    f.owner,
  );
  if (tweaked.op !== "project_proposal_tweak") throw Error("wrong response");
  const after = tweaked.result.proposal!;
  expect(after.command).toEqual({ ...before.command, name: "Reviewed name" });
  expect(after.target.proposalId).not.toBe(before.target.proposalId);
  expect(after.target.artifactSha256).not.toBe(before.target.artifactSha256);
  expect((await f.settings.load()).projects.projects).toEqual([]);
  const stale = await f.store.serve(
    { op: "project_proposal_confirm", schemaVersion: 1, ...before.target },
    f.owner,
  );
  expect("result" in stale && stale.result).toMatchObject({ status: "refused" });
  const accepted = await f.store.serve(
    { op: "project_proposal_confirm", schemaVersion: 1, ...after.target },
    f.owner,
  );
  expect("result" in accepted && accepted.result).toMatchObject({ status: "created" });
  const saved = (await f.settings.load()).projects.projects[0]!;
  expect(saved.name).toBe("Reviewed name");
  expect(saved.roles.map((role) => role.role)).toEqual(["builder", "reviewer", "designer", "tester"]);
  expect(JSON.parse(await readFile(join(root, ".clankie/tracking.json"), "utf8"))).toMatchObject({
    backend: "default",
  });
  expect(
    await f.store.serve({ op: "project_proposal_confirm", schemaVersion: 1, ...after.target }, f.owner),
  ).toEqual(accepted);
  expect((await f.settings.load()).projects.projects).toHaveLength(1);
});

it("ambiguous discovery persists only one question, with no project or tracker write", async () => {
  const root = await repo({ "TODO.md": "- Work" });
  const f = await conversation(root);
  expect(f.proposed).toMatchObject({ status: "ready", question: { status: "pending" } });
  const current = await f.store.serve({ op: "input_get", schemaVersion: 1, conversationId: f.id }, f.owner);
  expect("result" in current && current.result).toMatchObject({
    question: { prompt: expect.stringContaining("single task list") },
  });
  expect((await f.settings.load()).projects.projects).toEqual([]);
  expect(existsSync(join(root, ".clankie"))).toBe(false);
});

it("tweaks refuse another principal and revocation, and schema accepts only one field", async () => {
  const f = await conversation(await repo());
  const target = (f.proposed as ProjectProposalResult).proposal!.target;
  const request = {
    op: "project_proposal_tweak" as const,
    schemaVersion: 1 as const,
    ...target,
    change: { field: "name" as const, value: "Changed" },
  };
  await expect(
    f.store.serve(request, { ...f.owner, principal: { kind: "device", id: "other" } }),
  ).rejects.toThrow("question_owner_unavailable");
  f.revoke();
  await expect(f.store.serve(request, f.owner)).rejects.toThrow();
  expect(
    ProjectProposalTweakSchema.safeParse({
      ...target,
      change: { field: "name", value: "Changed", roles: [] },
    }).success,
  ).toBe(false);
  expect((await f.settings.load()).projects.projects).toEqual([]);
});

it.each([
  { field: "roles", value: [{ role: "builder" }, { role: "reviewer" }] },
  { field: "fleet", value: { size: "solo", models: "efficient" } },
  { field: "workerCap", value: 0 },
  {
    field: "tracker",
    value: {
      trackerRef: { workspaceId: "primary", path: ".clankie/tracking.json" },
      trackerSetup: { backend: "linear", linearTeam: "APP" },
    },
  },
] as const)("tweak $field preserves all other configuration", async (change) => {
  const f = await conversation(await repo({ "src/App.tsx": "" }));
  const before = (f.proposed as ProjectProposalResult).proposal!;
  const result = await f.store.serve(
    {
      op: "project_proposal_tweak",
      schemaVersion: 1,
      ...before.target,
      change: JSON.parse(JSON.stringify(change)),
    },
    f.owner,
  );
  if (result.op !== "project_proposal_tweak") throw Error("wrong response");
  expect(result.result.status).toBe("pending");
  const expected =
    change.field === "tracker"
      ? { ...before.command, ...change.value }
      : { ...before.command, [change.field]: change.value };
  expect(result.result.proposal!.command).toEqual(expected);
  if (change.field === "roles") {
    expect(result.result.proposal!.evidence.some((line) => line.startsWith("designer:"))).toBe(false);
    expect(result.result.proposal!.evidence).toContain("builder: Requested by the owner.");
  }
  expect((await f.settings.load()).projects.projects).toEqual([]);
});

it("a real proposal metadata rename failure consumes the tweak and prevents acceptance", async () => {
  const f = await conversation(await repo());
  const target = (f.proposed as ProjectProposalResult).proposal!.target;
  const folder = join(f.state, "conversations", f.id);
  await rename(join(folder, "meta.json"), join(folder, "original-meta.json"));
  await mkdir(join(folder, "meta.json"));
  await writeFile(join(folder, "meta.json", "occupied"), "block replacement");
  const changed = await f.store.serve(
    {
      op: "project_proposal_tweak",
      schemaVersion: 1,
      ...target,
      change: { field: "name", value: "Cannot safely confirm" },
    },
    f.owner,
  );
  expect("result" in changed && changed.result).toMatchObject({
    status: "uncertain",
    reason: "tweak_persistence_unavailable",
  });
  const accepted = await f.store.serve(
    { op: "project_proposal_confirm", schemaVersion: 1, ...target },
    f.owner,
  );
  expect("result" in accepted && accepted.result).toMatchObject({ status: "refused" });
  expect((await f.settings.load()).projects.projects).toEqual([]);
});

it("native HTTP CLI tweak and accept operate on the same review object", async () => {
  const f = await conversation(await repo());
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "Bearer fixture-owner") {
      response.writeHead(403).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const result = await f.store.serve(JSON.parse(Buffer.concat(chunks).toString()), f.owner);
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("server failed");
  const output: string[] = [];
  const options = {
    host: `http://127.0.0.1:${address.port}`,
    env: { CLANKIE_OPERATOR_TOKEN: "fixture-owner" },
    stdout: {
      write: (text: string | Uint8Array) => {
        output.push(String(text));
        return true;
      },
    },
  };
  const flags = (target: NonNullable<ProjectProposalResult["proposal"]>["target"]) => [
    target.conversationId,
    "--request",
    target.requestId,
    "--incarnation",
    target.incarnationId,
    "--revision",
    String(target.expectedRevision),
    "--proposal",
    target.proposalId,
    "--artifact",
    target.artifactSha256,
    "--projects-revision",
    target.expectedProjectsRevision,
  ];
  try {
    const before = (f.proposed as ProjectProposalResult).proposal!.target;
    expect(
      await runConversationsCommand(["tweak-project", ...flags(before), "--field", "name", "--value-stdin"], {
        ...options,
        stdin: Readable.from(['"CLI reviewed"']),
      }),
    ).toBe(0);
    const tweaked = JSON.parse(output.pop()!) as ProjectProposalResult;
    expect(tweaked.proposal!.command.name).toBe("CLI reviewed");
    expect((await f.settings.load()).projects.projects).toEqual([]);
    expect(
      await runConversationsCommand(["accept-project", ...flags(tweaked.proposal!.target)], options),
    ).toBe(0);
    expect((await f.settings.load()).projects.projects[0]!.name).toBe("CLI reviewed");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
