// The command reference in docs/cli.md is generated from the launcher's command
// registry (apps/tui/src/command/registry.ts), the same table `clankie help` prints.
// The prose around it stays hand-written (#334).
//   node scripts/cli-doc.mjs          check: exit 1 when the reference drifts
//   node scripts/cli-doc.mjs --write  regenerate it
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const path = join(root, "docs", "cli.md");
const { commandHelp } = await import(join(root, "apps/tui/src/command/registry.ts"));

const START = "<!-- command-reference:start -->";
const END = "<!-- command-reference:end -->";
const generated = [
  START,
  "<!-- Generated from apps/tui/src/command/registry.ts by `pnpm docs:cli`; edit the registry, not this block. -->",
  "",
  "```text",
  commandHelp(),
  "```",
  "",
  END,
].join("\n");

const doc = readFileSync(path, "utf8");
const start = doc.indexOf(START);
const end = doc.indexOf(END);
if (start < 0 || end < start) {
  console.error(`[cli-doc] docs/cli.md has no ${START} … ${END} block`);
  process.exit(1);
}
const next = doc.slice(0, start) + generated + doc.slice(end + END.length);
if (process.argv.includes("--write")) {
  if (next !== doc) writeFileSync(path, next);
  console.log(
    `[cli-doc] docs/cli.md ${next === doc ? "already matches" : "regenerated from"} the command registry`,
  );
} else if (next !== doc) {
  console.error(
    "[cli-doc] docs/cli.md's command reference drifted from apps/tui/src/command/registry.ts; run `pnpm docs:cli`",
  );
  process.exit(1);
} else console.log("[cli-doc] docs/cli.md matches the command registry");
