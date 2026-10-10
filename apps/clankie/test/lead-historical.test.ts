/** Deterministic transport fixtures only. No Docker, dependency install, grading or model executes. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
const transports = vi.hoisted(() => new WeakMap<Function, object>());
vi.mock("node:child_process", async (original) => {
  const child = await original<typeof import("node:child_process")>();
  return {
    ...child,
    execFileSync: (file: string, args: string[], options: any) => {
      if (file !== "git") return child.execFileSync(file, args, options);
      if (args[0] !== "-C") throw Error("Unexpected native archive fixture");
      const codex = args[1]!.endsWith("codex");
      if (args[2] === "remote")
        return Buffer.from(
          codex ? "git@github.com:openai/codex.git" : "git@github.com:Volpestyle/clankie-herdr.git",
        );
      if (args[2] === "rev-parse") return Buffer.from(args[3]!);
      if (args[2] === "archive") return Buffer.from("inert native source archive");
      throw Error("Unrecognized native archive fixture");
    },
  };
});
// @ts-expect-error -- manual checkout-only image builder, fake source and Docker boundaries.
import { buildNativeImage } from "../../../scripts/evals/lead-native-image.mjs";
vi.mock("../../../scripts/evals/lead-containment.mjs", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  dockerTransportIdentity: (command: Function) => {
    const identity = transports.get(command);
    if (!identity) throw Error("Unregistered fixture transport");
    return identity;
  },
}));
// @ts-expect-error -- checkout-only manual eval ESM.
import * as historical from "../../../scripts/evals/lead-historical.mjs";
const {
  stageHistorical,
  stageHistoricalWorkspace,
  collectHistoricalPatch,
  buildHistoricalDependencies,
  materializeHistoricalDependencies,
  calibrateHistorical,
  gradeHistorical,
  requireHistoricalEnvironment,
} = historical;
// @ts-expect-error -- checkout-only manual eval ESM.
import { dependencySnapshot } from "../../../scripts/evals/lead.mjs";
const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
  vi.restoreAllMocks();
});
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const graderPaths = ["apps/clankie/test/owner-attachments.test.ts", "apps/tui/test/send-attach.test.ts"];
/**
 * A small replay repository shaped like the real one (graders, eval tooling, testing docs, a link,
 * a pre-fix parent and a fix). Materializing the full checkout is disk-bound and took over 30s
 * per workspace under fleet load (VUH-2056); the real task's pins are still checked below.
 */
