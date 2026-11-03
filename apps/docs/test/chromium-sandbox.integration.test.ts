import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

// #560: the PR check refuses a Chromium launch without its sandbox. The real
// script runs over a real git checkout.
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

it("refuses launches that leave Chromium unsandboxed", () => {
  const result = check({
    "apps/one/src/default.ts": "await chromium.launch({ headless: true });\n",
    "apps/one/src/server.ts": "await chromium.launchServer({\n  chromiumSandbox: false,\n});\n",
    "apps/one/test/flag.test.ts":
      'await chromium.launch({ chromiumSandbox: true, args: ["--no-sandbox"] });\n',
    "apps/one/src/spawn.ts": 'spawn(chrome, ["--disable-setuid-sandbox"]);\n',
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("apps/one/src/default.ts:1: chromium.launch without chromiumSandbox: true");
  expect(result.stderr).toContain(
    "apps/one/src/server.ts:1: chromium.launchServer without chromiumSandbox: true",
  );
  expect(result.stderr).toContain("apps/one/test/flag.test.ts:1: passes a sandbox-disabling flag");
  expect(result.stderr).toContain("apps/one/src/spawn.ts:1: passes a sandbox-disabling flag");
});

it("passes sandboxed launches and an explained exception", () => {
  const result = check({
    "apps/one/src/viewer.ts": [
      "const browser = await chromium.launch({",
      '  ...(path ? { executablePath: path } : { channel: "chrome" }),',
      "  chromiumSandbox: true,",
      "});",
      "type Launched = ReturnType<typeof chromium.launch>;",
      "",
    ].join("\n"),
    "apps/one/test/ci.test.ts": [
      "// allow-no-sandbox -- this runner's kernel denies Chrome's user namespaces",
      'await chromium.launch({ args: ["--no-sandbox"] });',
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
