import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { fsInputScope, landingFsInputs } from "../../../scripts/testing/landing-fs-inputs.mjs";

const source = fileURLToPath(new URL("../../..", import.meta.url));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(kind: "manifest" | "bridge" = "manifest") {
  const root = mkdtempSync(join(tmpdir(), "landing-fs-selection-"));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Gate fixture");
  git("config", "user.email", "gate@example.invalid");
  git("config", "commit.gpgsign", "false");
  write(".gitignore", ".local/\nnode_modules/\n");
  for (const directory of ["apps", "integrations", "packages"])
    mkdirSync(join(root, directory), { recursive: true });
  // Only unrelated static phases are inert fixtures. Selection, Vitest, graph
  // reporting and the gate entrypoint all run their real production code.
  write("scripts/noop.mjs", "// Static phases are outside this selection proof.\n");
  write(
    "package.json",
    JSON.stringify({
      private: true,
      scripts: Object.fromEntries(
        ["herdr:skill:check", "fmt:check", "lint", "deadcode"].map((name) => [name, "node scripts/noop.mjs"]),
      ),
    }),
  );
  for (const path of [
    "scripts/check-doc-links.mjs",
    "scripts/check-retired-claims.mjs",
    "scripts/check-swallowed-rejections.mjs",
    "scripts/testing/evidence-landing-guard.mjs",
  ])
    write(path, "// Static phase fixture.\n");
  for (const path of ["scripts/testing/landing-graph-reporter.mjs", "scripts/testing/landing-fs-inputs.mjs"])
    write(path, readFileSync(join(source, path), "utf8"));
  write(
    "apps/tui/bin/clankie.ts",
    'console.log(JSON.stringify({schemaVersion:1,required:false,landable:true,status:"not_required"}));\n',
  );
  write(".local/owner-settings.json", "{}\n");
  write(
    "vitest.config.ts",
    `export default { resolve: { alias: { vitest: ${JSON.stringify(fileURLToPath(import.meta.resolve("vitest")))} } }, test: { include: ["apps/*/test/*.test.ts"], pool: "forks", maxWorkers: 1 } };\n`,
  );
  const input =
    kind === "manifest"
      ? "integrations/claude-plugin/worker/.claude-plugin/plugin.json"
      : "integrations/claude-plugin/worker/bin/seat-channel.mjs";
  const consumer =
    kind === "manifest" ? "apps/tui/test/harness-profiles.test.ts" : "apps/tui/test/worker-link.test.ts";
  const contents = (value: number) =>
    kind === "manifest" ? JSON.stringify({ value }) + "\n" : `export const value = ${value};\n`;
  write(input, contents(1));
  // Other declared consumers need to exist in this tiny repository. The fixed
  // expected consumer below performs the actual path read/child import; it is
  // not inferred from the map, so deleting its edge fails the assertion.
  for (const [test, inputs] of Object.entries(landingFsInputs))
    if ((inputs as string[]).includes(input))
      write(test, 'import {it} from "vitest"; it("other mapped consumer", () => {});\n');
  write(
    consumer,
    kind === "manifest"
      ? `import { it, expect } from "vitest"; import { readFileSync } from "node:fs";
it("reads a repository input by path", () => expect(JSON.parse(readFileSync(new URL("../../../${input}", import.meta.url), "utf8")).value).toBe(2));\n`
      : `import {it, expect} from "vitest"; import {execFileSync} from "node:child_process";
const moduleUrl = new URL("../../../${input}", import.meta.url).href;
it("imports a repository module in a child", () => expect(execFileSync(process.execPath, ["--input-type=module", "-e", "import(" + JSON.stringify(moduleUrl) + ").then(m => console.log(m.value))"], {encoding:"utf8"}).trim()).toBe("2"));\n`,
  );
  git("add", "-A");
  git("commit", "-qm", "fixture base");
  const base = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", base);
  const gate = () => {
    const result = spawnSync(process.execPath, [join(source, "scripts/check-landing.mjs"), "--root", root], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        PATH: `${join(source, "node_modules/.bin")}${delimiter}${process.env.PATH}`,
        CLANKIE_SETTINGS_FILE: join(root, ".local/owner-settings.json"),
      },
    });
    const report = JSON.parse(readFileSync(join(root, ".local/landing-gate.json"), "utf8"));
    return { ...result, report };
  };
  return { root, git, write, base, input, consumer, gate, contents };
}

