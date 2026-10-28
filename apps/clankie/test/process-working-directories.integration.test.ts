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

// /bin/ps is setuid root. An account process listed by the census that then
// execs it becomes root's mid-census; that refused 5-8 of 150 censuses while
// fleet tooling ran ps (VUH-2937). The census now retries such a change.
it.runIf(process.platform === "darwin")(
  "an account process that execs setuid ps mid-census changes the census, never refuses it",
  async () => {
    let spawning = true;
    const loops = Array.from(
      { length: 4 },
      () =>
        new Promise<void>((resolve) => {
          const next = () => {
            if (!spawning) return resolve();
            spawn("/bin/ps", ["-A", "-o", "pid="], { stdio: "ignore" }).on("exit", next);
          };
          next();
        }),
    );
    let censuses = 0;
    try {
      for (; censuses < 150; censuses++) await processWorkingDirectories();
    } finally {
      spawning = false;
      await Promise.all(loops);
    }
    expect(censuses).toBe(150);
  },
  60_000,
);
