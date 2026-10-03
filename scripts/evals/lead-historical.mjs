/** Manual historical Linux preparation. Importing performs no build, probe or run.
 * Reports remain in-process evidence: containment does not make a reporter cryptographically
 * resistant to candidate code running in the same verifier process.
 */
import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { LeadContainer, dockerTransportIdentity } from "./lead-containment.mjs";
import {
  dependencySnapshot,
  gradeCandidate,
  historicalDependencyInputs,
  loadTasks,
  prepareCandidate,
  prepareHistoricalWorkspace,
  prepareReference,
  validateGraderReport,
  verifyTask,
} from "./lead.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const profiles = new WeakMap(),
  builds = new WeakMap(),
  materializations = new WeakMap(),
  calibrations = new WeakMap();
const digest = /^[a-f0-9]{64}$/u;
function owned(root) {
  if (root !== resolve(root) || /[,\r\n]/u.test(root))
    throw Error("Canonical owned historical directory required");
  for (let path = root; ; path = dirname(path)) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Historical directory ancestry changed");
    if (path === root && (stat.uid !== process.getuid() || stat.mode & 0o077))
      throw Error("Private historical directory required");
    if (dirname(path) === path) break;
  }
  return root;
}
function fresh(root) {
  mkdirSync(root, { mode: 0o700 });
  return owned(root);
}
function file(root, path, max = 128 * 1024 * 1024) {
  owned(root);
  if (!path.startsWith(`${root}/`) || realpathSync(path) !== path)
    throw Error("Historical artifact escaped root");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.size > max)
      throw Error("Bounded owned historical artifact required");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
