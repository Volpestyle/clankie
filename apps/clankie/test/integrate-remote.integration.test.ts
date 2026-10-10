import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { IntegrationRunSchema } from "@clankie/protocol/integrate";
import { IntegrationQueue } from "../src/integrate.ts";
import { gitBundle, wslGateRunner } from "../src/integrate-remote.ts";

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const git = async (directory: string, ...args: string[]) =>
  (await execute("git", ["-c", "core.hooksPath=/dev/null", "-C", directory, ...args])).stdout.trim();
const guard = async () => {};

/**
 * A core repository whose landing gate writes its recorded selection, plus a
 * second home standing in for the linked machine: the runner's real script runs
 * there through a POSIX shell, with its own toolchain directory.
 */
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-remote-gate-")));
  roots.push(root);
  const source = join(root, "clankie");
  const origin = join(root, "clankie.git");
  await mkdir(source);
  await git(root, "init", "--bare", origin);
  await git(source, "init", "-b", "main");
  await git(source, "config", "user.name", "Fixture");
  await git(source, "config", "user.email", "fixture@example.invalid");
  await git(source, "remote", "add", "origin", origin);
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({
      name: "core",
      private: true,
      scripts: { "check:landing": "node gate.mjs" },
      packageManager: "pnpm@11.11.0",
    }),
  );
  await writeFile(join(source, ".gitignore"), "node_modules/\n.local/\n");
  await writeFile(
    join(source, "gate.mjs"),
    `import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('.local', { recursive: true });
// The linked machine stands in for Linux: there the darwin-only file's cases skip.
const linked = process.env.HOME.includes('.clankie-fleet');
const skipped = linked && existsSync('darwin-only.test.ts') ? ['darwin-only.test.ts'] : [];
writeFileSync('.local/landing-gate.json', JSON.stringify({ base: process.env.CLANKIE_LANDING_BASE, cwd: process.cwd(), tests: { platform: linked ? 'linux' : process.platform, skipped } }));
console.log('gated-in', process.env.HOME);
`,
  );
  await execute("pnpm", ["install", "--lockfile-only"], { cwd: source });
  await git(source, "add", ".");
  await git(source, "commit", "-m", "base");
  await git(source, "push", "origin", "HEAD:main");
  // The linked machine: its home, and the fleet toolchain the script expects.
  const machine = join(root, "linked-home");
  const toolchain = join(machine, ".clankie-fleet", "toolchain", "node-v26.7.0-linux-x64", "bin");
  await mkdir(toolchain, { recursive: true });
  for (const tool of ["node", "pnpm"]) {
    const real = (await execute("sh", ["-c", `command -v ${tool}`])).stdout.trim();
    await writeFile(join(toolchain, tool), `#!/bin/sh\nexec '${real}' "$@"\n`, { mode: 0o755 });
  }
  const stream = (remoteCommand: string) =>
    spawn("sh", ["-c", remoteCommand], {
      env: { PATH: process.env.PATH, HOME: machine },
      stdio: ["pipe", "pipe", "pipe"],
    });
  const commit = async (file: string, value: string) => {
    await writeFile(join(source, file), value);
    await git(source, "add", file);
    await git(source, "commit", "-m", file);
    return git(source, "rev-parse", "HEAD");
  };
  return { root, source, origin, machine, stream, commit };
}

