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
import { LeadContainer, dockerTransportIdentity } from "./lead-containment.mjs";
import { buildHtmlMediation, probeHtmlMediation, assertHtmlMediation } from "./lead-html-mediation.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const tasks = JSON.parse(readFileSync(new URL("./lead-tasks.json", import.meta.url))).neutral;
const stagedRecords = new WeakMap();
const environmentBuilds = new WeakMap();
export async function requireTerminalBenchEnvironment(value, command) {
  const record = environmentBuilds.get(value);
  if (
    !record ||
    record.command !== command ||
    JSON.stringify(record.endpoint) !== JSON.stringify(dockerTransportIdentity(command))
  )
    throw Error("Controller-built official task environment required");
  const daemon = JSON.parse(await command(["info", "--format", "{{json .}}"]));
  if (!daemon.ID || daemon.ID !== record.daemonId) throw Error("Official environment daemon changed");
  return structuredClone(record.evidence);
}
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
  #htmlBuild;
  #htmlProof;
  constructor({ staged, command }) {
    if (!stagedRecords.has(staged))
      throw Error("Only controller-staged pinned official sources are accepted");
    this.#staged = structuredClone(stagedRecords.get(staged));
    this.command = command;
  }
  async build(role) {
    if (!["environment", "tests"].includes(role)) throw Error("Unknown official build context");
    const endpoint = role === "environment" ? dockerTransportIdentity(this.command) : undefined;
    const daemon =
      role === "environment" ? JSON.parse(await this.command(["info", "--format", "{{json .}}"])) : undefined;
    if (role === "environment" && !daemon?.ID)
      throw Error("Official environment daemon identity unavailable");
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
    const result = Object.freeze({
      image,
      role,
      taskId: this.#staged.taskId,
      sourceCommit: this.#staged.commit,
      files: structuredClone(this.#staged.files),
    });
    if (role === "environment")
      environmentBuilds.set(result, {
        command: this.command,
        endpoint,
        daemonId: daemon.ID,
        evidence: structuredClone(result),
      });
    return result;
  }
  /** Preserve exact initial environment inputs, separately from held-out grader files. */
  stageWorkspaceInputs(workspace) {
    if (
      realpathSync(workspace) !== workspace ||
      !lstatSync(workspace).isDirectory() ||
      lstatSync(workspace).uid !== process.getuid() ||
      lstatSync(workspace).mode & 0o077
    )
      throw Error("Private allocated task workspace required");
    const names =
      this.#staged.taskId === "photonic-waveguide-routing" ? ["check_routing.py", "layout_spec.json"] : [];
    const records = [];
    for (const name of names) {
      const sourcePath = `tasks/${this.#staged.taskId}/environment/${name}`;
      const expected = this.#staged.files.find((file) => file.path === sourcePath);
      const bytes = ownedFile(this.#staged.output, join(this.#staged.output, "environment", name));
      if (!expected || hash(bytes) !== expected.sha256) throw Error("Pinned initial task input changed");
      writeFileSync(join(workspace, name), bytes, { flag: "wx", mode: 0o600 });
      records.push({ name, sha256: expected.sha256 });
    }
    return records;
  }
  async buildHtml({ nativeBuild, output }) {
    const baseImage = this.#images.get("tests");
    if (this.#staged.taskId !== "html-js-filter" || !baseImage || this.#htmlBuild)
      throw Error("One pinned HTML verifier build required");
    this.#htmlBuild = await buildHtmlMediation({
      command: this.command,
      nativeBuild,
      baseImage,
      sourceCommit: this.#staged.commit,
      output,
    });
    return this.#htmlBuild;
  }
  async probeHtml({ root }) {
    if (!this.#htmlBuild || this.#htmlProof)
      throw Error("One controller-built HTML mediation image required");
    this.#htmlProof = await probeHtmlMediation({ build: this.#htmlBuild, command: this.command, root });
    return this.#htmlProof;
  }
  async verify({ image, candidateRoot, output, signal }) {
    signal?.throwIfAborted();
    const html = this.#staged.taskId === "html-js-filter";
    const mediation = html
      ? await assertHtmlMediation(this.#htmlProof, {
          command: this.command,
          image,
          baseImage: this.#images.get("tests"),
          sourceCommit: this.#staged.commit,
        })
      : undefined;
    if (!html && this.#images.get("tests") !== image)
      throw Error("Verifier image was not built from this pinned context");
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
    const argv = [
      "/usr/bin/env",
      "-i",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "HOME=/tmp",
      "PYTHONDONTWRITEBYTECODE=1",
      ...(html ? ["PYTHONPATH=/opt/lead/bootstrap"] : []),
      "/bin/bash",
      "/tests/test.sh",
    ];
    let cancelledStop,
      starting = false,
      activationUnconfirmed = false;
    const cancel = () => {
      if (container.id && !starting) {
        cancelledStop ??= container.stop("official verification cancelled");
        void cancelledStop.catch(() => {});
      }
    };
    signal?.addEventListener("abort", cancel, { once: true });
    let result, completionError, stopReceipt, stopFailure;
    try {
      signal?.throwIfAborted();
      await container.create(argv, {
        memoryMb: 8192,
        cpus: 2,
      });
      signal?.throwIfAborted();
      // Do not latch a stopped receipt while the bounded start command can still activate.
      starting = true;
      try {
        await container.start();
      } catch (error) {
        // A lost start reply cannot prove that the daemon will not activate later.
        activationUnconfirmed = true;
        throw error;
      } finally {
        starting = false;
      }
      signal?.throwIfAborted();
      const exitCode = await this.command(["wait", container.id], {
        timeout: this.#staged.taskId === "html-js-filter" ? 1_800_000 : 300_000,
        ...(signal ? { signal } : {}),
      });
      await container.inspect();
      signal?.throwIfAborted();
      if (html) {
        let failed = false;
        try {
          lstatSync(join(logs, "lead-mediation-failure"));
          failed = true;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (failed) throw Error("HTML candidate mediation failed; verifier result is invalid");
      }
      const reportBytes = ownedFile(logs, join(logs, "ctrf.json"));
      const reward = ownedFile(logs, join(logs, "reward.txt"), 64).toString();
      const report = terminalBenchResult(JSON.parse(reportBytes), reward, this.#staged.expectedTests);
      if (exitCode.trim() !== "0" && report.status === "passed")
        throw Error("Official verifier exited unsuccessfully");
      result = {
        ...report,
        containerId: container.id,
        image,
        artifactSha256: hash(bytes),
        reportSha256: hash(reportBytes),
        ...(mediation ? { mediation } : {}),
        sourceCommit: this.#staged.commit,
      };
    } catch (error) {
      completionError = error instanceof Error ? error : Error(String(error));
    } finally {
      signal?.removeEventListener("abort", cancel);
      if (container.id) {
        let stopError = activationUnconfirmed
          ? Error("Official verifier activation outcome unconfirmed")
          : undefined;
        try {
          stopReceipt = await (cancelledStop ?? container.stop("official verification settled"));
        } catch (error) {
          stopError = error instanceof Error ? error : Error(String(error));
        }
        if (stopError) {
          stopFailure = Object.assign(
            Error("Official verifier container stop unconfirmed", { cause: stopError }),
            {
              code: "terminal-bench-stop-unconfirmed",
              containerId: container.id,
              verifierStopConfirmed: false,
            },
          );
        }
        // Cancellation during cleanup also prevents accepting an otherwise valid report.
        try {
          signal?.throwIfAborted();
        } catch (error) {
          completionError ??= error instanceof Error ? error : Error(String(error));
        }
        try {
          writeFileSync(
            join(output, "container-stop.json"),
            JSON.stringify({
              containerId: container.id,
              stop: stopReceipt ?? { confirmed: false },
              activationUnconfirmed,
              verifierStopConfirmed: stopReceipt?.stopped === true && !stopFailure,
              cancelled: signal?.aborted === true,
              completionError: completionError?.message ?? null,
              stopError: stopFailure?.cause instanceof Error ? stopFailure.cause.message : null,
            }),
            { flag: "wx", mode: 0o600 },
          );
        } catch (error) {
          completionError ??= error instanceof Error ? error : Error(String(error));
        }
      }
    }
    if (stopFailure) throw stopFailure;
    if (completionError)
      throw Object.assign(completionError, {
        ...(container.id ? { containerId: container.id } : {}),
        verifierStopConfirmed: stopReceipt?.stopped === true,
      });
    return { ...result, stopReceipt, verifierStopConfirmed: true };
  }
}