function persist(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
function task(id) {
  const selected = loadTasks().historical.find((entry) => entry.id === id);
  if (!selected) throw Error("Pinned historical task required");
  return verifyTask(selected);
}
function profileRecord(profile) {
  const record = profiles.get(profile);
  if (!record) throw Error("Controller-staged historical profile required");
  for (const entry of record.inputs)
    if (hash(file(record.output, join(record.output, "inputs", entry.path))) !== entry.sha256)
      throw Error("Historical dependency input changed");
  verifyTask(record.task);
  return record;
}

/** Source-only staging; no dependencies, current checkout, future history or graders reach agents. */
export function stageHistorical({ taskId, output }) {
  const selected = task(taskId);
  fresh(output);
  fresh(join(output, "inputs"));
  const inputs = historicalDependencyInputs(selected).map(({ path, bytes }) => {
    if (path === ".npmrc" || path === ".pnpmfile.cjs")
      throw Error("Historical package-manager hook/config needs explicit reviewed support");
    const target = join(output, "inputs", path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, bytes, { flag: "wx", mode: 0o400 });
    return { path, sha256: hash(bytes) };
  });
  const pkg = JSON.parse(file(output, join(output, "inputs/package.json")));
  if (pkg.packageManager !== "pnpm@11.11.0") throw Error("Unsupported historical package manager");
  const profileSha256 = hash(JSON.stringify(inputs.map(({ path, sha256 }) => [path, sha256])));
  const result = Object.freeze({
    taskId,
    baseCommit: selected.baseCommit,
    sourceTree: selected.baseTree,
    profileSha256,
    inputs: structuredClone(inputs),
    packageManager: pkg.packageManager,
  });
  profiles.set(result, { task: selected, output, inputs, profileSha256 });
  persist(join(output, "profile.json"), result);
  return result;
}
export function stageHistoricalWorkspace(profile, output) {
  return prepareHistoricalWorkspace(profileRecord(profile).task, output);
}

function platform(value) {
  if (!["linux/amd64", "linux/arm64"].includes(value))
    throw Error("Explicit supported Linux platform required");
  return value.split("/")[1];
}
async function endpoint(command, selectedPlatform, signal) {
  signal?.throwIfAborted();
  const transport = dockerTransportIdentity(command);
  const daemon = JSON.parse(await command(["info", "--format", "{{json .}}"], { signal }));
  signal?.throwIfAborted();
  const architecture = { x86_64: "amd64", aarch64: "arm64" }[daemon.Architecture] ?? daemon.Architecture;
  if (!daemon.ID || daemon.OSType !== "linux" || architecture !== platform(selectedPlatform))
    throw Error("Historical daemon/platform mismatch");
  return { transport, daemonId: daemon.ID, platform: selectedPlatform };
}
async function image(command, id, selectedPlatform, signal) {
  const rows = JSON.parse(await command(["image", "inspect", id], { signal }));
  signal?.throwIfAborted();
  const value = rows[0];
  if (
    rows.length !== 1 ||
    !/^sha256:[a-f0-9]{64}$/u.test(value?.Id) ||
    value.Os !== "linux" ||
    value.Architecture !== platform(selectedPlatform) ||
    !(value.Id === id || value.RepoDigests?.includes(id))
  )
    throw Error("Exact Linux dependency image required; no implicit pull");
  return value.Id;
}
async function assertBuild(build, command, signal) {
  const record = builds.get(build);
  if (!record || record.command !== command) throw Error("Controller-built dependency image required");
  profileRecord(record.profile);
  if (JSON.stringify(await endpoint(command, record.platform, signal)) !== JSON.stringify(record.endpoint))
    throw Error("Historical daemon changed");
  if ((await image(command, record.image, record.platform, signal)) !== record.image)
    throw Error("Historical image changed");
  return record;
}

/** The trusted image helper only copies frozen dependency bytes; it never executes candidate code. */
const helper = String.raw`
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const root = '/opt/historical/deps';
const dirs = JSON.parse(fs.readFileSync('/opt/historical/directories.json'));
function entries(base) {
 const rows=[];
 function visit(p) { const stat=fs.lstatSync(p), name=path.relative(base,p);
  if(stat.isSymbolicLink()) { const target=fs.realpathSync(p); if(!target.startsWith(base+'/')) throw Error('External dependency link'); rows.push([name,'link',fs.readlinkSync(p)]); }
  else if(stat.isDirectory()) for(const n of fs.readdirSync(p).sort()) visit(path.join(p,n));
  else if(stat.isFile()) rows.push([name,stat.mode & 511,sha(fs.readFileSync(p))]); else throw Error('Unsupported dependency artifact');
 }
 for(const dir of dirs) if(fs.existsSync(path.join(base,dir))) visit(path.join(base,dir));
 return rows;
}
const source = entries(root);
const nativeArtifacts = source.filter(r=>typeof r[1]==='number' && (/\.node$/.test(r[0]) || /\/esbuild$/.test(r[0])));
const receipt = {profileSha256:fs.readFileSync('/opt/historical/profile','utf8').trim(), platform:process.platform+'/'+({x64:'amd64',arm64:'arm64'}[process.arch]), nodeVersion:process.version, nodeSha256:sha(fs.readFileSync(process.execPath)), pnpmSha256:sha(fs.readFileSync('/opt/pnpm/bin/pnpm.cjs')), dependenciesSha256:sha(JSON.stringify(source)), files:source.length, nativeArtifacts};
if(process.argv[2]==='materialize') {
 const dest='/eval/worktree', containerCwd=process.argv[3];
 if(!/^\/(app|eval\/tasks\/[a-z0-9-]+)$/.test(containerCwd)) throw Error('Explicit contained working directory required');
 for(const dir of dirs) {
  const from=path.join(root,dir), to=path.join(dest,dir);
  if(!fs.existsSync(from)) continue;
  let parent=path.dirname(to); for(;;) { if(fs.existsSync(parent)&&fs.lstatSync(parent).isSymbolicLink()) throw Error('Dependency ancestry link'); if(parent===dest) break; parent=path.dirname(parent); }
  if(fs.existsSync(to)) throw Error('Dependencies already exist');
  fs.mkdirSync(path.dirname(to),{recursive:true}); fs.cpSync(from,to,{recursive:true,dereference:false,verbatimSymlinks:true});
 }
 function wrappers(p) { const stat=fs.lstatSync(p); if(stat.isSymbolicLink()) return;
  if(stat.isDirectory()) { for(const n of fs.readdirSync(p)) wrappers(path.join(p,n)); }
  else if(path.basename(path.dirname(p))==='.bin') { const b=fs.readFileSync(p,'utf8'); fs.writeFileSync(p,b.split(root).join(containerCwd)); }
 }
 for(const dir of dirs) if(fs.existsSync(path.join(dest,dir))) wrappers(path.join(dest,dir));
 receipt.materializedSha256=sha(JSON.stringify(entries(dest)));
}
fs.writeFileSync('/eval/dependencies.json',JSON.stringify(receipt),{flag:'wx',mode:384});
`;

async function contained({ command, image: imageId, root, argv, logs, signal, timeoutMs = 120000 }) {
  signal?.throwIfAborted();
  const container = new LeadContainer({
    image: imageId,
    root,
    role: logs ? "verifier" : "probe",
    command,
    ...(logs ? { verifierLogs: logs } : {}),
  });
  let stop;
  const cancel = () => {
    if (container.id) {
      stop ??= container.stop("historical operation cancelled");
      void stop.catch(() => {});
    }
  };
  signal?.addEventListener("abort", cancel, { once: true });
  let exitCode, stopReceipt;
  try {
    await container.create(argv);
    signal?.throwIfAborted();
    await container.start();
    signal?.throwIfAborted();
    exitCode = Number(await command(["wait", container.id], { timeout: timeoutMs, signal }));
    const state = await container.inspect();
    if (state.State?.Running || !Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255)
      throw Error("Historical verifier completion unconfirmed");
    signal?.throwIfAborted();
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (container.id) {
      try {
        stopReceipt = await (stop ?? container.stop("historical operation settled"));
      } finally {
        persist(join(logs ?? root, "container-stop.json"), {
          containerId: container.id,
          stop: stopReceipt ?? { confirmed: false },
          cancelled: signal?.aborted === true,
        });
      }
    }
  }
  return { exitCode, containerId: container.id, stopReceipt, timedOut: false, overflow: false };
}

/** Requires separately authorized build work. Tests inject fake Docker transport; import never builds. */
export async function buildHistoricalDependencies({
  profile,
  command,
  output,
  platform: selectedPlatform,
  nodeImage,
  pnpmTarball,
  pnpmSha256,
  signal,
}) {
  const record = profileRecord(profile);
  platform(selectedPlatform);
  if (!/^node:24\.20\.0-bookworm@sha256:[a-f0-9]{64}$/u.test(nodeImage) || !digest.test(pnpmSha256))
    throw Error("Pinned Node image and pnpm tarball hash required");
  const binding = await endpoint(command, selectedPlatform, signal);
  await image(command, nodeImage, selectedPlatform, signal);
  const tarball = file(owned(dirname(pnpmTarball)), pnpmTarball);
  if (hash(tarball) !== pnpmSha256) throw Error("Pinned pnpm tarball changed");
  fresh(output);
  fresh(join(output, "inputs"));
  for (const entry of record.inputs) {
    const destination = join(output, "inputs", entry.path);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, file(record.output, join(record.output, "inputs", entry.path)), {
      flag: "wx",
      mode: 0o400,
    });
  }
  const directories = [
    "node_modules",
    ...["apps", "packages", "integrations"].flatMap((category) =>
      record.inputs
        .filter(({ path }) => path.startsWith(`${category}/`) && /^[^/]+\/[^/]+\/package\.json$/u.test(path))
        .map(({ path }) => `${dirname(path)}/node_modules`)
        .sort(),
    ),
  ];
  writeFileSync(join(output, "pnpm.tgz"), tarball, { flag: "wx", mode: 0o400 });
  writeFileSync(join(output, "helper.cjs"), helper, { flag: "wx", mode: 0o400 });
  writeFileSync(join(output, "profile"), record.profileSha256, { flag: "wx", mode: 0o400 });
  persist(join(output, "directories.json"), directories);
  const recipe = `FROM ${nodeImage}\nCOPY pnpm.tgz /tmp/pnpm.tgz\nRUN echo '${pnpmSha256}  /tmp/pnpm.tgz' | sha256sum -c - && mkdir /opt/pnpm && tar -xzf /tmp/pnpm.tgz -C /opt/pnpm --strip-components=1 && test "$(node -p "require('/opt/pnpm/package.json').version")" = 11.11.0 && ln -s /opt/pnpm/bin/pnpm.cjs /usr/local/bin/pnpm\nENV PATH=/opt/pnpm/bin:/usr/local/bin:/usr/bin:/bin\nENV pnpm_config_verify_deps_before_run=false\nCOPY inputs/ /opt/historical/deps/\nCOPY helper.cjs profile directories.json /opt/historical/\nWORKDIR /opt/historical/deps\nRUN command -v python3 && command -v make && command -v g++ && pnpm install --frozen-lockfile --ignore-scripts && pnpm rebuild better-sqlite3 esbuild node-pty\n`;
  writeFileSync(join(output, "Dockerfile"), recipe, { flag: "wx", mode: 0o400 });
  const iid = join(output, "image-id");
  await command(
    ["build", "--platform", selectedPlatform, "--iidfile", iid, "--file", join(output, "Dockerfile"), output],
    { timeout: 7200000, signal },
  );
  signal?.throwIfAborted();
  if (JSON.stringify(await endpoint(command, selectedPlatform, signal)) !== JSON.stringify(binding))
    throw Error("Historical build daemon changed");
  profileRecord(profile);
  for (const entry of record.inputs)
    if (hash(file(output, join(output, "inputs", entry.path))) !== entry.sha256)
      throw Error("Dependency build context changed");
  if (
    hash(file(output, join(output, "Dockerfile"))) !== hash(recipe) ||
    hash(file(output, join(output, "helper.cjs"))) !== hash(helper) ||
    hash(file(output, join(output, "pnpm.tgz"))) !== pnpmSha256 ||
    file(output, join(output, "profile")).toString() !== record.profileSha256 ||
    file(output, join(output, "directories.json")).toString() !== `${JSON.stringify(directories, null, 2)}\n`
  )
    throw Error("Dependency builder changed");
  const id = file(output, iid, 256).toString().trim();
  if (!/^sha256:[a-f0-9]{64}$/u.test(id)) throw Error("Historical build lacks exact image identity");
  await image(command, id, selectedPlatform, signal);
  const probe = fresh(join(output, "receipt"));
  const run = await contained({
    command,
    image: id,
    root: probe,
    argv: ["/usr/local/bin/node", "/opt/historical/helper.cjs"],
    signal,
  });
  if (run.exitCode !== 0) throw Error("Dependency artifact verification failed");
  const evidence = JSON.parse(file(probe, join(probe, "dependencies.json")));
  if (
    evidence.profileSha256 !== record.profileSha256 ||
    evidence.platform !== selectedPlatform ||
    evidence.nodeVersion !== "v24.20.0" ||
    !digest.test(evidence.nodeSha256) ||
    !digest.test(evidence.pnpmSha256) ||
    !digest.test(evidence.dependenciesSha256) ||
    !(evidence.files > 0) ||
    !Array.isArray(evidence.nativeArtifacts) ||
    !["better_sqlite3.node", "pty.node", "esbuild"].every((name) =>
      evidence.nativeArtifacts.some(
        (entry) => Array.isArray(entry) && entry[0].endsWith(`/${name}`) && digest.test(entry[2]),
      ),
    )
  )
    throw Error("Incomplete Linux dependency provenance");
  const result = Object.freeze({
    image: id,
    platform: selectedPlatform,
    profileSha256: record.profileSha256,
    taskId: record.task.id,
    nodeImage,
    pnpmTarballSha256: pnpmSha256,
    recipeSha256: hash(recipe),
    helperSha256: hash(helper),
    evidence,
    run,
  });
  builds.set(result, { ...structuredClone(result), command, endpoint: binding, profile });
  persist(join(output, "build.json"), result);
  return result;
}