let synthetic: { root: string; source: object } | undefined;
afterAll(() => {
  if (synthetic) rmSync(synthetic.root, { recursive: true, force: true });
});
function syntheticSource() {
  if (synthetic) return synthetic.source;
  const root = mkdtempSync(join(realpathSync(tmpdir()), "historical-source-"));
  const repository = join(root, "repo");
  const git = (...args: string[]) =>
    execFileSync(
      "/usr/bin/git",
      ["-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "-c", "commit.gpgsign=false", ...args],
      {
        cwd: repository,
        env: { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      },
    )
      .toString()
      .trim();
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repository, path)), { recursive: true });
    writeFileSync(join(repository, path), text);
  };
  mkdirSync(repository);
  git("init", "-q");
  write("package.json", '{"name":"fixture","private":true,"packageManager":"pnpm@11.11.0"}\n');
  write("pnpm-workspace.yaml", "packages:\n  - apps/*\n  - packages/*\n");
  write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  for (const name of ["apps/clankie", "apps/tui", "packages/protocol"])
    write(`${name}/package.json`, `{"name":"@fixture/${name.split("/")[1]}"}\n`);
  write("apps/clankie/src/attachments.ts", "export const attachments = false;\n");
  write("apps/tui/src/send.ts", "export const send = () => undefined;\n");
  write("apps/tui/test/send.test.ts", "// existing visible test\n");
  write(graderPaths[0]!, "// pre-fix grader, withheld from agents\n");
  write("scripts/evals/lead-tasks.json", "{}\n");
  write("docs/testing/README.md", "# Evidence\n");
  write("AGENTS.md", "# Fixture\n");
  symlinkSync("AGENTS.md", join(repository, "CLAUDE.md"));
  git("add", "-A");
  git("commit", "-qm", "base");
  write("apps/clankie/src/attachments.ts", "export const attachments = true;\n");
  write(graderPaths[0]!, "// held-out grader\n");
  write(graderPaths[1]!, "// held-out grader\n");
  git("add", "-A");
  git("commit", "-qm", "fix");
  const prompt = "Let the owner attach files.";
  const graders = graderPaths.map((path) => ({
    path,
    blob: git("rev-parse", `HEAD:${path}`),
    sha256: sha(readFileSync(join(repository, path))),
  }));
  const task = {
    id: "fixture-attachments",
    kind: "historical",
    sourceCommit: git("rev-parse", "HEAD"),
    baseCommit: git("rev-parse", "HEAD^"),
    baseTree: git("rev-parse", "HEAD^^{tree}"),
    sourceTree: git("rev-parse", "HEAD^{tree}"),
    prompt,
    promptSha256: sha(prompt),
    timeBudgetSeconds: 60,
    parallelWork: ["apps/clankie", "apps/tui"],
    graders,
  };
  const source = {
    repository,
    tasks: { historical: [task] },
    coverage: {
      results: [
        {
          task: task.id,
          sourceCommit: task.sourceCommit,
          baseCommit: task.baseCommit,
          graders,
          checks: [{ reference: "after", outcome: "pass", summary: ["Tests  11 passed (11)"] }],
        },
      ],
      fileCounts: { [task.id]: [9, 2] },
    },
  };
  synthetic = { root, source };
  return source;
}
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "historical-fixture-"));
  roots.push(root);
  const profile = stageHistorical({
    taskId: "fixture-attachments",
    output: join(root, "profile"),
    source: syntheticSource(),
  });
  const calls: string[][] = [];
  const nodeImage = `node:24.20.0-bookworm@sha256:${"a".repeat(64)}`,
    imageId = `sha256:${"b".repeat(64)}`;
  const containers = new Map<
    string,
    {
      root: string;
      logs?: string;
      argv: string[];
      running: boolean;
      labels: Record<string, string>;
      mounts: object[];
      exitCode: number;
    }
  >();
  const state = {
    daemon: "fixture-daemon",
    architecture: "arm64",
    malformed: false,
    beforeFault: undefined as string | undefined,
    failedAfter: false,
    stopUnconfirmed: false,
    gradeStopUnconfirmed: false,
    gradeStopInspections: 0,
    waited: false,
    stopInspections: 0,
    wait: undefined as undefined | (() => Promise<void>),
    onBuild: undefined as undefined | (() => void),
  };
  const evidence = {
    profileSha256: profile.profileSha256,
    platform: "linux/arm64",
    nodeVersion: "v24.20.0",
    nodeSha256: sha("node"),
    pnpmSha256: sha("pnpm"),
    dependenciesSha256: sha("linux-dependencies"),
    files: 3,
    nativeArtifacts: ["better_sqlite3.node", "pty.node", "esbuild"].map((name) => [
      `node_modules/${name}`,
      493,
      sha(name),
    ]),
  };
  const command = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "info")
      return JSON.stringify({ ID: state.daemon, OSType: "linux", Architecture: state.architecture });
    if (args[0] === "image")
      return JSON.stringify([
        {
          Id: imageId,
          Os: "linux",
          Architecture: state.architecture,
          RepoDigests: [nodeImage, "rust:1.96.1-bookworm@sha256:" + "d".repeat(64)],
        },
      ]);
    if (args[0] === "build") {
      state.onBuild?.();
      writeFileSync(args[args.indexOf("--iidfile") + 1]!, imageId, { mode: 0o600 });
      return "";
    }
    if (args[0] === "create") {
      const id = (containers.size + 1).toString(16).padStart(64, "0"),
        mounts: { Type: string; Source: string; Destination: string; RW: boolean }[] = [],
        labels: Record<string, string> = {};
      args.forEach((arg, i) => {
        if (arg === "--mount") {
          const bits = Object.fromEntries(args[i + 1]!.split(",").map((part) => part.split("=")));
          mounts.push({ Type: "bind", Source: bits.src!, Destination: bits.dst!, RW: !("readonly" in bits) });
        }
        if (arg === "--label") {
          const [key, value] = args[i + 1]!.split("=");
          labels[key!] = value!;
        }
      });
      const rootMount = mounts[0]!;
      const entry = args.indexOf("--entrypoint");
      containers.set(id, {
        root: rootMount.Source,
        ...(mounts[1] ? { logs: mounts[1].Source } : {}),
        argv: [args[entry + 1]!, ...args.slice(entry + 3)],
        running: false,
        labels,
        mounts,
        exitCode: 0,
      });
      return id;
    }
    const c = containers.get(args.at(-1)!) ?? containers.get(args[1]!);
    if (!c) throw Error(`Unexpected fixture command ${args[0]}`);
    if (args[0] === "inspect" && state.stopUnconfirmed && state.waited && ++state.stopInspections > 1)
      throw Error("fixture stop inspection unavailable");
    if (
      args[0] === "inspect" &&
      state.gradeStopUnconfirmed &&
      c.logs?.includes("/grade/linux-verifier") &&
      !c.running &&
      ++state.gradeStopInspections > 3
    )
      throw Error("fixture grade stop unavailable");
    if (args[0] === "inspect")
      return JSON.stringify([
        {
          Id: args[1],
          Image: imageId,
          Config: { User: `${process.getuid!()}:${process.getgid!()}`, Labels: c.labels },
          HostConfig: {
            Privileged: false,
            ReadonlyRootfs: true,
            NetworkMode: "none",
            PidMode: "",
            CapDrop: ["ALL"],
            SecurityOpt: ["no-new-privileges"],
          },
          Mounts: c.mounts,
          State: { Running: c.running },
        },
      ]);
    if (args[0] === "start") {
      c.running = true;
      if (c.logs) {
        const before = c.root.includes("/before/");
        const failing = before || state.failedAfter;
        const testResults = [
          ["apps/clankie/test/owner-attachments.test.ts", 9],
          ["apps/tui/test/send-attach.test.ts", 2],
        ].map(([path, count]) => ({
          name: `/app/${path}`,
          status: failing ? "failed" : "passed",
          assertionResults: Array.from({ length: Number(count) }, (_, i) => ({
            fullName: `fixture ${path} ${i}`,
            status: failing ? "failed" : "passed",
            failureMessages: failing ? ["synthetic failure"] : [],
            duration: 1,
          })),
        }));
        if (before && state.beforeFault) {
          const assertions = testResults[0]!.assertionResults;
          if (state.beforeFault === "import")
            testResults.forEach((entry) => {
              entry.assertionResults = [];
            });
          if (state.beforeFault === "missing") assertions.pop();
          if (state.beforeFault === "skip") assertions[0]!.status = "pending";
          if (state.beforeFault === "duplicate") assertions[1]!.fullName = assertions[0]!.fullName;
          if (state.beforeFault === "duration") assertions[0]!.duration = NaN;
          if (state.beforeFault === "identity") assertions[0]!.fullName = "different before test";
        }
        writeFileSync(
          join(c.logs, "results.json"),
          JSON.stringify(
            state.malformed
              ? { success: true }
              : {
                  success: !failing,
                  numTotalTests: 11,
                  numPassedTests: failing ? 0 : 11,
                  numFailedTests: failing ? 11 : 0,
                  numPendingTests: 0,
                  numTodoTests: 0,
                  numFailedTestSuites: failing ? 2 : 0,
                  numPendingTestSuites: 0,
                  testResults,
                },
          ),
          { mode: 0o600 },
        );
        c.exitCode = failing ? 1 : 0;
      } else {
        let materializedSha256;
        if (c.argv.includes("materialize")) {
          const modules = join(c.root, "worktree/node_modules/vitest");
          mkdirSync(modules, { recursive: true, mode: 0o700 });
          writeFileSync(join(modules, "vitest.mjs"), "// synthetic, never executed\n");
          materializedSha256 = dependencySnapshot(join(c.root, "worktree")).sha256;
        }
        writeFileSync(
          join(c.root, "dependencies.json"),
          JSON.stringify({ ...evidence, ...(materializedSha256 ? { materializedSha256 } : {}) }),
          { mode: 0o600 },
        );
      }
      return "";
    }
    if (args[0] === "wait") {
      await state.wait?.();
      c.running = false;
      state.waited = true;
      return String(c.exitCode);
    }
    if (args[0] === "kill") {
      c.running = false;
      return "";
    }
    throw Error(`Unexpected fixture command ${args[0]}`);
  };
  transports.set(command, { socketPath: "fixture-only", dev: 1, ino: 1 });
  const pnpmTarball = join(root, "pnpm.tgz");
  writeFileSync(pnpmTarball, "fixture package bytes", { mode: 0o600 });
  const build = () =>
    buildHistoricalDependencies({
      profile,
      command,
      output: join(root, "build"),
      platform: "linux/arm64",
      nodeImage,
      pnpmTarball,
      pnpmSha256: sha("fixture package bytes"),
    });
  return { root, profile, command, calls, state, build, nodeImage, pnpmTarball };
}

