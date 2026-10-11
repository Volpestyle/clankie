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

it("remote stdout and stderr reset the silence deadline without losing the exact gate report", async () => {
  const f = await fixture();
  const original = await readFile(join(f.source, "gate.mjs"), "utf8");
  const change = await f.commit(
    "gate.mjs",
    `if (process.env.HOME.includes('.clankie-fleet')) {
    const pulse = setInterval(() => { console.log('stdout pulse'); console.error('stderr pulse'); }, 200);
    await new Promise(resolve => setTimeout(resolve, 3500)); clearInterval(pulse);
  }\n${original}`,
  );
  const queue = new IntegrationQueue({
    directory: join(f.root, "integration"),
    core: f.source,
    remoteExecutionTimeoutMs: 30_000,
    remoteNoOutputTimeoutMs: 3_000,
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
  const request = IntegrationRunSchema.parse({ action: "run", id: randomUUID(), core: [change] });
  await queue.start(request, guard);
  await queue.wait();
  const batch = await queue.status(request.id);
  expect(batch.state, batch.error).toBe("passed");
  expect(batch.placement).toEqual({ machine: "pc" });
  expect(batch.repos[0]!.gate).toMatchObject({ exitCode: 0, machine: "pc", head: batch.repos[0]!.head });
  const log = await readFile(batch.repos[0]!.gate!.log, "utf8");
  expect(log).toContain("stdout pulse");
  expect(log).toContain("stderr pulse");
  expect(log).toContain("gated-in");
}, 120_000);

it.each(["silent", "chatty", "report"] as const)(
  "a %s remote gate times out, retains its cause, and freshly gates locally",
  async (mode) => {
    const f = await fixture();
    const change = await f.commit("feature", mode);
    let child: ReturnType<typeof spawn> | undefined;
    let closed: Promise<unknown> | undefined;
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const queue = new IntegrationQueue({
      directory: join(f.root, "integration"),
      core: f.source,
      remoteExecutionTimeoutMs: 5_000,
      remotePreparationTimeoutMs: 5_000,
      remoteNoOutputTimeoutMs: mode === "silent" ? 1_000 : 2_000,
      remoteNoOutputAlertMs: 500,
      placeGate: async (batch) =>
        wslGateRunner({
          machine: "pc",
          shell: "posix",
          batch: batch.id,
          origin: batch.origin,
          bundle: gitBundle,
          stream: (command) => {
            const script = command.replaceAll("'\\''", "'");
            const phase = mode === "report" ? "report" : "gate";
            if (!new RegExp(`clankie-gate['"]?\\s+['"]?${phase}['"]?\\s`, "u").test(script))
              return f.stream(command);
            child = spawn(
              process.execPath,
              [
                "-e",
                `process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => { ${mode === "chatty" ? "console.error('still running')" : ""} }, 100)`,
              ],
              { stdio: ["pipe", "pipe", "pipe"] },
            );
            closed = new Promise((resolve) => child!.once("close", resolve));
            child.stdout!.once("data", ready);
            return child;
          },
        }),
    });
    try {
      const request = IntegrationRunSchema.parse({ action: "run", id: randomUUID(), core: [change] });
      await queue.start(request, guard);
      await started;
      await new Promise((resolve) => setTimeout(resolve, 650));
      if (mode !== "report") {
        const observations = await queue.progress();
        expect(observations).toHaveLength(1);
        expect(observations[0]!.stalled).toBe(mode === "silent");
        expect(observations[0]!.message).toContain("pc gate");
      }
      const next = IntegrationRunSchema.parse({ action: "run", id: randomUUID(), core: [change] });
      await queue.start(next, guard);
      await queue.wait();
      const batch = await queue.status(request.id);
      expect(batch.state, batch.error).toBe("passed");
      const cause =
        mode === "report"
          ? "pc gate report timed out after 5000ms"
          : mode === "silent"
            ? "produced no output for 1000ms"
            : "exceeded wall-clock deadline 5000ms";
      expect(batch.placement).toMatchObject({ machine: "local", reason: expect.stringContaining(cause) });
      const remoteLog = join(dirname(batch.evidence), "core-gate-pc.log");
      expect(await readFile(remoteLog, "utf8")).toContain(cause);
      expect(batch.repos[0]!.gate).toMatchObject({ exitCode: 0, head: batch.repos[0]!.head });
      expect(batch.repos[0]!.gate!.machine).toBeUndefined();
      expect(await readFile(batch.repos[0]!.gate!.log, "utf8")).toContain("gated-in");
      expect((await queue.status(next.id)).state).toBe("passed");
      await closed;
      expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
      if (mode !== "chatty") expect(child!.signalCode).toBe("SIGKILL");
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
  },
  120_000,
);

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

it("a bundle stages on the linked machine even when its stdin EOF never arrives", async () => {
  const f = await fixture();
  const change = await f.commit("feature", "framed");
  // Every byte reaches the remote, but the end of input does not: seen through ssh, powershell and wsl.
  const lostEof = (remoteCommand: string) => {
    const child = f.stream(remoteCommand);
    const stdin = child.stdin!;
    stdin.end = ((chunk?: Buffer | string) => {
      if (chunk !== undefined) stdin.write(chunk);
      return stdin;
    }) as typeof stdin.end;
    child.once("close", () => stdin.destroy());
    return child;
  };
  const queue = new IntegrationQueue({
    directory: join(f.root, "integration"),
    core: f.source,
    remotePreparationTimeoutMs: 30_000,
    placeGate: async (batch) =>
      wslGateRunner({
        machine: "pc",
        shell: "posix",
        batch: batch.id,
        origin: batch.origin,
        stream: lostEof,
        bundle: gitBundle,
      }),
  });
  const request = IntegrationRunSchema.parse({ action: "run", id: randomUUID(), core: [change] });
  await queue.start(request, guard);
  await queue.wait();
  const batch = await queue.status(request.id);
  expect(batch.state, batch.error).toBe("passed");
  expect(batch.placement).toEqual({ machine: "pc" });
  expect(batch.repos[0]!.gate).toMatchObject({ exitCode: 0, machine: "pc", head: batch.repos[0]!.head });
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

it.each(["placement", "stage"])(
  "a hung remote %s falls back locally, bounds cleanup and releases the serial queue",
  async (phase) => {
    const f = await fixture();
    const change = await f.commit("feature", "timeout");
    const children: ReturnType<typeof spawn>[] = [];
    const exits: Promise<unknown>[] = [];
    let ready!: () => void;
    const started = new Promise<void>((resolve) => (ready = resolve));
    // An actual transport child which stays connected and even ignores TERM.
    // No remote machine or existing service-owned process is touched.
    const hang = () => {
      const child = spawn(
        process.execPath,
        ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      children.push(child);
      exits.push(new Promise((resolve) => child.once("close", resolve)));
      child.stdout!.once("data", ready);
      return child;
    };
    let placements = 0;
    const queue = new IntegrationQueue({
      directory: join(f.root, "integration"),
      core: f.source,
      remotePreparationTimeoutMs: 5_000,
      remoteCleanupTimeoutMs: 100,
      placeGate: async (batch, signal) => {
        if (++placements > 1) return undefined;
        const runner = wslGateRunner({
          machine: "pc",
          shell: "posix",
          batch: batch.id,
          origin: batch.origin,
          stream: hang,
          bundle: gitBundle,
        });
        if (phase === "placement") {
          // Exercise cancellation while the placement provider is still preparing.
          const base = await git(f.source, "rev-parse", "origin/main");
          await runner.stage({ directory: f.source, base, head: change }, signal);
        }
        return runner;
      },
    });
    try {
      const first = IntegrationRunSchema.parse({ action: "run", id: randomUUID(), core: [change] });
      await queue.start(first, guard);
      await started;
      const next = IntegrationRunSchema.parse({ action: "run", id: randomUUID(), core: [change] });
      await queue.start(next, guard);
      await queue.wait();
      const batch = await queue.status(first.id);
      expect(batch.state, batch.error).toBe("passed");
      expect(batch.placement).toMatchObject({
        machine: "local",
        reason: expect.stringContaining(
          `${phase === "stage" ? "pc stage" : "placement"} timed out after 5000ms`,
        ),
      });
      if (phase === "stage") expect(batch.placement!.reason).toContain("pc cleanup timed out after 100ms");
      expect(batch.repos[0]!.gate).toMatchObject({ exitCode: 0 });
      expect(batch.repos[0]!.gate!.machine).toBeUndefined();
      expect(await readFile(batch.repos[0]!.gate!.log, "utf8")).toContain("gated-in");
      expect((await queue.status(next.id)).state).toBe("passed");
      expect((await queue.snapshot()).running).toEqual([]);
      expect((await queue.snapshot()).waiting).toEqual([]);
      await Promise.all(exits);
      expect(children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(true);
    } finally {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await Promise.all(exits);
    }
  },
  120_000,
);