/** Materialize once, before any native writer or grader starts. No package manager executes. */
export async function materializeHistoricalDependencies({
  build,
  command,
  root,
  containerCwd = "/app",
  signal,
}) {
  const record = await assertBuild(build, command, signal);
  owned(root);
  owned(join(root, "worktree"));
  if (!/^\/(app|eval\/tasks\/[a-z0-9-]+)$/u.test(containerCwd))
    throw Error("Explicit contained workspace required");
  const run = await contained({
    command,
    image: record.image,
    root,
    argv: ["/usr/local/bin/node", "/opt/historical/helper.cjs", "materialize", containerCwd],
    signal,
  });
  if (run.exitCode !== 0) throw Error("Dependency materialization failed");
  const evidence = JSON.parse(file(root, join(root, "dependencies.json")));
  const snapshot = dependencySnapshot(join(root, "worktree"));
  if (
    evidence.profileSha256 !== record.profileSha256 ||
    evidence.dependenciesSha256 !== record.evidence.dependenciesSha256 ||
    evidence.nodeSha256 !== record.evidence.nodeSha256 ||
    evidence.materializedSha256 !== snapshot.sha256
  )
    throw Error("Materialized dependencies differ from controller-built image");
  await assertBuild(build, command, signal);
  const result = Object.freeze({ root, containerCwd, dependencies: snapshot, image: record.image, run });
  materializations.set(result, { ...structuredClone(result), build });
  return result;
}