it("pins exact base dependency inputs and creates independent grader-free workspaces", () => {
  const f = fixture();
  const pinned = stageHistorical({ taskId: "owner-attachments", output: join(f.root, "pinned") });
  expect(pinned.inputs).toHaveLength(51);
  expect(pinned.profileSha256).toBe("af258ee0882eb135a02346f5a759e6471c6724650d0b7ef5d18fbb3665d2abf6");
  const first = stageHistoricalWorkspace(f.profile, join(f.root, "first"));
  const second = stageHistoricalWorkspace(f.profile, join(f.root, "second"));
  expect(readFileSync(join(first.workspace, ".git/config"), "utf8")).not.toContain("remote");
  expect(() => readFileSync(join(first.workspace, "apps/clankie/test/owner-attachments.test.ts"))).toThrow();
  expect(() => readFileSync(join(second.workspace, "scripts/evals/lead-tasks.json"))).toThrow();
  expect(f.calls).toEqual([]);
});
it("builds only the selected manifest recipe and rejects cloned capabilities or changed daemon", async () => {
  const f = fixture(),
    build = await f.build();
  expect(f.calls.find((args) => args[0] === "build")).toContain("linux/arm64");
  const recipe = readFileSync(join(f.root, "build/Dockerfile"), "utf8");
  expect(recipe).toContain("--frozen-lockfile --ignore-scripts");
  expect(recipe).toContain("pnpm rebuild better-sqlite3 esbuild node-pty");
  expect(recipe).not.toContain("sourceCommit");
  await expect(requireHistoricalEnvironment({ ...build }, f.command)).rejects.toThrow("Controller-built");
  f.state.daemon = "replacement";
  await expect(requireHistoricalEnvironment(build, f.command)).rejects.toThrow("daemon changed");
});
it("fails changed input, wrong platform and forged calibration before grading", async () => {
  const f = fixture();
  f.state.architecture = "amd64";
  await expect(f.build()).rejects.toThrow("platform mismatch");
  f.state.architecture = "arm64";
  const build = await f.build();
  await expect(
    gradeHistorical({
      profile: f.profile,
      build,
      calibration: { results: [{ status: "passed" }] },
      command: f.command,
      patchPath: "/never/read",
      output: join(f.root, "grade"),
    }),
  ).rejects.toThrow("calibration required");
  chmodSync(join(f.root, "profile/inputs/package.json"), 0o600);
  writeFileSync(join(f.root, "profile/inputs/package.json"), "{}");
  await expect(requireHistoricalEnvironment(build, f.command)).rejects.toThrow("input changed");
});
it("materializes owned dependencies without any package-manager execution in the candidate", async () => {
  const f = fixture(),
    build = await f.build(),
    root = join(f.root, "candidate");
  mkdirSync(root, { mode: 0o700 });
  stageHistoricalWorkspace(f.profile, join(root, "worktree"));
  const value = await materializeHistoricalDependencies({
    build,
    command: f.command,
    root,
    containerCwd: "/eval/tasks/lead",
  });
  expect(value.dependencies.files).toBeGreaterThan(0);
  expect(
    f.calls
      .filter((args) => ["create", "start", "wait"].includes(args[0]!))
      .flat()
      .join(" "),
  ).not.toMatch(/pnpm (install|rebuild)/);
  expect(JSON.parse(readFileSync(join(root, "container-stop.json"), "utf8")).stop.stopped).toBe(true);
});
it("earns calibration only from contained before/after and reuses exact candidate grading", async () => {
  const f = fixture(),
    build = await f.build();
  const calibration = await calibrateHistorical({
    build,
    command: f.command,
    output: join(f.root, "calibration"),
  });
  expect(calibration.results[0].exitCode).toBe(1);
  expect(calibration.results[1].coverage.complete).toBe(true);
  const patchPath = join(f.root, "candidate.patch");
  writeFileSync(
    patchPath,
    "diff --git a/apps/clankie/src/historical-fixture.ts b/apps/clankie/src/historical-fixture.ts\nnew file mode 100644\n--- /dev/null\n+++ b/apps/clankie/src/historical-fixture.ts\n@@ -0,0 +1 @@\n+export const fixture = true;\n",
  );
  const result = await gradeHistorical({
    profile: f.profile,
    build,
    calibration,
    command: f.command,
    patchPath,
    output: join(f.root, "grade"),
  });
  expect(result.status).toBe("passed");
  expect(result.coverage.executedTests).toBe(11);
  const verifier = f.calls
    .filter((args) => args[0] === "create" && args.some((arg) => arg.includes("/logs/verifier")))
    .at(-1)!;
  expect(verifier).toContain("--network=none");
  expect(verifier).toContain("--read-only");
  expect(verifier.some((arg) => arg.includes(",dst=/app,readonly"))).toBe(true);
});
it("incomplete calibration stays unsupported and cannot mint a grading capability", async () => {
  const f = fixture(),
    build = await f.build();
  f.state.malformed = true;
  await expect(
    calibrateHistorical({ build, command: f.command, output: join(f.root, "bad-calibration") }),
  ).rejects.toThrow("calibration failed");
});
it("cancellation while waiting stops the exact created CID and retains the stop receipt", async () => {
  const f = fixture(),
    build = await f.build(),
    controller = new AbortController();
  const root = join(f.root, "candidate");
  mkdirSync(root, { mode: 0o700 });
  stageHistoricalWorkspace(f.profile, join(root, "worktree"));
  f.state.wait = async () => {
    controller.abort();
  };
  await expect(
    materializeHistoricalDependencies({ build, command: f.command, root, signal: controller.signal }),
  ).rejects.toThrow();
  const receipt = JSON.parse(readFileSync(join(root, "container-stop.json"), "utf8"));
  expect(receipt).toMatchObject({ cancelled: true, stop: { stopped: true } });
  expect(f.calls.some((args) => args[0] === "kill" && args.at(-1) === receipt.containerId)).toBe(true);
});
it("rejects altered controller build context before any artifact probe", async () => {
  const f = fixture();
  f.state.onBuild = () => {
    const path = join(f.root, "build/directories.json");
    writeFileSync(path, "[]");
  };
  await expect(f.build()).rejects.toThrow("builder changed");
  expect(f.calls.some((args) => args[0] === "create")).toBe(false);
});
it("a failed fixed reference cannot mint calibration even with complete report counts", async () => {
  const f = fixture(),
    build = await f.build();
  f.state.failedAfter = true;
  await expect(
    calibrateHistorical({ build, command: f.command, output: join(f.root, "failed-after") }),
  ).rejects.toThrow("calibration failed");
});

