import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { releaseOnlyTests } from "../../../scripts/testing/landing-test-policy.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const exec = promisify(execFile);

// Real Vitest discovery proves landing exclusions reach both projects without
// changing manual/release selection or accidentally enabling the eval lane.
it("keeps release proofs in manual tests while landing preserves its cheap guards and eval boundary", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "landing-policy-"));
  const controls = [
    "apps/clankie/test/fleet-refresh.integration.test.ts",
    "apps/clankie/test/runtime-canary-policy.integration.test.ts",
    "apps/clankie/test/integrate-remote.integration.test.ts",
  ];
  const excluded = [
    "packages/play/test/free-play-corpus.test.ts",
    "apps/clankie/test/computer-body.integration.test.ts",
    "apps/clankie/test/computer-windows.integration.test.ts",
  ];
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        ![
          "CLANKIE_RELEASE_RETRY_FILE",
          "CLANKIE_RELEASE_TEST_REPORT",
          "CLANKIE_RELEASE_TEST_RUN_ID",
          "CLANKIE_LANDING_GRAPH",
          "CLANKIE_COMPUTER_INTEGRATION",
        ].includes(key),
    ),
  );
  const list = async (landing: boolean) => {
    const output = join(temporary, landing ? "landing.json" : "manual.json");
    await exec(
      process.execPath,
      [
        join(root, "node_modules/vitest/vitest.mjs"),
        "list",
        "--config",
        join(root, "vitest.config.ts"),
        "--filesOnly",
        `--json=${output}`,
        ...releaseOnlyTests,
        ...controls,
        ...excluded,
      ],
      {
        cwd: root,
        env: { ...env, CLANKIE_LANDING_TESTS: landing ? "1" : "" },
        timeout: 8_000,
        maxBuffer: 1024 * 1024,
      },
    );
    const rows = JSON.parse(await readFile(output, "utf8")) as { file: string; projectName: string }[];
    return rows.map((row) => ({ ...row, file: relative(root, row.file).replaceAll("\\", "/") }));
  };
  try {
    const manual = await list(false);
    const landing = await list(true);
    expect(manual.map((row) => row.file).sort()).toEqual([...releaseOnlyTests, ...controls].sort());
    expect(landing.map((row) => row.file).sort()).toEqual([...controls].sort());
    expect(manual.find((row) => row.file.endsWith("/integrate.integration.test.ts"))?.projectName).toBe(
      "serial-integration",
    );
    expect(
      landing.find((row) => row.file.endsWith("/integrate-remote.integration.test.ts"))?.projectName,
    ).toBe("serial-integration");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