it("runs the real gate union and records filesystem edges in the real reporter", () => {
  const f = fixture();
  f.write(f.input, f.contents(2));
  f.git("add", f.input);
  f.git("commit", "-qm", "change only a filesystem input");
  const result = f.gate();
  expect(result.status, result.stderr + result.stdout).toBe(0);
  expect(result.report.change.files).toEqual([f.input]);
  expect(result.report.tests.testModules).toContain(f.consumer);
  expect(result.report.tests.testModules).toContain("apps/tui/test/worker-link.test.ts");
  expect(result.report.tests.modules[f.consumer]).toContain(f.input);
  expect(result.report.tests.dependencies).toContain(f.input);
}, 60_000);

it("a seat-channel.mjs-only commit selects worker-link and records its child-import edge", () => {
  const f = fixture("bridge");
  f.write(f.input, f.contents(2));
  f.git("add", f.input);
  f.git("commit", "-qm", "change only seat-channel.mjs");
  const result = f.gate();
  expect(result.status, result.stderr + result.stdout).toBe(0);
  expect(result.report.change.files).toEqual(["integrations/claude-plugin/worker/bin/seat-channel.mjs"]);
  expect(result.report.tests.testModules).toContain("apps/tui/test/worker-link.test.ts");
  expect(result.report.tests.modules["apps/tui/test/worker-link.test.ts"]).toContain(f.input);
}, 60_000);

it("fails the real gate closed and names an unmapped executable, including deletion", () => {
  const f = fixture();
  const input = "integrations/unmapped-program";
  f.write(input, "executable fixture\n");
  chmodSync(join(f.root, input), 0o755);
  f.git("add", input);
  f.git("update-index", "--chmod=+x", input);
  f.git("commit", "-qm", "unmapped executable");
  let result = f.gate();
  expect(result.status).toBe(1);
  expect(result.report.fsInputScope.unmappedExecutableInputs).toEqual([input]);
  expect(result.stderr).toContain(input);
  f.git("update-ref", "refs/remotes/origin/main", "HEAD");
  rmSync(join(f.root, input));
  f.git("add", input);
  f.git("commit", "-qm", "delete unmapped executable");
  result = f.gate();
  expect(result.status).toBe(1);
  expect(result.report.fsInputScope.unmappedExecutableInputs).toEqual([input]);
  expect(result.report.fsInputScope.deletedInputs).toEqual([input]);
});

it("gives every existing executable input a real consumer or an explicit coverage declaration", () => {
  const base = execFileSync("git", ["merge-base", "HEAD", "origin/main"], {
    cwd: source,
    encoding: "utf8",
  }).trim();
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: source, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const scope = fsInputScope(source, tracked, base);
  expect(scope.unmappedExecutableInputs).toEqual([]);
  expect(scope.declaredExecutableInputs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: "apps/vox/src/app_state.rs",
        reason: expect.stringContaining("cargo"),
      }),
      expect.objectContaining({
        path: "apps/tui/native/lent-screen.swift",
        reason: expect.stringContaining("manual"),
      }),
    ]),
  );
});

it("records the explicit coverage reason when a declared evidence executable is deleted", () => {
  const f = fixture();
  const input = "docs/testing/proof/flows/probe.sh";
  f.write(input, "#!/bin/sh\nexit 0\n");
  f.git("add", input);
  f.git("commit", "-qm", "declared evidence executable");
  const base = f.git("rev-parse", "HEAD");
  rmSync(join(f.root, input));
  f.git("add", input);
  f.git("commit", "-qm", "delete evidence executable");
  const scope = fsInputScope(f.root, [input], base);
  expect(scope.tests).toEqual([]);
  expect(scope.unmappedExecutableInputs).toEqual([]);
  expect(scope.declaredExecutableInputs).toEqual([
    { path: input, deleted: true, reason: expect.stringContaining("Dated evidence") },
  ]);
});
