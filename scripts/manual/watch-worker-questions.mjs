import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Run the complete owned runtime through `clankie heavy -- node THIS_FILE`.
const root = resolve(import.meta.dirname, "../..");
const id = `watch-worker-${randomUUID()}`;
const directory = join(root, ".local", id);
const context = join(directory, "context");
mkdirSync(context, { recursive: true });
const files = execFileSync("git", ["ls-files", "-z"], { cwd: root });
writeFileSync(join(context, "files"), files);
execFileSync("tar", ["-cf", join(context, "source.tar"), "--null", "-T", join(context, "files")], {
  cwd: root,
});
writeFileSync(
  join(context, "Dockerfile"),
  readFileSync(join(root, "apps/clankie/test/fixtures/watch-worker-native/Dockerfile")),
);
const image = `clankie-watch-worker-proof:${id}`;
const run = (args, timeout = 300_000) => {
  const result = spawnSync("docker", args, {
    cwd: root,
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0)
    throw Object.assign(new Error(`docker ${args[0]} failed: ${result.error ?? result.status}`), {
      stdout: result.stdout,
      stderr: result.stderr,
    });
  return result.stdout + result.stderr;
};
try {
  const built = run(["build", "--platform", "linux/arm64", "-t", image, context], 600_000);
  writeFileSync(join(directory, "build.log"), built);
  const result = run([
    "run",
    "--rm",
    "--init",
    "--name",
    id,
    "--label",
    `clankie.watch-proof=${id}`,
    // The canonical proof refuses a nested PID namespace. No guard is weakened.
    "--pid",
    "host",
    "--network",
    "none",
    "--cpus",
    "2",
    "--memory",
    "4g",
    "--pids-limit",
    "256",
    "--security-opt",
    "seccomp=unconfined",
    "--security-opt",
    "systempaths=unconfined",
    "--mount",
    `type=bind,src=${directory},dst=/proof`,
    image,
  ]);
  writeFileSync(join(directory, "run.log"), result);
  console.log(result.trim());
  console.log(`Evidence: ${directory}`);
} catch (error) {
  writeFileSync(
    join(directory, "failure.log"),
    String(error.stdout ?? "") + String(error.stderr ?? "") + String(error),
  );
  console.error(`Native proof failed; evidence: ${directory}`);
  throw error;
} finally {
  let label;
  try {
    label = run(["inspect", id, "--format", '{{index .Config.Labels "clankie.watch-proof"}}']).trim();
  } catch {
    /* A completed --rm container is already gone. */
  }
  if (label === id) run(["rm", "-f", id]);
}
