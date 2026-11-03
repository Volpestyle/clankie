// #444: a heavy command's runner checks its process group with one `ps` census after the
// command exits. One census that ran past its deadline on a loaded Mac ended a `git status`
// that had already succeeded as "Fleet resource native boundary unavailable (run:
// RuntimeError: Process group snapshot unavailable)". The real native helper runs here with
// only `ps` swapped: for a real process that outlasts the deadline, or one that fails.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { resourceNativeHelperPath, resourcePython } from "../src/process.ts";

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** Runs the helper's `group-occupied` census, with `ps` replaced as `census` says. */
async function occupied(census: "first-slow" | "always-failing") {
  const directory = await mkdtemp(join(tmpdir(), "clankie-group-census-"));
  roots.push(directory);
  const wrapper = join(directory, "native.py");
  await writeFile(
    wrapper,
    `import atexit, subprocess, sys, runpy
census = ${JSON.stringify(census)}
real = subprocess.Popen
calls = [0]
class Census(real):
    def __init__(self, args, *rest, **options):
        if list(args[:1]) == ["/bin/ps"]:
            calls[0] += 1
            if census == "always-failing":
                args = ["/usr/bin/false"]
            elif calls[0] == 1:
                args = ["/bin/sleep", "30"]
        super().__init__(args, *rest, **options)
subprocess.Popen = Census
atexit.register(lambda: print("ps censuses: %d" % calls[0], file=sys.stderr))
runpy.run_path(${JSON.stringify(resourceNativeHelperPath())}, run_name="__main__")
`,
  );
  return execute(resourcePython, ["-I", wrapper, "group-occupied", String(process.pid)], {
    timeout: 60_000,
  }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error: { code?: number; stdout?: string; stderr?: string }) => ({
      code: error.code ?? -1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    }),
  );
}

it("answers after one census outlasts its deadline, by taking another (#444)", async () => {
  const result = await occupied("first-slow");
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(expect.any(Boolean));
  expect(result.stderr).toContain("ps censuses: 2");
}, 30_000);

it("still refuses when every census fails, and says how", async () => {
  const result = await occupied("always-failing");
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(
    "Fleet resource native boundary unavailable (group-occupied: RuntimeError: Process group snapshot failed (ps exited 1))",
  );
  expect(result.stderr).toContain("ps censuses: 3");
}, 30_000);
