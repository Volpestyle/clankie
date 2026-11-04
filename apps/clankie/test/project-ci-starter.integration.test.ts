import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  PROJECT_CI_STARTER_PATH,
  ProjectCiStarterOfferSchema,
  type ProjectCiStarterOffer,
} from "@clankie/protocol/project-ci-starter";
import { hostedOperatorAllows } from "@clankie/protocol/hosted-operator";
import { createQaService } from "./fixtures/qa-service.ts";

const repo = resolve(import.meta.dirname, "../../..");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function scratch() {
  const root = await mkdtemp(join(tmpdir(), "ci-starter-"));
  roots.push(root);
  return root;
}
function run(
  command: string,
  args: readonly string[],
  cwd: string,
  input = "",
  env: NodeJS.ProcessEnv = process.env,
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      signal: AbortSignal.timeout(120_000),
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (value) => {
      stdout += value;
    });
    child.stderr.on("data", (value) => {
      stderr += value;
    });
    child.on("error", reject);
    child.on("close", (code) => done({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
const request = {
  schemaVersion: 1,
  profile: "pnpm-vitest-4",
  repository: "example/slow-ci",
  reason: "A measured draft push reruns the full suite; offer a reviewable alternative. 🦊",
  evidence: ["https://github.com/example/slow-ci/actions/runs/123"],
  quickCommand: "node --check checks/base.test.js",
  fullChecksCommand:
    "pnpm exec tsc --incremental --tsBuildInfoFile .cache/tsbuildinfo/ci.tsbuildinfo --noEmit",
  compilerCachePaths: [".cache/tsbuildinfo"],
  compilerCacheKeyFiles: ["tsconfig.json"],
};
async function offer(): Promise<ProjectCiStarterOffer> {
  const host = await createQaService();
  try {
    const snapshot = async () => {
      const response = await fetch(host.baseUrl + "/v1/operator/projects", {
        headers: { authorization: `Bearer ${host.operatorToken}` },
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    const before = await snapshot();
    const result = await run(
      process.execPath,
      [join(repo, "apps/tui/bin/clankie.ts"), "project", "ci", "offer", "--json-stdin"],
      repo,
      JSON.stringify(request),
      {
        ...process.env,
        CLANKIE_CONTROL_PLANE_URL: host.baseUrl,
        CLANKIE_OPERATOR_TOKEN: host.operatorToken,
      },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(await snapshot()).toEqual(before);
    return ProjectCiStarterOfferSchema.parse(JSON.parse(result.stdout));
  } finally {
    await host.close();
  }
}

it("the actual launcher/owner HTTP path offers files without applying them or accepting approval", async () => {
  const value = await offer();
  expect(value).toMatchObject({
    status: "offered",
    ownerChoiceRequired: true,
    adoption: "unverified",
    repository: request.repository,
    reason: request.reason,
  });
  const workflow = JSON.parse(value.files.find((file) => file.path.endsWith(".yml"))!.content);
  expect(workflow.on.pull_request.types).toEqual(["opened", "synchronize", "reopened", "ready_for_review"]);
  expect(workflow.on.push.branches).toEqual(["main"]);
  expect(workflow.on.pull_request_target).toBeUndefined();
  expect(workflow.concurrency).toEqual({
    group: "fast-ci-${{ github.event.pull_request.number || github.ref }}",
    "cancel-in-progress": true,
  });
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.jobs.quick.steps.at(-1).run).toBe(request.quickCommand);
  expect(workflow.jobs.full.if).toBe(
    "github.event_name == 'push' || github.event.pull_request.draft == false",
  );
  expect(
    workflow.jobs.full.steps.find((step: { name?: string }) => step.name === "Full non-test checks").run,
  ).toBe(request.fullChecksCommand);
  expect(
    workflow.jobs.full.steps.find((step: { uses?: string }) => step.uses === "actions/cache@v4").with.path,
  ).toBe(".cache/tsbuildinfo");
  expect(value.limits.join(" ")).toContain("No real-project adoption");
  expect(hostedOperatorAllows("POST", PROJECT_CI_STARTER_PATH)).toBe(true);
  expect(hostedOperatorAllows("GET", PROJECT_CI_STARTER_PATH)).toBe(false);

  const host = await createQaService();
  try {
    const post = (body: unknown, token?: string) =>
      fetch(host.baseUrl + PROJECT_CI_STARTER_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
    expect((await post(request)).status).toBe(401);
    const malformed = await fetch(host.baseUrl + PROJECT_CI_STARTER_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${host.operatorToken}` },
      body: "{broken",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "malformed" });
    for (const bad of [
      { ...request, ownerApproved: true },
      { ...request, projectPath: "/tmp/unapproved" },
      { ...request, profile: "unknown" },
      { ...request, vitestConfig: "../outside.ts" },
    ])
      expect((await post(bad, host.operatorToken)).status).toBe(400);
    expect((await post({ padding: "x".repeat(17000) }, host.operatorToken)).status).toBe(413);
  } finally {
    await host.close();
  }
});

async function fixture(value: ProjectCiStarterOffer) {
  const root = await scratch();
  const lock = await readFile(join(repo, "pnpm-lock.yaml"), "utf8");
  const firstImporter = lock.slice(lock.indexOf("\n  .:\n"), lock.indexOf("\n  apps/"));
  const vitest = firstImporter.match(
    /\n      vitest:\n        specifier: ([^\n]+)\n        version: ([^\n]+)/u,
  );
  if (!vitest) throw new Error("The installed workspace lock has no pinned Vitest fixture input");
  const modules = JSON.parse(await readFile(join(repo, "node_modules/.modules.yaml"), "utf8")) as {
    storeDir: string;
  };
  const tsVersion = JSON.parse(await readFile(join(repo, "packages/protocol/package.json"), "utf8"))
    .devDependencies.typescript as string;
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "ci-starter-fixture",
      private: true,
      type: "module",
      packageManager: "pnpm@11.11.0",
      devDependencies: { vitest: vitest[1], typescript: tsVersion },
    }),
  );
  await writeFile(
    join(root, "pnpm-lock.yaml"),
    `lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .:\n    devDependencies:\n      vitest:\n        specifier: ${vitest[1]}\n        version: ${vitest[2]}\n      typescript:\n        specifier: ${tsVersion}\n        version: ${tsVersion}\n${lock.slice(lock.indexOf("\npackages:\n"))}`,
  );
  // Use pnpm's native store and a private virtual store, not shared node_modules.
  await writeFile(join(root, ".npmrc"), `store-dir=${dirname(modules.storeDir)}\nprefer-offline=true\n`);
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages: []\nallowBuilds:\n  esbuild: true\n");
  await writeFile(join(root, ".gitignore"), "node_modules\n.local\n.cache\n");
  await writeFile(
    join(root, "vitest.config.ts"),
    'export default { test: { include: ["checks/*.test.js"], pool: "forks", maxWorkers: 1 } };\n',
  );
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { target: "ES2023", types: [], strict: true },
      include: ["types/*.ts"],
    }),
  );
  await mkdir(join(root, "types"));
  await writeFile(join(root, "types/index.ts"), "export const checked: number = 1;\n");
  await mkdir(join(root, "checks"));
  const test = 'import {it,expect} from "vitest"; it("already broken on main",()=>expect(1).toBe(2));\n';
  await writeFile(join(root, "checks/base.test.js"), test);
  for (const file of value.files) {
    await mkdir(resolve(root, file.path, ".."), { recursive: true });
    await writeFile(join(root, file.path), file.content);
  }
  const installed = await run("pnpm", ["install", "--prefer-offline", "--frozen-lockfile"], root);
  expect(installed.code, installed.stdout + installed.stderr).toBe(0);
  for (const args of [
    ["init"],
    ["add", "."],
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "base"],
  ]) {
    const result = await run("git", args, root);
    expect(result.code, result.stderr).toBe(0);
  }
  const base = (await run("git", ["rev-parse", "HEAD"], root)).stdout.trim();
  const workflow = JSON.parse(value.files.find((file) => file.path.endsWith(".yml"))!.content);
  const testStep = workflow.jobs.full.steps.find((step: { id?: string }) => step.id === "tests");
  const compareStep = workflow.jobs.full.steps.find(
    (step: { name?: string }) => step.name === "Verify report and compare existing failures",
  );
  const strictStep = workflow.jobs.full.steps.find(
    (step: { name?: string }) => step.name === "Full non-test checks",
  );
  expect(
    (await run("bash", ["-e", "-o", "pipefail", "-c", workflow.jobs.quick.steps.at(-1).run], root)).code,
  ).toBe(0);
  const strict = await run("bash", ["-e", "-o", "pipefail", "-c", strictStep.run], root);
  expect(strict.code, strict.stdout + strict.stderr).toBe(0);
  expect((await readFile(join(root, ".cache/tsbuildinfo/ci.tsbuildinfo"))).byteLength).toBeGreaterThan(0);
  const report = join(root, testStep.env.CLANKIE_RELEASE_TEST_REPORT);
  const output = join(root, ".local/step-output");
  let outcome = "",
    exitCode = "";
  const execute = async () => {
    await mkdir(join(root, ".local"), { recursive: true });
    await writeFile(output, "");
    const result = await run("bash", ["-e", "-o", "pipefail", "-c", testStep.run], root, "", {
      ...process.env,
      ...testStep.env,
      GITHUB_OUTPUT: output,
    });
    const recorded = (await readFile(output, "utf8")).trim();
    expect(recorded).toBe(`exit_code=${result.code}`);
    outcome = result.code === 0 ? "success" : "failure";
    exitCode = String(result.code);
    return result;
  };
  const workflowCompare = (event = "pull_request") =>
    run("bash", ["-e", "-o", "pipefail", "-c", compareStep.run], root, "", {
      ...process.env,
      GITHUB_EVENT_NAME: event,
      BASE_SHA: base,
      TEST_OUTCOME: outcome,
      TEST_EXIT_CODE: exitCode,
    });
  const compare = (
    path = report,
    status = "failure",
    extra: string[] = [],
    exitCode = status === "success" ? "0" : "1",
  ) =>
    run(
      process.execPath,
      [
        ".github/fast-ci/compare-base.mjs",
        "--generic",
        "--base",
        base,
        "--report",
        path,
        "--reporter",
        ".github/fast-ci/reporter.mjs",
        "--config",
        "vitest.config.ts",
        "--status",
        status,
        "--exit-code",
        exitCode,
        ...extra,
      ],
      root,
    );
  return { root, base, report, execute, compare, workflowCompare, test };
}

it("the emitted reporter/comparator run real Vitest in real Git worktrees and never mask new or incomplete failures", async () => {
  const f = await fixture(await offer());
  expect((await f.execute()).code).toBe(1);
  const shared = await f.workflowCompare();
  expect(shared.code, shared.stdout + shared.stderr).toBe(0);
  expect(shared.stdout).toContain("Already failing on base");
  expect(shared.stdout).toContain("1 already failing there, 0 new");
  await mkdir(join(f.root, "scripts/testing"), { recursive: true });
  await writeFile(
    join(f.root, "scripts/testing/release-test-reporter.mjs"),
    await readFile(join(f.root, ".github/fast-ci/reporter.mjs")),
  );
  const legacy = await run(
    process.execPath,
    [".github/fast-ci/compare-base.mjs", "--base", f.base, "--report", f.report],
    f.root,
  );
  expect(legacy.code, legacy.stdout + legacy.stderr).toBe(0);
  expect(legacy.stdout).toContain("1 already failing there, 0 new");
  expect(legacy.stdout).toContain("Already failing on main");
  expect(legacy.stdout).toContain("fix it on main.");

  const sharedReport = JSON.parse(await readFile(f.report, "utf8"));
  const sharedPath = join(f.root, ".local/shared.json");
  await writeFile(sharedPath, JSON.stringify(sharedReport));
  expect((await f.workflowCompare("push")).code).toBe(1);

  await writeFile(
    join(f.root, "checks/base.test.js"),
    f.test + 'it("new regression",()=>expect(3).toBe(4));\n',
  );
  expect((await f.execute()).code).toBe(1);
  const own = await f.workflowCompare();
  expect(own.code, own.stdout + own.stderr).toBe(1);
  expect(own.stdout).toContain("new regression");
  expect(own.stdout).toContain("1 already failing there, 1 new");

  await writeFile(join(f.root, "checks/base.test.js"), f.test);
  await writeFile(join(f.root, "checks/load.test.js"), 'throw new Error("module failed before tests");\n');
  expect((await f.execute()).code).toBe(1);
  expect((await f.compare()).code).toBe(1);
  await rm(join(f.root, "checks/load.test.js"));
  await writeFile(
    join(f.root, "checks/new.test.js"),
    'import {it,expect} from "vitest"; it("new file regression",()=>expect(7).toBe(8));\n',
  );
  expect((await f.execute()).code).toBe(1);
  const newFile = await f.workflowCompare();
  expect(newFile.code).toBe(1);
  expect(newFile.stdout).toContain("(new file)");
  await rm(join(f.root, "checks/new.test.js"));

  const complete = sharedReport;
  const unfinished = join(f.root, ".local/unfinished.json");
  await writeFile(
    unfinished,
    JSON.stringify({ ...complete, selected: [...complete.selected, "never-finished.test.js"] }),
  );
  expect((await f.compare(unfinished)).code).toBe(1);
  expect((await f.compare(join(f.root, ".local/missing.json"))).code).toBe(1);
  expect((await f.compare(sharedPath, "success", [], "1")).code).toBe(1);
  expect((await f.compare(sharedPath, "skipped")).code).toBe(1);
  expect((await f.compare(sharedPath, "failure", [], "2")).code).toBe(1);
  await writeFile(
    unfinished,
    JSON.stringify({ ...complete, errors: [{ name: "UnhandledError", message: "outside a test" }] }),
  );
  expect((await f.compare(unfinished)).code).toBe(1);

  await writeFile(
    unfinished,
    JSON.stringify({ ...complete, selected: [...complete.selected, ...complete.selected] }),
  );
  expect((await f.compare(unfinished)).code).toBe(1);
  await writeFile(unfinished, JSON.stringify({ ...complete, reason: "passed", selected: [], files: [] }));
  expect((await f.compare(unfinished, "success", ["--verify-only"])).code).toBe(1);

  // A base that cannot install never earns a warning-only comparison.
  expect((await run("git", ["rm", "--cached", "pnpm-lock.yaml"], f.root)).code).toBe(0);
  expect(
    (
      await run(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "commit",
          "-m",
          "base without lock",
        ],
        f.root,
      )
    ).code,
  ).toBe(0);
  const brokenBase = (await run("git", ["rev-parse", "HEAD"], f.root)).stdout.trim();
  const unavailable = await run(
    process.execPath,
    [
      ".github/fast-ci/compare-base.mjs",
      "--generic",
      "--base",
      brokenBase,
      "--report",
      sharedPath,
      "--reporter",
      ".github/fast-ci/reporter.mjs",
      "--config",
      "vitest.config.ts",
      "--status",
      "failure",
      "--exit-code",
      "1",
    ],
    f.root,
  );
  expect(unavailable.code).toBe(1);
  expect(unavailable.stderr).toContain("pnpm install on the base exited");

  await writeFile(join(f.root, "checks/base.test.js"), f.test.replace("toBe(2)", "toBe(1)"));
  expect((await f.execute()).code).toBe(0);
  expect((await f.workflowCompare("push")).code).toBe(0);
  expect((await f.compare(f.report, "success", ["--verify-only"])).code).toBe(0);
  expect((await f.compare(f.report, "failure", ["--verify-only"])).code).toBe(1);
  const trees = await run("git", ["worktree", "list", "--porcelain"], f.root);
  expect(trees.stdout.split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(1);
}, 120_000);
