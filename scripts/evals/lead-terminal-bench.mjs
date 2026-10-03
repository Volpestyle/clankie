/** Official Terminal-Bench v4 contexts/verifier, kept separate from interactive native execution. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { LeadContainer } from "./lead-containment.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const tasks = JSON.parse(readFileSync(new URL("./lead-tasks.json", import.meta.url))).neutral;
const stagedRecords = new WeakMap();
const ARTIFACTS = { "html-js-filter": "filter.py", "photonic-waveguide-routing": "routing_result_1.json" };

function ownedFile(root, path, maxBytes = 16 * 1024 * 1024) {
  if (resolve(path) !== path || realpathSync(root) !== root) throw Error("Noncanonical verifier path");
  for (let current = dirname(path); ; current = dirname(current)) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error("Symbolic verifier ancestry");
    if (current === root) break;
    if (dirname(current) === current) throw Error("Verifier path escaped owned root");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.size > maxBytes)
      throw Error("Verifier artifact is not a bounded owned regular file");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Copy only manifest-pinned files; untracked Dockerfiles/.dockerignore never enter contexts. */
export function stageTerminalBench({ sourceRoot, taskId, output }) {
  const task = tasks.find((entry) => entry.id === taskId);
  if (!task) throw Error("Unpinned Terminal-Bench task");
  const git = (...args) => execFileSync("git", ["-C", sourceRoot, ...args], { encoding: "utf8" }).trim();
  if (git("rev-parse", "HEAD") !== task.commit || git("rev-parse", `HEAD:tasks/${taskId}`) !== task.tree)
    throw Error("Official Terminal-Bench source pin mismatch");
  mkdirSync(output, { mode: 0o700 });
  const read = (path, expected) => {
    const bytes = ownedFile(sourceRoot, join(sourceRoot, path));
    if (hash(bytes) !== expected) throw Error(`Official source hash mismatch: ${path}`);
    return bytes;
  };
  writeFileSync(join(output, "LICENSE"), read("LICENSE", task.licenseSha256), { flag: "wx", mode: 0o400 });
  let testsSource = "";
  for (const file of task.files) {
    const bytes = read(file.path, file.sha256);
    const local = file.path.slice(`tasks/${taskId}/`.length);
    if (local.startsWith("solution/")) continue;
    const path = join(output, local);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, bytes, { flag: "wx", mode: 0o400 });
    if (/^tests\/test_.*\.py$/u.test(local)) testsSource += bytes.toString();
  }
  // These two pinned tasks have simple test methods, without parametrization.
  if (/parametrize/u.test(testsSource)) throw Error("Parameterized verifier needs explicit case pinning");
  const expectedTests = [...testsSource.matchAll(/^\s*def (test_[a-zA-Z0-9_]+)\(/gmu)].map(
    (match) => match[1],
  );
  if (!expectedTests.length || new Set(expectedTests).size !== expectedTests.length)
    throw Error("Ambiguous verifier case coverage");
  const staged = {
    schemaVersion: 1,
    taskId,
    commit: task.commit,
    tree: task.tree,
    licenseSha256: task.licenseSha256,
    output,
    expectedTests,
    artifact: ARTIFACTS[taskId],
    files: task.files,
  };
  stagedRecords.set(staged, structuredClone(staged));
  return staged;
}

export function terminalBenchResult(report, reward, expectedTests) {
  const results = report?.results;
  const cases = results?.tests;
  if (
    !Array.isArray(cases) ||
    cases.length !== expectedTests.length ||
    results.summary?.tests !== expectedTests.length
  )
    throw Error("Incomplete official verifier coverage");
  const names = cases.map((test) => (typeof test.name === "string" ? test.name.split("::").at(-1) : null));
  if (
    new Set(names).size !== names.length ||
    !expectedTests.every((name) => names.includes(name)) ||
    cases.some((test) => !["passed", "failed"].includes(test.status))
  )
    throw Error("Missing/skipped/malformed verifier cases");
  const passed = cases.every((test) => test.status === "passed");
  if (
    passed &&
    (results.summary.passed !== expectedTests.length || results.summary.failed !== 0 || reward.trim() !== "1")
  )
    throw Error("Inconsistent official verifier reward/report");
  return {
    status: passed ? "passed" : "failed",
    tests: cases.length,
    passed: cases.filter((test) => test.status === "passed").length,
  };
}

