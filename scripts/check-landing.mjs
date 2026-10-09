import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { landingTypechecks } from "./testing/landing-typechecks.mjs";

const args = process.argv.slice(2);
const separator = args.indexOf("--");
const options = separator < 0 ? args : args.slice(0, separator);
const vitestArgs = separator < 0 ? [] : args.slice(separator + 1);
for (let index = 0; index < options.length; index += 2)
  if (!["--root", "--base", "--report"].includes(options[index]))
    throw new Error(`Unknown gate option: ${options[index]}`);
for (const argument of vitestArgs)
  if (!/^--(?:reporter|outputFile)(?:\.[\w-]+)?=.+$/u.test(argument))
    throw new Error(`Only reporter/outputFile options may follow --: ${argument}`);
const value = (name, fallback) => {
  const index = options.indexOf(name);
  if (index < 0) return fallback;
  if (!options[index + 1] || options[index + 1].startsWith("--")) throw new Error(`Missing ${name} value`);
  return options[index + 1];
};
const root = resolve(value("--root", fileURLToPath(new URL("../", import.meta.url))));
process.chdir(root);
const git = (...command) => execFileSync("git", command, { cwd: root, encoding: "utf8" }).trim();
const base = git(
  "rev-parse",
  "--verify",
  `${value("--base", process.env.CLANKIE_LANDING_BASE ?? "origin/main")}^{commit}`,
);
const head = git("rev-parse", "HEAD");
const fingerprint = async () => {
  const hash = createHash("sha256");
  const diff = spawn("git", ["diff", "--binary", "HEAD"], { stdio: ["ignore", "pipe", "inherit"] });
  await Promise.all([
    new Promise((resolve, reject) => {
      diff.once("error", reject);
      diff.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`git diff exited ${code}`))));
    }),
    (async () => {
      for await (const chunk of diff.stdout) hash.update(chunk);
    })(),
  ]);
  for (const path of git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean))
    hash.update(path).update(readFileSync(path));
  return hash.digest("hex");
};
const source = await fingerprint();
const reportPath = resolve(value("--report", ".local/landing-gate.json"));
const report = { head, base, source, phases: [], exitCode: null };
const save = () => {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
};
const started = performance.now();
let exit = 0;
const run = (name, command, environment = {}) => {
  if (exit) return;
  console.log(`[landing] ${name}: ${command.join(" ")}`);
  const before = performance.now();
  const child = spawnSync(command[0], command.slice(1), {
    stdio: "inherit",
    env: { ...process.env, CARGO_BUILD_JOBS: "1", ...environment },
  });
  const code = child.status ?? 1;
  if (child.error) console.error(child.error.message);
  report.phases.push({
    name,
    command,
    elapsedSeconds: (performance.now() - before) / 1000,
    exitCode: code,
    signal: child.signal,
  });
  exit = code;
  save();
};
console.log(`[landing] root ${root}; HEAD ${head}; fixed base ${base}`);
run("skills", ["pnpm", "herdr:skill:check"]);
run("format", ["pnpm", "fmt:check"]);
run("lint", ["pnpm", "lint"]);
run("deadcode", ["pnpm", "deadcode"]);
run("doc-links", ["node", "scripts/check-doc-links.mjs"]);
run("retired-claims", ["node", "scripts/check-retired-claims.mjs"]);
run("evidence", ["node", "scripts/testing/evidence-landing-guard.mjs"]);
if (!exit) {
  const before = performance.now();
  try {
    report.typecheckScope = landingTypechecks(root, base);
    report.typecheckScope.elapsedSeconds = (performance.now() - before) / 1000;
    console.log(
      `[landing] typecheck ${report.typecheckScope.packages.length}/${report.typecheckScope.total}: ${report.typecheckScope.packages.join(", ") || "no affected compiler inputs"}`,
    );
    if (report.typecheckScope.packages.length)
      run(
        "typecheck",
        [
          "pnpm",
          "exec",
          "turbo",
          "run",
          "typecheck",
          "--only",
          "--concurrency=1",
          ...report.typecheckScope.packages.map((name) => `--filter=${name}`),
        ],
        { CLANKIE_LANDING_TYPE_INPUTS: report.typecheckScope.inputHash },
      );
  } catch (error) {
    console.error(`[landing] Cannot determine compiler scope: ${error.message}`);
    report.typecheckScopeError = error.message;
    exit = 1;
  }
}
run("tests", [
  "pnpm",
  "exec",
  "vitest",
  "run",
  "--config",
  "vitest.config.ts",
  "--changed",
  base,
  "--bail",
  "1",
  "--passWithNoTests",
  ...vitestArgs,
]);
report.sourceStable = git("rev-parse", "HEAD") === head && (await fingerprint()) === source;
if (!report.sourceStable) {
  console.error("[landing] Source changed while the gate ran; this result cannot authorize a push.");
  exit = 1;
}
report.exitCode = exit;
report.elapsedSeconds = (performance.now() - started) / 1000;
save();
console.log(`[landing] exit ${exit}; ${report.elapsedSeconds.toFixed(2)}s; evidence ${reportPath}`);
process.exitCode = exit;
