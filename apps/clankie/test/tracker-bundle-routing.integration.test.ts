import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("routes opaque bundle/run ids through hired worker MCP in a fresh isolated process", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-routing-"));
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
          new URL(
            "../../../docs/testing/2026-10-27-local-vuh-52-bundle-routing/flows/worker.ts",
            import.meta.url,
          ),
        ),
        root,
      ],
      { env, timeout: 25_000, maxBuffer: 1024 * 1024 },
    );
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
    expect(result).toMatchObject({
      check: { outcome: "ok" },
      appended: { outcome: "ok" },
      unknown: { outcome: "refused", possiblyDispatched: false },
      selfCheck: { outcome: "refused" },
      runControl: { reason: "role_not_allowed" },
      finishRun: { outcome: "ok" },
      hiredProjectCheck: { outcome: "ok" },
      hiredProjectUnknown: { outcome: "refused" },
      checkpointReads: 0,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