/** These methods launch real Docker commands only when explicitly invoked after the run hold. */
export class TerminalBenchBridge {
  #images = new Map();
  #staged;
  constructor({ staged, command }) {
    if (!stagedRecords.has(staged))
      throw Error("Only controller-staged pinned official sources are accepted");
    this.#staged = structuredClone(stagedRecords.get(staged));
    this.command = command;
  }
  async build(role) {
    if (!["environment", "tests"].includes(role)) throw Error("Unknown official build context");
    const context = join(this.#staged.output, role);
    const prefix = `tasks/${this.#staged.taskId}/${role}/`;
    const expected = new Map(
      this.#staged.files
        .filter((file) => file.path.startsWith(prefix))
        .map((file) => [file.path.slice(prefix.length), file.sha256]),
    );
    const visit = (directory, relative = "") => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const local = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) visit(join(directory, entry.name), local);
        else if (!entry.isFile() || expected.get(local) !== hash(ownedFile(context, join(context, local))))
          throw Error("Official build context was altered or gained an unpinned file");
      }
    };
    visit(context);
    for (const [path, expectedHash] of expected)
      if (hash(ownedFile(context, join(context, path))) !== expectedHash)
        throw Error("Official context source missing/changed");
    const iid = join(this.#staged.output, `${role}.image-id`);
    await this.command(["build", "--iidfile", iid, "--file", join(context, "Dockerfile"), context], {
      timeout: 1_800_000,
    });
    const image = ownedFile(this.#staged.output, iid, 256).toString().trim();
    if (!/^sha256:[a-f0-9]{64}$/u.test(image)) throw Error("Build returned no immutable image identity");
    this.#images.set(role, image);
    return { image, role, sourceCommit: this.#staged.commit, files: this.#staged.files };
  }
  async verify({ image, candidateRoot, output }) {
    if (this.#images.get("tests") !== image)
      throw Error("Verifier image was not built from this pinned context");
    if (this.#staged.taskId === "html-js-filter")
      throw Error(
        "HTML verifier requires controller-probed isolated candidate trampoline; same-UID report access is refused",
      );
    mkdirSync(output, { mode: 0o700 });
    const app = join(output, "app"),
      logs = join(output, "logs");
    mkdirSync(app, { mode: 0o700 });
    mkdirSync(logs, { mode: 0o700 });
    const bytes = ownedFile(candidateRoot, join(candidateRoot, this.#staged.artifact));
    writeFileSync(join(app, this.#staged.artifact), bytes, { flag: "wx", mode: 0o400 });
    const container = new LeadContainer({
      image,
      root: app,
      verifierLogs: logs,
      role: "verifier",
      command: this.command,
    });
    await container.create(["/bin/sh", "-c", "HOME=/tmp /bin/bash /tests/test.sh"], {
      memoryMb: 8192,
      cpus: 2,
    });
    try {
      await container.start();
      const exitCode = await this.command(["wait", container.id], {
        timeout: this.#staged.taskId === "html-js-filter" ? 1_800_000 : 300_000,
      });
      await container.inspect();
      const reportBytes = ownedFile(logs, join(logs, "ctrf.json"));
      const reward = ownedFile(logs, join(logs, "reward.txt"), 64).toString();
      const result = terminalBenchResult(JSON.parse(reportBytes), reward, this.#staged.expectedTests);
      if (exitCode.trim() !== "0" && result.status === "passed")
        throw Error("Official verifier exited unsuccessfully");
      return {
        ...result,
        containerId: container.id,
        image,
        artifactSha256: hash(bytes),
        reportSha256: hash(reportBytes),
        sourceCommit: this.#staged.commit,
      };
    } finally {
      await container.stop("official verification settled");
    }
  }
}