it.each(["import", "missing", "skip", "duplicate", "duration", "identity"])(
  "refuses incomplete or unmatched before execution: %s",
  async (fault) => {
    const f = fixture(),
      build = await f.build();
    f.state.beforeFault = fault;
    await expect(
      calibrateHistorical({ build, command: f.command, output: join(f.root, "invalid-before") }),
    ).rejects.toThrow("calibration failed");
  },
);
it("collects source changes without executing native Git configuration or importing dependency trees", () => {
  const f = fixture();
  const { workspace } = stageHistoricalWorkspace(f.profile, join(f.root, "native"));
  writeFileSync(join(workspace, ".git/config"), "[core]\n fsmonitor = /never/execute-native-config\n");
  writeFileSync(join(workspace, "new-source.ts"), "export const changed = true;\n");
  mkdirSync(join(workspace, "node_modules"));
  writeFileSync(join(workspace, "node_modules/ignored"), "native dependencies");
  const patch = readFileSync(
    collectHistoricalPatch({ profile: f.profile, candidateRoot: workspace, output: join(f.root, "patch") }),
    "utf8",
  );
  expect(patch).toContain("new-source.ts");
  expect(patch).not.toContain("node_modules");
  expect(patch).not.toContain("fsmonitor");
  expect(f.calls).toEqual([]);
});

