import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("retains a newer local commit when an external refresh finishes late in a fresh process", async () => {
  const root = await mkdtemp(join(tmpdir(), "tracker-refresh-"));
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, NODE_ENV: "test", HOME: join(root, "home") };
  for (const kind of ["CONFIG", "STATE", "DATA", "CACHE"])
    env[`XDG_${kind}_HOME`] = join(root, kind.toLowerCase());
  env.XDG_RUNTIME_DIR = join(root, "runtime");
  for (const value of Object.values(env))
    if (value?.startsWith(root)) await mkdir(value, { recursive: true });
  try {
    const { stdout } = await promisify(execFile)(
      fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url)),
      [
        fileURLToPath(
          new URL("../../../docs/testing/2026-10-27-local-vuh-51-refresh/flows/race.ts", import.meta.url),
        ),
        root,
      ],
      { env, timeout: 25_000, maxBuffer: 1024 * 1024 },
    );
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
    expect(result).toEqual({
      externalValidated: true,
      localSnapshotRetained: true,
      spuriousRefusal: null,
      rereads: 0,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