async function verifyTree({ build, command, root, output, signal }) {
  const record = await assertBuild(build, command, signal);
  const selected = profileRecord(record.profile).task;
  const workspace = join(root, "worktree");
  fresh(output);
  const argv = [
    "/usr/bin/env",
    "-i",
    "PATH=/usr/local/bin:/usr/bin:/bin",
    "HOME=/tmp/home",
    "TMPDIR=/tmp",
    "XDG_CONFIG_HOME=/tmp/config",
    "XDG_STATE_HOME=/tmp/state",
    "CLANKIE_SETTINGS_FILE=/tmp/settings.json",
    "CLANKIE_STATE=/tmp/state",
    "pnpm_config_verify_deps_before_run=false",
    "/bin/sh",
    "-c",
    'mkdir -p /tmp/home /tmp/config /tmp/state && exec "$@"',
    "historical-verifier",
    "/usr/local/bin/node",
    "/app/node_modules/vitest/vitest.mjs",
    "run",
    "--config",
    "vitest.config.ts",
    "--configLoader=runner",
    "--cache=false",
    "--reporter=json",
    "--outputFile=/logs/verifier/results.json",
    ...selected.graders.map((entry) => entry.path),
  ];
  const result = await contained({
    command,
    image: record.image,
    root: workspace,
    logs: output,
    argv,
    signal,
  });
  await assertBuild(build, command, signal);
  const bytes = file(output, join(output, "results.json"));
  const report = JSON.parse(bytes);
  // Only normalize the fixed mount prefix, never arbitrary report-supplied paths.
  for (const entry of report.testResults ?? []) {
    if (
      typeof entry.name !== "string" ||
      !selected.graders.some((grader) => `/app/${grader.path}` === entry.name)
    )
      throw Error("Unexpected Linux grader file");
    entry.name = join(workspace, entry.name.slice(5));
  }
  return {
    ...result,
    report,
    verifierReportSha256: hash(bytes),
    coverage: validateGraderReport(selected, workspace, report),
  };
}

