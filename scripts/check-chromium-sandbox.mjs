// Fails when code launches Chromium without its sandbox (#560). Playwright passes
// --no-sandbox to Chromium unless a launch sets `chromiumSandbox: true`, so every
// `chromium.launch`, `launchServer` and `launchPersistentContext` call must set it,
// and no code may pass --no-sandbox or --disable-setuid-sandbox itself.
// A launch that truly cannot keep the sandbox (a Linux CI runner, say) says why
// on its own line or the line above, and keeps that exception scoped:
//   // allow-no-sandbox -- this runner's kernel denies the user namespaces Chrome needs
// Usage: node scripts/check-chromium-sandbox.mjs [ROOT]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? resolve(import.meta.dirname, ".."));
const code = /\.[cm]?[jt]sx?$/u;
// This checker and its test name the flags it refuses; docs and evals keep history and fixtures.
const skipped = [
  /^scripts\/check-chromium-sandbox\.mjs$/u,
  /^apps\/docs\/test\/chromium-sandbox\.integration\.test\.ts$/u,
  /^docs\//u,
  /^evals\//u,
];
const launch = /\bchromium\s*\.\s*(launch|launchServer|launchPersistentContext)\s*\(/gu;
const unsandboxed = /--(?:no-sandbox|disable-setuid-sandbox)\b/u;
const allowed = /allow-no-sandbox\s+--\s+\S/u;

/** The text of the call's arguments, from the opening parenthesis to its match. */
function argumentsOf(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === "(") depth += 1;
    else if (character === ")" && --depth === 0) return source.slice(open, index + 1);
  }
  return source.slice(open);
}

const failures = [];
const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
})
  .split("\0")
  .filter((path) => path && code.test(path) && !skipped.some((rule) => rule.test(path)));
for (const path of files) {
  let source;
  try {
    source = readFileSync(resolve(root, path), "utf8");
  } catch {
    continue; // Deleted in the working tree but still in the index.
  }
  const lines = source.split("\n");
  const excused = (line) => allowed.test(lines[line] ?? "") || allowed.test(lines[line - 1] ?? "");
  const lineOf = (offset) => source.slice(0, offset).split("\n").length - 1;
  lines.forEach((text, line) => {
    if (unsandboxed.test(text) && !excused(line))
      failures.push(`${path}:${line + 1}: passes a sandbox-disabling flag: ${text.trim()}`);
  });
  for (const match of source.matchAll(launch)) {
    const line = lineOf(match.index);
    const options = argumentsOf(source, match.index + match[0].length - 1);
    if (!/\bchromiumSandbox\s*:\s*true\b/u.test(options) && !excused(line))
      failures.push(`${path}:${line + 1}: chromium.${match[1]} without chromiumSandbox: true`);
  }
}
if (failures.length) {
  process.stderr.write(
    [
      "Chromium launched without its sandbox. Playwright adds --no-sandbox unless a launch sets",
      "`chromiumSandbox: true`. Set it, or explain a scoped exception with `// allow-no-sandbox -- why`.",
      ...failures,
      "",
    ].join("\n"),
  );
  process.exit(1);
}
console.log(`chromium sandbox: ${files.length} files checked`);
