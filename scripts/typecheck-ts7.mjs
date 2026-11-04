// TypeScript 7's native compiler over every package `pnpm typecheck` checks, beside
// tsc 5.9 until the two agree for a while (#391). Each package's own tsconfig, no emit.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The package exports only its API; its `tsc` bin sits beside package.json.
const compiler = join(dirname(fileURLToPath(import.meta.resolve("typescript7/package.json"))), "bin", "tsc");
const packages = ["apps", "integrations", "packages"].flatMap((group) =>
  readdirSync(join(root, group))
    .map((name) => join(root, group, name))
    .filter((dir) => {
      const manifest = join(dir, "package.json");
      if (!existsSync(manifest) || !existsSync(join(dir, "tsconfig.json"))) return false;
      const script = JSON.parse(readFileSync(manifest, "utf8")).scripts?.typecheck ?? "";
      // The TypeScript typechecks; Vox's is cargo.
      return /typecheck\.mjs|\btsc\b/u.test(script);
    }),
);
const requested = process.argv.slice(2);
const selected = requested.length
  ? requested.map((name) => {
      const dir = packages.find((dir) => relative(root, dir).replaceAll("\\", "/") === name);
      if (!dir) throw new Error(`Unknown TypeScript project: ${name}`);
      return dir;
    })
  : packages;
let failed = 0;
const started = performance.now();
for (const dir of new Set(selected)) {
  const at = performance.now();
  const run = spawnSync(process.execPath, [compiler, "-p", join(dir, "tsconfig.json"), "--noEmit"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const seconds = ((performance.now() - at) / 1000).toFixed(1);
  const name = relative(root, dir);
  if (run.status === 0) console.log(`[typecheck:ts7] ${name} passed in ${seconds}s`);
  else {
    failed += 1;
    console.log(`[typecheck:ts7] ${name} failed in ${seconds}s`);
    process.stdout.write(run.stdout + run.stderr);
  }
}
const total = ((performance.now() - started) / 1000).toFixed(1);
const count = new Set(selected).size;
console.log(`[typecheck:ts7] ${count - failed}/${count} packages passed in ${total}s`);
process.exitCode = failed ? 1 : 0;