/** Calibration is earned by contained before/after execution, never imported report JSON. */
export async function calibrateHistorical({ build, command, output, signal }) {
  const record = await assertBuild(build, command, signal);
  const selected = profileRecord(record.profile).task;
  fresh(output);
  const results = [];
  for (const revision of ["before", "after"]) {
    const root = fresh(join(output, revision));
    prepareReference(selected, join(root, "worktree"), revision);
    const dependencies = await materializeHistoricalDependencies({ build, command, root, signal });
    const sourceBefore = sourceSnapshot(join(root, "worktree"));
    const result = await verifyTree({ build, command, root, output: join(root, "logs"), signal });
    if (
      sourceSnapshot(join(root, "worktree")) !== sourceBefore ||
      dependencySnapshot(join(root, "worktree")).sha256 !== dependencies.dependencies.sha256
    )
      throw Error("Calibration inputs changed");
    results.push({ revision, ...result, sourceSha256: sourceBefore });
  }
  const [before, after] = results;
  if (
    before.exitCode === 0 ||
    before.report.success !== false ||
    !before.report.testResults?.length ||
    !(before.report.numFailedTests > 0 || before.report.numFailedTestSuites > 0) ||
    after.exitCode !== 0 ||
    !after.coverage.complete
  )
    throw Error("Linux before/after calibration failed; historical task remains unsupported");
  const proof = Object.freeze({
    taskId: selected.id,
    image: record.image,
    platform: record.platform,
    results,
  });
  calibrations.set(proof, { build, command });
  persist(join(output, "calibration.json"), proof);
  return proof;
}
/** Native image integration verifies this in-process capability on the same exact daemon. */
export async function requireHistoricalEnvironment(build, command, signal) {
  const record = await assertBuild(build, command, signal);
  return structuredClone({
    image: record.image,
    platform: record.platform,
    profileSha256: record.profileSha256,
    evidence: record.evidence,
  });
}
function sourceSnapshot(root) {
  const entries = [];
  const visit = (path) => {
    for (const name of readdirSync(path).sort()) {
      if (name === "node_modules" || name === ".git") continue;
      const full = join(path, name),
        stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        // Retained reference links are inert inside the read-only verifier mount;
        // snapshot their text without ever traversing owner-host targets.
        entries.push([full.slice(root.length + 1), "link", readlinkSync(full)]);
        continue;
      }
      if (!stat.isDirectory() && !stat.isFile()) throw Error("Unsupported historical source artifact");
      if (stat.isDirectory()) visit(full);
      else entries.push([full.slice(root.length + 1), hash(file(root, full))]);
    }
  };
  visit(root);
  return hash(JSON.stringify(entries));
}

