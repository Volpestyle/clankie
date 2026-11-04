import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
const builder = new URL("../../../scripts/build-fleet-proof.mjs", import.meta.url).href;
const build = (destination: string, env: NodeJS.ProcessEnv = process.env) =>
  exec(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {buildFleetProof} from ${JSON.stringify(builder)};
    import {execFileSync} from 'node:child_process';
    const path=await buildFleetProof(process.argv[1]);
    const proof=JSON.parse(execFileSync(path,['--birth',String(process.pid)],{encoding:'utf8'}));
    console.log(JSON.stringify({path,pid:process.pid,uid:process.getuid(),proof}));
  `,
      destination,
    ],
    { env, timeout: 20_000 },
  );

it.runIf(process.platform === "darwin")(
  "builds and proves a real native helper without entering a blocked PATH cc shim, then reuses the artifact",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "proof-build-shim-"));
    try {
      const bin = join(root, "bin"),
        marker = join(root, "shim-called"),
        destination = join(root, "helper");
      await mkdir(bin);
      const shim = join(bin, "cc");
      // A bounded stand-in for the silent xcrun shim stall recorded in #815/#819.
      // The real selected toolchain still compiles the production C source.
      await writeFile(
        shim,
        `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(process.env.CLANKIE_TEST_SHIM_MARKER,'called');\nsetTimeout(()=>process.exit(86),250);\n`,
      );
      await chmod(shim, 0o700);
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLANKIE_TEST_SHIM_MARKER: marker };
      const first = JSON.parse((await build(destination, env)).stdout);
      expect(first.proof.process).toMatchObject({ pid: first.pid, uid: first.uid });
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
      const before = await stat(destination);
      const metadata = await readFile(`${destination}.json`, "utf8");
      await build(destination, env);
      expect((await stat(destination)).mtimeMs).toBe(before.mtimeMs);
      expect(await readFile(`${destination}.json`, "utf8")).toBe(metadata);
      expect(await readdir(root)).not.toContain("shim-called");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

it.runIf(process.platform === "darwin")(
  "names a broken selected developer toolchain without replacing the published helper or leaving staging files",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "proof-build-invalid-"));
    try {
      const destination = join(root, "helper");
      await writeFile(destination, "previous published helper");
      const developer = join(root, "missing-developer-directory");
      const result = await build(destination, { ...process.env, DEVELOPER_DIR: developer }).catch(
        (error: unknown) => error,
      );
      expect(result).toBeInstanceOf(Error);
      expect(String(result)).toContain("Native fleet proof toolchain discovery failed");
      expect(String(result)).toContain("xcode-select");
      expect(await readFile(destination, "utf8")).toBe("previous published helper");
      expect(await readdir(root)).toEqual(["helper"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
