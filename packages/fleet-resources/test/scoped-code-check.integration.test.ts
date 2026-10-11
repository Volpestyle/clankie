// Actual repo formatter/linter → governed native runners → independent lanes.
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { createResourceGovernor } from "../src/governor.ts";
import { defaultResourcePolicy } from "../src/model.ts";
import { heavyJobArgs, heavyJobLane } from "../src/parallelism.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean) {
  const end = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error("Scoped check governor boundary timed out");
    await delay(50);
  }
}

it("real file format and lint finish while a full permit is held and its follower stays queued", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-scoped-check-"));
  const release = join(root, "release");
  const started = join(root, "gate-started");
  const source = join(root, "answer.ts");
  const untouched = join(root, "untouched.ts");
  const governor = createResourceGovernor({ directory: join(root, "registry") });
  const stopFollower = new AbortController();
  const jobs: Promise<number>[] = [];
  try {
    await governor.configure({ ...defaultResourcePolicy(), heavySlots: 1, maxLoadRatio: 16 });
    await writeFile(source, "export const answer={value:42}\n");
    await writeFile(untouched, "export const untouched={value:0}\n");
    const gate = governor.runHeavy(
      process.execPath,
      [
        "-e",
        `
      const fs = require('node:fs'); fs.writeFileSync(process.argv[1], '');
      const timer = setInterval(() => { if (fs.existsSync(process.argv[2])) clearInterval(timer); }, 20);
    `,
        started,
        release,
      ],
      { holderId: "scoped-check-held-full" },
    );
    jobs.push(gate);
    await until(
      () =>
        access(started).then(
          () => true,
          () => false,
        ),
      Boolean,
    );
    const follower = governor.runHeavy(process.execPath, ["-e", "process.exit(99)"], {
      holderId: "scoped-check-queued-full",
      signal: stopFollower.signal,
    });
    jobs.push(follower);
    await until(
      () => governor.snapshot(),
      (status) => status.queue.length === 1,
    );
    const observations: {
      command: string;
      elapsedMs: number;
      fullHeld: number;
      fullQueued: number;
      loadRatio: number;
      availableMemoryMb: number;
    }[] = [];
    // Real binary and actual root script forms. Formatting the selected file
    // must not silently traverse '.' or the unselected unformatted sibling.
    for (const args of [
      ["exec", "oxfmt", "--write", "--threads=18", source],
      ["fmt", "--", source],
      ["run", "fmt:check", source],
      ["exec", "oxlint", "--deny-warnings", "--threads", "18", source],
      ["lint", source],
    ]) {
      expect(heavyJobLane("pnpm", args)).toBe("light");
      const at = performance.now();
      expect(await governor.runHeavy("pnpm", args)).toBe(0);
      const status = await governor.snapshot();
      expect(status.capacity).toMatchObject({ used: 1, lightUsed: 0 });
      expect(status.queue.map((entry) => entry.holderId)).toEqual(["scoped-check-queued-full"]);
      observations.push({
        command: args.slice(0, -1).join(" "),
        elapsedMs: performance.now() - at,
        fullHeld: status.capacity.used,
        fullQueued: status.queue.length,
        loadRatio: status.pressure.loadRatio,
        availableMemoryMb: status.pressure.availableMemoryMb,
      });
    }
    expect(await readFile(source, "utf8")).toBe("export const answer = { value: 42 };\n");
    expect(await readFile(untouched, "utf8")).toBe("export const untouched={value:0}\n");
    process.stdout.write(`Scoped code check proof: ${JSON.stringify(observations)}\n`);
    stopFollower.abort();
    expect(await follower).toBe(130);
    await writeFile(release, "");
    expect(await gate).toBe(0);
  } finally {
    stopFollower.abort();
    await writeFile(release, "");
    await governor.close();
    await Promise.allSettled(jobs);
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

it("whole-repo, directory, glob, type-aware and ambiguous invocations keep the full lane", async () => {
  const file = join(repo, "packages/fleet-resources/src/parallelism.ts");
  for (const [command, ...args] of [
    ["oxfmt", "--check"],
    ["oxfmt", "."],
    ["oxfmt", "packages/fleet-resources/src"],
    ["oxfmt", "packages/fleet-resources/src/*.ts"],
    ["oxlint", "--type-aware", file],
    ["oxlint", "--type-check", file],
    ["oxfmt", "--config", file],
    ["oxfmt", "--unknown-flag", file],
    ["pnpm", "fmt"],
    ["pnpm", "fmt:check"],
    ["pnpm", "lint"],
    ["pnpm", "fmt", "."],
    ["pnpm", "lint", "packages"],
    ["pnpm", "--filter", "@clankie/vox", "fmt", file],
    ["sh", "-c", `oxfmt ${file}`],
    ["oxfmt", ...Array.from({ length: 65 }, () => file)],
  ])
    expect(heavyJobLane(command!, args)).toBe("full");
  for (const [command, ...args] of [
    ["oxfmt", "--config", join(repo, "package.json"), "--check", file],
    ["oxlint", "-D", "correctness", "--deny-warnings", file],
    ["pnpm", "exec", "oxfmt", "--check", file],
    ["pnpm", "oxlint", file],
    ["pnpm", "fmt", "--", file],
    ["pnpm", "run", "fmt:check", file],
  ])
    expect(heavyJobLane(command!, args)).toBe("light");
  expect(heavyJobArgs("oxfmt", ["--threads=18", file], 2)).toEqual([file, "--threads=2"]);
  expect(heavyJobArgs("oxlint", ["--threads", "1", file], 2)).toEqual([file, "--threads=1"]);
  expect(heavyJobArgs("pnpm", ["fmt", "--", file], 2)).toEqual(["fmt", "--threads=2", "--", file]);
});