/** Candidate grading uses the existing protected preparation and completeness validator. */
export async function gradeHistorical({ profile, build, calibration, command, patchPath, output, signal }) {
  const record = await assertBuild(build, command, signal);
  const proof = calibrations.get(calibration);
  if (!proof || proof.build !== build || proof.command !== command || record.profile !== profile)
    throw Error("Exact controller-earned Linux calibration required");
  const selected = profileRecord(profile).task;
  prepareCandidate(selected, patchPath, output);
  const materialized = await materializeHistoricalDependencies({ build, command, root: output, signal });
  const authority = materializations.get(materialized);
  if (!authority || authority.build !== build) throw Error("Owned materialized dependencies required");
  const result = await gradeCandidate(output, {
    runtime: {
      nodeVersion: record.evidence.nodeVersion,
      nodeSha256: record.evidence.nodeSha256,
      image: record.image,
      platform: record.platform,
    },
    execute: async () => {
      if (dependencySnapshot(join(output, "worktree")).sha256 !== authority.dependencies.sha256)
        throw Error("Candidate dependencies changed");
      const verified = await verifyTree({
        build,
        command,
        root: output,
        output: join(output, "linux-verifier"),
        signal,
      });
      persist(join(output, "tmp/heldout-results.json"), verified.report);
      return {
        exitCode: verified.exitCode,
        containerId: verified.containerId,
        stopReceipt: verified.stopReceipt,
        timedOut: false,
        overflow: false,
        linuxReportSha256: verified.verifierReportSha256,
      };
    },
  });
  signal?.throwIfAborted();
  return { ...result, calibrationImage: calibration.image, historicalProfile: record.profileSha256 };
}
