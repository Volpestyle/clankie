import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compiler = fileURLToPath(import.meta.resolve("typescript/bin/tsc"));
const maximumOldSpaceMiB = 2512;
const semiSpaceMiB = 16;
const testRootsPerProgram = 48;

async function main() {
  const args = process.argv.slice(2);
  const config = resolve(args.shift() ?? "tsconfig.json");
  let oldSpaceMiB = maximumOldSpaceMiB;
  let verbose = false;
  for (const arg of args) {
    if (arg === "--extendedDiagnostics") verbose = true;
    else if (/^--heap-mb=\d+$/u.test(arg)) oldSpaceMiB = Number(arg.slice(10));
    else throw new Error(`Unknown typecheck argument: ${arg}`);
  }
  if (oldSpaceMiB < 16 || oldSpaceMiB > maximumOldSpaceMiB)
    throw new Error(`--heap-mb must be between 16 and ${maximumOldSpaceMiB}; the budget cannot be raised`);
  const heapLimitMiB = oldSpaceMiB + 3 * semiSpaceMiB;
  const parsed = ts.getParsedCommandLineOfConfigFile(
    config,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (error) => {
        throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
      },
    },
  );
  if (!parsed || parsed.errors.length) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(parsed?.errors ?? [], {
        getCurrentDirectory: ts.sys.getCurrentDirectory,
        getCanonicalFileName: (file) => file,
        getNewLine: () => "\n",
      }),
    );
  }
  const files = [...parsed.fileNames].sort();
  const types = parsed.options.types?.map((name) => {
    const resolved = ts.resolveTypeReferenceDirective(
      name,
      join(dirname(config), "__inferred type names__.ts"),
      parsed.options,
      ts.sys,
    ).resolvedTypeReferenceDirective;
    if (!resolved) throw new Error(`Cannot resolve type definition '${name}' from ${config}`);
    return resolved.resolvedFileName;
  });
  const tests = files.filter((file) => /[/\\](?:test|tests)[/\\]/u.test(file));
  let programs = [{ name: "project", files }];
  if (tests.length > testRootsPerProgram) {
    // Globals and augmentations belong to the whole original project. Carry them
    // into every program, so splitting roots cannot hide a conflicting declaration.
    const shared = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (
        /\.d\.[cm]?ts$/u.test(file) ||
        /\bdeclare\s+(?:global|module)\b/u.test(source) ||
        !ts.isExternalModule(ts.createSourceFile(file, source, ts.ScriptTarget.Latest))
      )
        shared.push(file);
    }
    const testSet = new Set(tests);
    const merge = (roots) => [...new Set([...roots, ...shared])];
    programs = [{ name: "source", files: merge(files.filter((file) => !testSet.has(file))) }];
    for (let offset = 0; offset < tests.length; offset += testRootsPerProgram) {
      programs.push({
        name: `tests-${1 + offset / testRootsPerProgram}`,
        files: merge(tests.slice(offset, offset + testRootsPerProgram)),
      });
    }
  }

  const project = relative(root, dirname(config)).replaceAll("\\", "/");
  const reportDirectory = join(root, ".local", "typechecks");
  await mkdir(reportDirectory, { recursive: true });
  const directory = await mkdtemp(join(reportDirectory, "run-"));
  const report = {
    project,
    config,
    oldSpaceMiB,
    semiSpaceMiB,
    heapLimitMiB,
    rootFiles: files.length,
    programs: [],
  };
  const started = performance.now();
  for (const program of programs) {
    const programConfig = join(directory, `${program.name}.json`);
    await writeFile(
      programConfig,
      JSON.stringify(
        {
          extends: config,
          files: program.files,
          include: [],
          // Moving the leaf config must not move Node's implicit @types search roots.
          compilerOptions: {
            // The empty run directory permits absolute explicit type directives
            // even when none of the original implicit @types directories exist.
            typeRoots: [
              ...(types?.length ? [directory] : []),
              ...(ts.getEffectiveTypeRoots(parsed.options, ts.sys) ?? []),
            ],
            types,
          },
          ...(parsed.projectReferences
            ? { references: parsed.projectReferences.map(({ path }) => ({ path })) }
            : {}),
        },
        null,
        2,
      ),
    );
    console.log(
      `[typecheck] ${project} ${program.name}: ${program.files.length} roots, ${oldSpaceMiB} MiB old-space / ${heapLimitMiB} MiB V8 heap ceiling`,
    );
    const programStarted = performance.now();
    const child = spawn(
      process.execPath,
      [
        `--max-old-space-size=${oldSpaceMiB}`,
        `--max-semi-space-size=${semiSpaceMiB}`,
        compiler,
        "--noEmit",
        "--extendedDiagnostics",
        "-p",
        programConfig,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const interrupt = (signal) => child.kill(signal);
    const onInterrupt = () => interrupt("SIGINT");
    const onTerminate = () => interrupt("SIGTERM");
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
    });
    const result = await new Promise((accept, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => accept({ code, signal }));
    });
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    await writeFile(join(directory, `${program.name}.log`), output);
    const memoryKiB = Number(output.match(/^Memory used:\s+(\d+)K/mu)?.[1]) || null;
    const measuredMiB = memoryKiB === null ? null : memoryKiB / 1024;
    const budgetFailed =
      /heap out of memory|allocation failed.*heap/iu.test(output) ||
      (measuredMiB !== null && measuredMiB > heapLimitMiB);
    const passed = result.code === 0 && measuredMiB !== null && !budgetFailed;
    report.programs.push({
      name: program.name,
      roots: program.files,
      ...result,
      memoryKiB,
      types: Number(output.match(/^Types:\s+(\d+)/mu)?.[1]) || null,
      instantiations: Number(output.match(/^Instantiations:\s+(\d+)/mu)?.[1]) || null,
      wallSeconds: (performance.now() - programStarted) / 1000,
      passed,
      budgetFailed,
    });
    if (verbose || !passed) process.stdout.write(output);
    if (!passed) {
      console.error(
        `[typecheck] ${project} ${program.name} FAILED${budgetFailed ? ": heap budget exceeded" : ""}; ceiling ${heapLimitMiB} MiB (${oldSpaceMiB} MiB old-space). Evidence: ${directory}`,
      );
      if (budgetFailed)
        console.error(
          "Split the oversized group or reduce its imported graph; do not raise the heap ceiling.",
        );
      process.exitCode = 1;
      break;
    }
    console.log(`[typecheck] ${project} ${program.name} passed; compiler heap ${measuredMiB.toFixed(1)} MiB`);
  }
  report.wallSeconds = (performance.now() - started) / 1000;
  report.passed =
    report.programs.length === programs.length && report.programs.every((program) => program.passed);
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(`[typecheck] ${project}: ${report.wallSeconds.toFixed(2)}s; evidence ${directory}/report.json`);
}

main().catch((error) => {
  console.error(`[typecheck] ${error.message}`);
  process.exitCode = 1;
});
