import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, it } from "vitest";
import { processWorkingDirectories } from "../src/process-working-directories.ts";

beforeAll(async () => {
  if (process.platform === "darwin")
    await promisify(execFile)(process.execPath, [
      join(import.meta.dirname, "../../../scripts/build-fleet-proof.mjs"),
    ]);
});

it.runIf(process.platform === "darwin")(
  "fresh cwd censuses protect every owned process, including changed and unusual paths",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "cwd-census-")));
    const original = join(root, 'quoted "line\nπ');
    const next = join(root, "changed");
    await mkdir(original);
    await mkdir(next);
    const children = [original, next].map((cwd) =>
      spawn(
        process.execPath,
        [
          "-e",
          "process.on('message', path => { process.chdir(path); process.send('ready'); }); process.send('ready');",
        ],
        { cwd, stdio: ["ignore", "ignore", "ignore", "ipc"] },
      ),
    );
    try {
      await Promise.all(children.map((child) => once(child, "message")));
      expect(await processWorkingDirectories()).toEqual(expect.arrayContaining([original, next]));
      const changed = once(children[0]!, "message");
      children[0]!.send(next);
      await changed;
      const fresh = await processWorkingDirectories();
      expect(fresh).toContain(next);
      expect(fresh).not.toContain(original);
    } finally {
      await Promise.all(
        children.map(async (child) => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          const stopped = once(child, "exit");
          child.kill();
          await stopped;
        }),
      );
      await rm(root, { recursive: true, force: true });
    }
    expect(await processWorkingDirectories()).not.toContain(next);
  },
);
