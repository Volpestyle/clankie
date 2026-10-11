import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const reporter = fileURLToPath(new URL("./testing/release-test-reporter.mjs", import.meta.url));
const testScript =
  "vitest run --config vitest.config.ts && pnpm --filter @clankie/vox test && pnpm --filter @clankie/vox-client smoke debug";

async function run(command, args, root, env) {
  return await new Promise((fulfill) => {
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit" });
    let interrupted = false;
    const interrupt = (signal) => {
      interrupted = true;
      child.kill(signal);
    };
    const int = () => interrupt("SIGINT");
    const term = () => interrupt("SIGTERM");
    process.on("SIGINT", int);
    process.on("SIGTERM", term);
    child.on("error", (error) => console.error(error));
    child.on("close", (code, signal) => {
      process.off("SIGINT", int);
      process.off("SIGTERM", term);
      fulfill({ code, signal, interrupted });
    });
  });
}

function report(path, runId, root) {
  const data = JSON.parse(readFileSync(path, "utf8"));
  if (
    data.version !== 1 ||
    data.runId !== runId ||
    !["passed", "failed"].includes(data.reason) ||
    !Array.isArray(data.errors) ||
    data.errors.length ||
    !Array.isArray(data.selected) ||
    !data.selected.length ||
    !Array.isArray(data.files) ||
    data.files.length !== data.selected.length
  )
    throw new Error("Incomplete, interrupted, stale or unhandled-error Vitest report; release blocked.");
  const selected = new Set(data.selected);
  if (selected.size !== data.selected.length) throw new Error("Duplicate test selections; release blocked.");
  for (const file of data.files) {
    if (
      typeof file.path !== "string" ||
      !selected.delete(file.path) ||
      !/^(apps|packages|integrations)\/[^/]+\/test\/.+\.test\.ts$/u.test(file.path) ||
      /[^a-zA-Z0-9._/-]/u.test(file.path) ||
      isAbsolute(file.path) ||
      file.path.split("/").includes("..") ||
      relative(realpathSync(root), realpathSync(resolve(root, file.path))).startsWith("..") ||
      !["passed", "failed", "skipped"].includes(file.state) ||
      !Array.isArray(file.tests) ||
      file.tests.some(
        (test) => typeof test.name !== "string" || !["passed", "failed", "skipped"].includes(test.state),
      ) ||
      (file.state !== "failed" && file.tests.some((test) => test.state === "failed"))
    )
      throw new Error("Unaccounted or unfinished test file; release blocked.");
  }
  if (selected.size) throw new Error("Missing test files; release blocked.");
  return data;
}

function summary(root, flaky, blocked, message, summaryFile = process.env.GITHUB_STEP_SUMMARY) {
  const text = [
    "## Flaky on first attempt",
    "",
    ...(flaky.length ? flaky.map((file) => `- \`${file}\``) : ["None."]),
    "",
    ...(blocked.length
      ? ["### Failed isolated reruns", "", ...blocked.map((file) => `- \`${file}\``), ""]
      : []),
    message,
    "",
  ].join("\n");
  writeFileSync(join(root, ".data/qa/release-check-summary.md"), text);
  if (summaryFile) appendFileSync(summaryFile, text);
  console.log(text);
}