it("a core batch gates on the linked machine at its exact HEAD, recorded as a local gate is, and lands from here", async () => {
  const f = await fixture();
  const change = await f.commit("feature", "remote");
  const placed: string[] = [];
  const queue = new IntegrationQueue({
    directory: join(f.root, "integration"),
    core: f.source,
    placeGate: async (batch) => {
      placed.push(batch.id);
      return wslGateRunner({
        machine: "pc",
        shell: "posix",
        batch: batch.id,
        origin: batch.origin,
        stream: f.stream,
        bundle: gitBundle,
      });
    },
  });
  const request = IntegrationRunSchema.parse({ action: "run", id: randomUUID(), core: [change] });
  await queue.start(request, guard);
  await queue.wait();
  const batch = await queue.status(request.id);
  const repo = batch.repos[0]!;
  expect(placed).toEqual([batch.batchId ?? batch.id]);
  expect(batch.state, batch.error).toBe("passed");
  expect(batch.placement).toEqual({ machine: "pc" });
  expect(repo.install, await readFile(repo.install!.log, "utf8")).toMatchObject({
    exitCode: 0,
    machine: "pc",
  });
  expect(repo.gate).toMatchObject({ exitCode: 0, machine: "pc", head: repo.head });
  // The gate ran in the linked machine's fleet workspace, and its log and selection came home.
  const log = await readFile(repo.gate!.log, "utf8");
  expect(log).toContain(`gated-in ${join(f.machine, ".clankie-fleet", "batches")}`);
  const report = JSON.parse(await readFile(join(repo.directory, ".local", "landing-gate.json"), "utf8")) as {
    base: string;
    cwd: string;
  };
  expect(report.base).toBe(repo.base);
  expect(report.cwd.startsWith(join(f.machine, ".clankie-fleet"))).toBe(true);
  // Its workspace there is gone once the gate is recorded.
  expect(existsSync(dirname(report.cwd))).toBe(false);
  const landed = await queue.land(request.id, guard);
  expect(landed.state).toBe("pushed");
  expect(await git(f.source, "ls-remote", "origin", "refs/heads/main")).toContain(repo.head);
}, 120_000);

it("a linked machine that cannot take the batch leaves the gate here, with the reason recorded", async () => {
  const f = await fixture();
  const change = await f.commit("feature", "local");
  const queue = new IntegrationQueue({
    directory: join(f.root, "integration"),
    core: f.source,
    placeGate: async (batch) =>
      wslGateRunner({
        machine: "pc",
        shell: "posix",
        batch: batch.id,
        origin: "https://example.invalid/private.git",
        stream: f.stream,
        bundle: gitBundle,
      }),
  });
  const request = IntegrationRunSchema.parse({ action: "run", id: randomUUID(), core: [change] });
  await queue.start(request, guard);
  await queue.wait();
  const batch = await queue.status(request.id);
  expect(batch.state).toBe("passed");
  expect(batch.placement).toMatchObject({
    machine: "local",
    reason: expect.stringContaining("GitHub origin"),
  });
  expect(batch.repos[0]!.gate).toMatchObject({ exitCode: 0 });
  expect(batch.repos[0]!.gate!.machine).toBeUndefined();
}, 120_000);

it("a linked machine's green that skipped darwin-only tests gates again here, keeping its log", async () => {
  const f = await fixture();
  const macOnly = await f.commit(
    "darwin-only.test.ts",
    'it.skipIf(process.platform !== "darwin")("mac only", () => {});\n',
  );
  const queue = new IntegrationQueue({
    directory: join(f.root, "integration"),
    core: f.source,
    placeGate: async (batch) =>
      wslGateRunner({
        machine: "pc",
        shell: "posix",
        batch: batch.id,
        origin: batch.origin,
        stream: f.stream,
        bundle: gitBundle,
      }),
  });
  const request = IntegrationRunSchema.parse({
    action: "run",
    id: randomUUID(),
    core: [macOnly, await f.commit("feature", "mac")],
  });
  await queue.start(request, guard);
  await queue.wait();
  const batch = await queue.status(request.id);
  expect(batch.state, batch.error).toBe("passed");
  expect(batch.placement).toMatchObject({
    machine: "local",
    reason: expect.stringContaining("pc skipped darwin-only tests in darwin-only.test.ts"),
  });
  const repo = batch.repos[0]!;
  expect(repo.gate).toMatchObject({ exitCode: 0 });
  expect(repo.gate!.machine).toBeUndefined();
  expect(await readFile(repo.gate!.log, "utf8")).not.toContain(".clankie-fleet");
  expect(await readFile(join(dirname(batch.evidence), "core-gate-pc.log"), "utf8")).toContain(
    ".clankie-fleet",
  );
}, 120_000);
