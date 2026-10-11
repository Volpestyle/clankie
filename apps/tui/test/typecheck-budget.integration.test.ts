import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const runner = resolve(import.meta.dirname, "../../../scripts/typecheck.mjs");

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "clankie-typecheck-"));
  await mkdir(join(directory, "src"));
  await mkdir(join(directory, "test"));
  await mkdir(join(directory, "node_modules/local-globals"), { recursive: true });
  await writeFile(join(directory, "node_modules/local-globals/package.json"), '{"types":"globals.d.ts"}');
  await writeFile(
    join(directory, "node_modules/local-globals/globals.d.ts"),
    "declare const vuh2058TypeMarker: number;",
  );
  await writeFile(join(directory, "package.json"), '{"type":"module"}');
  await writeFile(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ES2023",
        module: "NodeNext",
        types: ["local-globals"],
      },
      include: ["src/**/*.ts", "test/**/*.ts"],
    }),
  );
  await writeFile(join(directory, "src/value.ts"), "export const value: number = vuh2058TypeMarker;");
  for (let index = 0; index < 129; index++) {
    await writeFile(
      join(directory, `test/${String(index).padStart(3, "0")}.ts`),
      'import { value } from "../src/value.js"; export const checked: number = value;',
    );
  }
  return directory;
}

async function check(directory: string, args: string[] = []) {
  let stdout = "";
  let stderr = "";
  let code = 0;
  try {
    ({ stdout, stderr } = await execute(
      process.execPath,
      [runner, join(directory, "tsconfig.json"), ...args],
      {
        env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=5120" },
        maxBuffer: 16 * 1024 * 1024,
      },
    ));
  } catch (error) {
    const failed = error as { stdout: string; stderr: string; code: number };
    ({ stdout, stderr, code } = failed);
  }
  const reportFile = stdout.match(/evidence (.+\/report\.json)/u)?.[1];
  const report = reportFile ? JSON.parse(await readFile(reportFile, "utf8")) : undefined;
  if (reportFile) await rm(resolve(reportFile, ".."), { recursive: true, force: true });
  return { stdout, stderr, code, report };
}

it("checks every original root and its real imports across bounded compiler programs", async () => {
  const directory = await fixture();
  try {
    const good = await check(directory);
    expect(good.code, good.stderr).toBe(0);
    expect(good.report).toMatchObject({
      passed: true,
      rootFiles: 130,
      oldSpaceMiB: 2512,
      heapLimitMiB: 2560,
    });
    expect(good.report.programs.map((program: { name: string }) => program.name)).toEqual([
      "source",
      "tests-1",
      "tests-2",
      "tests-3",
    ]);
    const roots = new Set(good.report.programs.flatMap((program: { roots: string[] }) => program.roots));
    expect(roots.size).toBe(130);
    // The last root is outside the first test program. Its import must still be checked.
    await writeFile(
      join(directory, "test/128.ts"),
      'import { value } from "../src/value.js"; export const checked: string = value;',
    );
    const bad = await check(directory);
    expect(bad.code).not.toBe(0);
    expect(bad.stdout).toContain("test/128.ts");
    expect(bad.stdout).toContain("TS2322");
    expect(bad.report.programs.at(-1)).toMatchObject({ name: "tests-3", passed: false });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);

it("preserves the original project's globals across different test groups", async () => {
  const directory = await fixture();
  try {
    await writeFile(
      join(directory, "test/000.ts"),
      "export {}; declare global { interface Vuh2058 { value: number; } }",
    );
    await writeFile(
      join(directory, "test/128.ts"),
      "export {}; declare global { interface Vuh2058 { value: string; } }",
    );
    const bad = await check(directory);
    expect(bad.code).not.toBe(0);
    expect(bad.stdout).toContain("TS2717");
    expect(bad.report.passed).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);

it("fails visibly at a lower heap budget and refuses to raise the central ceiling", async () => {
  const directory = await fixture();
  try {
    const tooSmall = await check(directory, ["--heap-mb=16"]);
    expect(tooSmall.code).not.toBe(0);
    expect(tooSmall.stderr).toContain("heap budget exceeded");
    expect(tooSmall.stderr).toContain("Split the oversized group");
    expect(tooSmall.report).toMatchObject({ passed: false, oldSpaceMiB: 16, heapLimitMiB: 64 });
    expect(tooSmall.report.programs[0].budgetFailed).toBe(true);
    const raised = await check(directory, ["--heap-mb=5120"]);
    expect(raised.code).not.toBe(0);
    expect(raised.stderr).toContain("the budget cannot be raised");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);