// Exported for real-Vitest acceptance proofs in an isolated scratch repository.
export async function retryFailedFiles({
  root,
  firstReport,
  runId,
  summaryFile = process.env.GITHUB_STEP_SUMMARY,
}) {
  mkdirSync(join(root, ".data/qa"), { recursive: true });
  const flaky = [],
    blocked = [];
  try {
    const first = report(firstReport, runId, root);
    const failed = first.files.filter((file) => file.state === "failed");
    if (first.reason !== "failed" || !failed.length)
      throw new Error("Failure is outside Vitest test files; release blocked.");
    for (const [index, file] of failed.entries()) {
      const retryId = randomUUID();
      const retryReport = join(root, `.data/qa/release-rerun-${index + 1}.json`);
      const outcome = await run(
        "pnpm",
        [
          "exec",
          "vitest",
          "run",
          "--config",
          "vitest.config.ts",
          file.path,
          "--maxWorkers=1",
          "--no-file-parallelism",
          "--retry=0",
          "--reporter=default",
          `--reporter=${reporter}`,
          ...(process.env.CI
            ? ["--reporter=junit", `--outputFile.junit=.data/qa/release-rerun-${index + 1}.xml`]
            : []),
        ],
        root,
        {
          ...process.env,
          VITEST_MAX_WORKERS: "1",
          CLANKIE_RELEASE_TEST_REPORT: retryReport,
          CLANKIE_RELEASE_TEST_RUN_ID: retryId,
          CLANKIE_RELEASE_RETRY_FILE: file.path,
        },
      );
      let passed = outcome.code === 0 && !outcome.signal && !outcome.interrupted;
      try {
        const retried = report(retryReport, retryId, root);
        const actual = retried.files[0];
        // Vitest's positional filter is a substring: verify it ran exactly this
        // file, and that every previously executed case is present and passes.
        const expected = file.tests.filter((test) => test.state !== "skipped");
        const actualTests = actual.tests.filter((test) => test.state !== "skipped");
        const remaining = actualTests.map((test) => test.name);
        passed &&=
          retried.reason === "passed" &&
          retried.files.length === 1 &&
          actual.path === file.path &&
          actual.state === "passed" &&
          actualTests.length > 0 &&
          actualTests.length >= expected.length &&
          actualTests.every((test) => test.state === "passed") &&
          expected.every((test) => {
            const index = remaining.indexOf(test.name);
            if (index < 0) return false;
            remaining.splice(index, 1);
            return true;
          });
      } catch (error) {
        console.error(error.message);
        passed = false;
      }
      (passed ? flaky : blocked).push(file.path);
      if (outcome.signal || outcome.interrupted)
        throw new Error("Isolated rerun interrupted; release blocked.");
    }
    const ok = blocked.length === 0 && flaky.length <= 2;
    summary(
      root,
      flaky,
      blocked,
      ok
        ? "Every failed file passed its one isolated rerun."
        : "Release blocked: a rerun failed or more than 2 files flaked.",
      summaryFile,
    );
    return ok;
  } catch (error) {
    summary(root, flaky, blocked, error.message, summaryFile);
    return false;
  }
}

async function checkRelease(root) {
  const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
  // pnpm check stops at Vitest before these native checks. Fail closed if its
  // sequencing changes; do not accidentally omit newly added check phases.
  if (scripts.test !== testScript || !scripts.check.endsWith(" && pnpm test"))
    throw new Error("Release continuation no longer matches pnpm check; update it before releasing.");
  const directory = join(root, ".data/qa");
  mkdirSync(directory, { recursive: true });
  const runId = randomUUID();
  const firstReport = join(directory, "release-first-attempt.json");
  const first = await run("pnpm", ["check"], root, {
    ...process.env,
    CLANKIE_RELEASE_RETRY_FILE: "",
    CLANKIE_RELEASE_TEST_REPORT: firstReport,
    CLANKIE_RELEASE_TEST_RUN_ID: runId,
  });
  if (first.code === 0 && !first.signal && !first.interrupted) {
    summary(root, [], [], "Full pnpm check passed on the first attempt.");
    return true;
  }
  if (first.signal || first.interrupted) {
    summary(root, [], [], "Full pnpm check interrupted; release blocked.");
    return false;
  }
  if (!(await retryFailedFiles({ root, firstReport, runId }))) return false;
  // These are the original pnpm test suffix, which && prevented from running.
  for (const args of [
    ["--filter", "@clankie/vox", "test"],
    ["--filter", "@clankie/vox-client", "smoke", "debug"],
  ]) {
    const result = await run("pnpm", args, root, process.env);
    if (result.code !== 0 || result.signal || result.interrupted) {
      const message = `Native continuation failed: pnpm ${args.join(" ")}; release blocked.\n`;
      appendFileSync(join(directory, "release-check-summary.md"), message);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, message);
      return false;
    }
  }
  return true;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = (await checkRelease(process.cwd())) ? 0 : 1;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
