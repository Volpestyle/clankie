import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

// #560: the PR check refuses a Chromium launch it can't prove sandboxed. The real
// script runs over a real git checkout; each fixture is one file.
const script = resolve(import.meta.dirname, "../../../scripts/check-chromium-sandbox.mjs");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function check(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "chromium-sandbox-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return spawnSync(process.execPath, [script, root], { encoding: "utf8" });
}

const core = 'import { chromium } from "playwright-core";\n';
const refused: Record<string, string> = {
  "default.ts": `${core}await chromium.launch({ headless: true });\n`,
  "false.ts": `${core}await chromium.launchServer({ chromiumSandbox: false });\n`,
  "renamed.ts": 'import { chromium as chrome } from "playwright-core";\nawait chrome.launch({});\n',
  "namespace-alias.ts":
    'import * as pw from "playwright";\nconst bt = pw.chromium;\nawait bt.launch({ headless: true });\n',
  "element.ts":
    'import pw from "playwright-core";\nawait pw["chromium"].launchPersistentContext("/tmp/p", {});\n',
  "persistent-alias.ts":
    'import { chromium as c } from "playwright-core";\nconst d = c;\nawait d.launchPersistentContext("/tmp/p", { headless: true });\n',
  "dynamic.ts":
    'const { chromium: c } = await import("playwright-core");\nawait c.launch({ headless: true });\n',
  "later-spread.ts": `${core}await chromium.launch({ chromiumSandbox: true, ...{ chromiumSandbox: false } });\n`,
  "unknown-spread.ts": `${core}await chromium.launch({ chromiumSandbox: true, ...extra });\n`,
  "nested-decoy.ts": `${core}await chromium.launch({ env: { chromiumSandbox: true } });\n`,
  "string-decoy.ts": `${core}await chromium.launch({ headless: true, title: "chromiumSandbox: true" });\n`,
  "composed-flag.ts": `${core}await chromium.launch({ chromiumSandbox: true, args: ["--no-" + "sandbox"] });\n`,
  "variable-args.ts": `${core}await chromium.launch({ chromiumSandbox: true, args: flags });\n`,
  "spawn-flag.ts": 'spawn(chrome, ["--disable-setuid-sandbox"]);\n',
  "spawn-composed.ts": 'spawn(chrome, ["--no-" + "sandbox"]);\n',
  "escape.ts": `${core}hand(chromium);\n`,
  "method-escape.ts": `${core}const start = chromium.launch;\nawait start({ chromiumSandbox: true });\n`,
  "computed.ts": `${core}await chromium[method]({ chromiumSandbox: true });\n`,
  "options-variable.ts": `${core}let options = { chromiumSandbox: true };\nawait chromium.launch(options);\n`,
};

it("refuses every launch it can't prove sandboxed", () => {
  const result = check(
    Object.fromEntries(Object.entries(refused).map(([name, text]) => [`src/${name}`, text])),
  );
  expect(result.status).toBe(1);
  for (const name of Object.keys(refused)) expect(result.stderr, name).toContain(`src/${name}:`);
});

it("passes sandboxed launches, a const options object and an explained exception", () => {
  const result = check({
    "src/viewer.ts": [
      core,
      "const browser = await chromium.launch({",
      '  ...(path ? { executablePath: path } : { channel: "chrome" }),',
      "  chromiumSandbox: true,",
      '  args: ["--use-angle=swiftshader"],',
      "});",
      "type Launched = ReturnType<typeof chromium.launch>;",
      "",
    ].join("\n"),
    "src/const-options.ts": `${core}const options = { headless: true, chromiumSandbox: true } as const;\nawait chromium.launch(options);\n`,
    "src/persistent.ts": `import * as pw from "playwright-core";\nawait pw.chromium.launchPersistentContext("/tmp/p", { chromiumSandbox: true });\n`,
    "src/dynamic.ts":
      'const { chromium } = await import("playwright-core");\nawait chromium.launchServer({ chromiumSandbox: true, headless: true });\n',
    "src/unrelated.ts": "await Browser.chromium({ profileDir, headless: true });\n",
    "test/ci.test.ts": [
      "// allow-no-sandbox -- this runner's kernel denies Chrome's user namespaces",
      'spawn(chrome, ["--no-sandbox"]);',
      "",
    ].join("\n"),
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});

it("passes this repository", () => {
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});