it("composes the native image from only the earned historical dependency image and platform", async () => {
  const f = fixture(),
    dependencies = await f.build();
  for (const name of ["codex", "herdr"]) mkdirSync(join(f.root, name), { mode: 0o700 });
  const options = {
    command: f.command,
    output: join(f.root, "native-build"),
    codexSource: join(f.root, "codex"),
    herdrSource: join(f.root, "herdr"),
    nodeImage: f.nodeImage,
    rustImage: "rust:1.96.1-bookworm@sha256:" + "d".repeat(64),
    historicalEnvironment: dependencies,
  };
  await expect(
    buildNativeImage({ ...options, historicalEnvironment: structuredClone(dependencies) }),
  ).rejects.toThrow("Controller-built");
  await expect(
    buildNativeImage({ ...options, nodeImage: "node:24.20.0-bookworm@sha256:" + "e".repeat(64) }),
  ).rejects.toThrow("Node base mismatch");
  const built = await buildNativeImage(options);
  expect(built.historicalEnvironment.profileSha256).toBe(f.profile.profileSha256);
  const recipe = readFileSync(join(f.root, "native-build/Dockerfile"), "utf8");
  expect(recipe).toContain(`FROM ${dependencies.image}\n`);
  expect(recipe).not.toContain("COPY --from=node");
  expect(f.calls.filter((args) => args[0] === "build").at(-1)).toContain("linux/arm64");
});

