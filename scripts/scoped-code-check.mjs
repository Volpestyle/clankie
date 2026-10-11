import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const [mode, ...input] = process.argv.slice(2);
if (!["fmt", "fmt:check", "lint"].includes(mode)) throw new Error("Unknown code check");
const args = input;
const values = new Set([
  "--threads",
  "-c",
  "--config",
  "--ignore-path",
  "--tsconfig",
  "--max-warnings",
  "-A",
  "--allow",
  "-W",
  "--warn",
  "-D",
  "--deny",
  "--format",
]);
const files = [];
let positional = false;
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (!positional && arg === "--") positional = true;
  else if (!positional && arg.startsWith("-")) {
    if (values.has(arg)) index++;
  } else files.push(arg);
}
const whole = files.length === 0 || files.some((file) => resolve(file) === process.cwd());
const run = (command) => {
  const child = spawnSync("pnpm", command, { stdio: "inherit", shell: false });
  if (child.error) throw child.error;
  if (child.status !== 0) process.exit(child.status ?? 1);
};
run([
  "exec",
  mode === "lint" ? "oxlint" : "oxfmt",
  mode === "lint" ? "--deny-warnings" : mode === "fmt" ? "--write" : "--check",
  ...args,
  ...(files.length === 0 ? ["."] : []),
]);
// Keep the existing native workspace checks for the repository-wide scripts.
// Explicit files ask only for those files, never an unrelated Vox traversal.
if (whole && mode !== "fmt") run(["--filter", "@clankie/vox", mode]);
