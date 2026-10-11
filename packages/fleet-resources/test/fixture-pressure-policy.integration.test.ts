import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const repo = resolve(import.meta.dirname, "../../..");
const guard = join(repo, "scripts/check-fleet-test-pressure.mjs");
const suite = "packages/fleet-resources/test";

async function check(change?: { path: string; edit: (source: string) => string }) {
  const root = await mkdtemp(join(tmpdir(), "fleet-pressure-policy-"));
  try {
    await cp(join(repo, suite), join(root, suite), { recursive: true });
    if (change) {
      const path = join(root, suite, change.path);
      const original = await readFile(path, "utf8");
      const edited = change.edit(original);
      expect(edited).not.toBe(original);
      await writeFile(path, edited);
    }
    return await execute(process.execPath, [guard, root]).then(
      ({ stdout }) => ({ code: 0, output: stdout }),
      (error) => ({ code: error.code, output: error.stderr }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("fleet pressure policy", () => {
  it("accepts the real admission fixtures, inline children and native-observer exception", async () => {
    const result = await check();
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("governor constructions");
  });

  it("rejects the full-progress regression even on a memory-rich idle host", async () => {
    const result = await check({
      path: "full-progress.integration.test.ts",
      edit: (source) => source.replaceAll("{ directory, probe }", "{ directory }"),
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("full-progress.integration.test.ts");
    expect(result.output).toContain("explicit controlled pressure probe");
  });

  it("rejects a missing probe when the governor factory is locally aliased", async () => {
    const result = await check({
      path: "full-progress.integration.test.ts",
      edit: (source) =>
        source.replace(
          "const governor = createResourceGovernor({ directory, probe });",
          "const buildGovernor = createResourceGovernor; const governor = buildGovernor({ directory });",
        ),
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("explicit controlled pressure probe");
  });

  it.each(["freemem", "loadavg"])(
    "rejects an injected probe backed by ambient %s through a local alias",
    async (name) => {
      const result = await check({
        path: "full-progress.integration.test.ts",
        edit: (source) =>
          "import { " +
          name +
          ' as hostRead } from "node:os";\n' +
          source.replace(
            "const probe = async () => ({ loadRatio: 2.25, cpuRatio: 0.9, availableMemoryMb });",
            "const observation = hostRead(); const probe = async () => ({ loadRatio: 2.25, availableMemoryMb: observation });",
          ),
      });
      expect(result.code).toBe(1);
      expect(result.output).toContain("admission probe reads ambient host memory/load");
    },
  );

  it("rejects a subprocess driver that falls back to native pressure", async () => {
    const result = await check({
      path: "fixtures/heavy-driver.mjs",
      edit: (source) =>
        source.replace("probe: async () => ({ loadRatio: 0, availableMemoryMb: 1_000_000 }),", ""),
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("fixtures/heavy-driver.mjs");
  });

  it("rejects an inline child whose probe silently becomes undefined", async () => {
    const result = await check({
      path: "probe-failure.integration.test.ts",
      edit: (source) =>
        source.replace("probe:async()=>({loadRatio:0,availableMemoryMb:65536})", "probe:undefined"),
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("inline child");
    expect(result.output).toContain("explicit controlled pressure probe");
  });
});