it("retains exact CID and typed uncertainty when final stop cannot be confirmed", async () => {
  const f = fixture(),
    build = await f.build();
  const root = join(f.root, "uncertain");
  mkdirSync(root, { mode: 0o700 });
  stageHistoricalWorkspace(f.profile, join(root, "worktree"));
  Object.assign(f.state, { waited: false, stopUnconfirmed: true, stopInspections: 0 });
  await expect(materializeHistoricalDependencies({ build, command: f.command, root })).rejects.toMatchObject({
    code: "historical-stop-unconfirmed",
  });
  expect(JSON.parse(readFileSync(join(root, "container-stop.json"), "utf8"))).toMatchObject({
    containerId: expect.stringMatching(/^[a-f0-9]{64}$/),
    stop: { confirmed: false },
  });
});

it("actual gradeHistorical settlement never yields a passing result when its exact verifier stop is unknown", async () => {
  const f = fixture(),
    build = await f.build();
  const calibration = await calibrateHistorical({
    build,
    command: f.command,
    output: join(f.root, "calibration"),
  });
  const patchPath = join(f.root, "candidate.patch");
  writeFileSync(
    patchPath,
    "diff --git a/apps/clankie/src/historical-fixture.ts b/apps/clankie/src/historical-fixture.ts\nnew file mode 100644\n--- /dev/null\n+++ b/apps/clankie/src/historical-fixture.ts\n@@ -0,0 +1 @@\n+export const fixture = true;\n",
  );
  f.state.gradeStopUnconfirmed = true;
  await expect(
    gradeHistorical({
      profile: f.profile,
      build,
      calibration,
      command: f.command,
      patchPath,
      output: join(f.root, "grade"),
    }),
  ).rejects.toMatchObject({ code: "historical-stop-unconfirmed" });
  const receipt = JSON.parse(readFileSync(join(f.root, "grade/linux-verifier/container-stop.json"), "utf8"));
  expect(receipt).toMatchObject({
    containerId: expect.stringMatching(/^[a-f0-9]{64}$/),
    stop: { confirmed: false },
  });
  expect(() => readFileSync(join(f.root, "grade/grading-result.json"))).toThrow();
});
