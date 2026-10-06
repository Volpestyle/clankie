import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { IntegrationRunSchema } from "@clankie/protocol/integrate";
import { DeployHolds } from "../src/deploy-holds.ts";
import { IntegrationQueue, integrationSources } from "../src/integrate.ts";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createRuntimeUpdater } from "../../tui/bin/runtime-updater.ts";
import { deployHoldPresence } from "../src/deploy-hold-presence.ts";
import { runIntegrationCommand } from "../../tui/src/command/integrate.ts";

const execute = promisify(execFile);
const roots: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) close();
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function git(directory: string, ...args: string[]): Promise<string> {
  return (await execute("git", ["-c", "core.hooksPath=/dev/null", "-C", directory, ...args])).stdout.trim();
}
async function fixture(gateExtra = "", withApp = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-integrate-")));
  roots.push(root);
  async function repo(name: string) {
    const source = join(root, name === "core" ? "clankie" : "clankie-app");
    const origin = join(root, `${name}.git`);
    await mkdir(source);
    await git(root, "init", "--bare", origin);
    await git(source, "init", "-b", "main");
    await git(source, "config", "user.name", "Fixture");
    await git(source, "config", "user.email", "fixture@example.invalid");
    await git(source, "remote", "add", "origin", origin);
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({
        name,
        private: true,
        scripts: { check: "node gate.mjs" },
        packageManager: "pnpm@11.11.0",
      }),
    );
    await writeFile(join(source, ".gitignore"), "node_modules/\n");
    await writeFile(
      join(source, "gate.mjs"),
      `
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
assert.match(homedir(), /isolation[\\/](core|app)[\\/]home$/);
assert.equal(process.env.CLANKIE_CONTROL_PLANE_URL, 'http://127.0.0.1:1');
assert.equal(process.env.CLANKIE_OPERATOR_TOKEN, undefined);
assert.equal(process.env.DISCORD_BOT_TOKEN, undefined);
assert.equal(process.env.NODE_OPTIONS, undefined);
assert.equal(process.env.CLANKIE_KEYCHAIN_TESTS, undefined);
assert.ok(process.env.CLANKIE_CREDENTIALS_FILE.startsWith(homedir()));
assert.ok(process.env.npm_config_store_dir.includes('isolation'));
const descriptor = join(process.env.CLANKIE_STATE, 'links', 'default-local.json');
assert.equal(existsSync(descriptor), false);
mkdirSync(dirname(descriptor), { recursive: true });
writeFileSync(descriptor, 'private-fixture');
mkdirSync(dirname(process.env.CLANKIE_CREDENTIALS_FILE), { recursive: true });
writeFileSync(process.env.CLANKIE_CREDENTIALS_FILE, '{}');
console.log('fixture-gate-isolated', process.cwd());
${name === "core" ? gateExtra : ""}
`,
    );
    await execute("pnpm", ["install", "--lockfile-only"], { cwd: source });
    await git(source, "add", ".");
    await git(source, "commit", "-m", "base");
    await git(source, "push", "origin", "HEAD:main"); // Local bare fixture only.
    return { source, origin, base: await git(source, "rev-parse", "HEAD") };
  }
  const core = await repo("core");
  const app = withApp ? await repo("app") : undefined;
  const directory = join(root, "integration");
  const holds = new DeployHolds(directory);
  const queue = new IntegrationQueue({
    directory,
    core: core.source,
    ...(app ? { app: app.source } : {}),
    holds,
  });
  return { root, core, app, directory, holds, queue };
}
async function commit(source: string, file: string, value: string) {
  await writeFile(join(source, file), value);
  await git(source, "add", file);
  await git(source, "commit", "-m", file);
  return git(source, "rev-parse", "HEAD");
}
const guard = async () => {};

it("composes in order on fresh origin, installs real siblings, gates privately and durably reloads exact HEAD", async () => {
  const f = await fixture("assert.ok(existsSync('../clankie-app/package.json'));", true);
  const runtime = join(f.root, "nested-runtime");
  await git(f.core.source, "worktree", "add", "--detach", runtime, "HEAD");
  expect(await integrationSources(runtime)).toEqual({ core: f.core.source, app: f.app!.source });
  const a = await commit(f.core.source, "first", "one");
  const b = await commit(f.core.source, "second", "two");
  const appCommit = await commit(f.app!.source, "feature", "app");
  // Advance origin independently of the builder to establish a fresh-origin composition.
  await git(f.core.source, "checkout", "-b", "remote", f.core.base);
  const current = await commit(f.core.source, "remote", "latest");
  await git(f.core.source, "push", "origin", "HEAD:main");
  await git(f.core.source, "checkout", "main");
  const request = IntegrationRunSchema.parse({
    action: "run",
    id: randomUUID(),
    core: [a, b],
    app: [appCommit],
  });
  const inherited = ["CLANKIE_OPERATOR_TOKEN", "DISCORD_BOT_TOKEN", "NODE_OPTIONS", "CLANKIE_KEYCHAIN_TESTS"];
  const previous = inherited.map((key) => process.env[key]);
  try {
    for (const key of inherited) process.env[key] = "synthetic-parent-secret";
    await f.queue.start(request, guard);
    await f.queue.wait();
  } finally {
    for (const [index, key] of inherited.entries()) {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    }
  }
  const batch = await new IntegrationQueue(f.queue.options).status(request.id);
  expect(batch.state).toBe("passed");
  expect(batch.repos).toHaveLength(2);
  expect(batch.repos[0]!.base).toBe(current);
  for (const repo of batch.repos) {
    expect(repo.commits.map((c) => c.state)).toEqual(
      repo.name === "core" ? ["applied", "applied"] : ["applied"],
    );
    expect(repo.install?.exitCode).toBe(0);
    expect(repo.gate?.exitCode).toBe(0);
    expect(repo.gate?.head).toBe(repo.head);
    expect(await readFile(repo.gate!.log, "utf8")).toContain("fixture-gate-isolated");
    const common = await git(repo.directory, "rev-parse", "--git-common-dir");
    expect(common).toContain("repositories");
    expect(await git(repo.source, "rev-parse", "HEAD")).toBe(repo.name === "core" ? b : appCommit);
    expect(await git(repo.source, "ls-remote", "origin", "refs/heads/main")).toContain(repo.base);
  }
  expect(await readFile(join(batch.repos[0]!.directory, "first"), "utf8")).toBe("one");
  expect(await f.queue.start(request, guard)).toMatchObject({ id: request.id, state: "passed" });
  const landed = await f.queue.land(request.id, [], guard);
  expect(landed.state).toBe("pushed");
  expect(landed.repos[0]!.ownerCheckoutSync).toMatchObject({
    outcome: "blocked",
    reason: expect.stringContaining("local commits"),
  });
  for (const repo of batch.repos)
    expect(await git(repo.source, "ls-remote", "origin", "refs/heads/main")).toContain(repo.head);
});

it("attributes a conflict to its input commit and blocks subsequent commits without touching source", async () => {
  const f = await fixture();
  const approved = await commit(f.core.source, "file", "approved");
  const later = await commit(f.core.source, "later", "later");
  await git(f.core.source, "checkout", "-b", "remote", f.core.base);
  const remote = await commit(f.core.source, "file", "remote");
  await git(f.core.source, "push", "origin", "HEAD:main");
  await git(f.core.source, "checkout", "main");
  const request = IntegrationRunSchema.parse({ action: "run", id: randomUUID(), core: [approved, later] });
  await f.queue.start(request, guard);
  await f.queue.wait();
  const batch = await f.queue.status(request.id);
  expect(batch.state).toBe("conflict");
  expect(batch.repos[0]!.commits).toMatchObject([
    { commit: approved, state: "conflict", conflicts: ["file"] },
    { commit: later, state: "blocked" },
  ]);
  expect(batch.repos[0]!.gate).toBeUndefined();
  expect(await git(f.core.source, "rev-parse", "HEAD")).toBe(later);
  expect(await git(f.core.source, "ls-remote", "origin", "refs/heads/main")).toContain(remote);
});

it.each(["process.exit(7);", "execFileSync('git', ['commit', '--allow-empty', '-m', 'gate moved HEAD']);"])(
  "retains exit and tested HEAD when a gate fails or changes HEAD (%s)",
  async (extra) => {
    const f = await fixture(extra);
    const approved = await commit(f.core.source, "feature", "test");
    const request = IntegrationRunSchema.parse({ action: "run", id: randomUUID(), core: [approved] });
    await f.queue.start(request, guard);
    await f.queue.wait();
    const batch = await f.queue.status(request.id);
    expect(batch.state).toBe("failed");
    expect(batch.repos[0]!.gate?.exitCode).toBe(extra.startsWith("process") ? 7 : 0);
    expect(batch.repos[0]!.gate?.head).toBe(batch.repos[0]!.head);
    await expect(f.queue.land(request.id, [], guard)).rejects.toThrow("no landable pass");
    expect(await git(f.core.source, "ls-remote", "origin", "refs/heads/main")).toContain(f.core.base);
  },
);

it.each(["head", "dirty", "origin"])("refuses a saved pass after %s changes", async (change) => {
  const f = await fixture();
  const approved = await commit(f.core.source, "feature", "test");
  const request = IntegrationRunSchema.parse({ action: "run", id: randomUUID(), core: [approved] });
  await f.queue.start(request, guard);
  await f.queue.wait();
  const batch = await f.queue.status(request.id);
  expect(batch.state).toBe("passed");
  const repo = batch.repos[0]!;
  if (change === "head") await git(repo.directory, "commit", "--allow-empty", "-m", "after gate");
  else if (change === "dirty") await writeFile(join(repo.directory, "feature"), "after gate");
  else {
    await commit(f.core.source, "other", "remote drift");
    await git(f.core.source, "push", "origin", "HEAD:main");
  }
  const refused = await f.queue.land(request.id, [], guard);
  expect(refused.state).toBe("held");
  expect(refused.repos[0]!.push).toBeUndefined();
  expect(refused.error).toMatch(/exact HEAD|worktree changed|origin\/main moved/u);
});

it("CLI/API batch passes, a named gone hold blocks push and runtime update, and owner override is audited", async () => {
  const f = await fixture();
  const approved = await commit(f.core.source, "feature", "test");
  const emptySnapshot = JSON.stringify({ result: { snapshot: { workspaces: [], tabs: [], panes: [] } } });
  const holds = new DeployHolds(f.directory, (hold) => deployHoldPresence(hold, async () => emptySnapshot));
  const queue = new IntegrationQueue({ ...f.queue.options, holds });
  // This real updater refuses an unpinned fixture checkout before ever spawning its helper.
  const updater = createRuntimeUpdater({ repoRoot: f.core.source, env: { ...process.env, HOME: f.root } });
  const service = await createClankieApp({
    integration: queue,
    deployHolds: holds,
    runtimeUpdater: updater,
    captain: createStubCaptain(),
    authenticateOperator: async (r) =>
      r.headers.get("authorization") === "Bearer fixture-owner" ? { operatorId: "fixture-owner" } : undefined,
  });
  cleanups.push(() => service.close());
  const fetchImpl: typeof fetch = async (input, init) => service.app.fetch(new Request(input, init));
  const cli = { host: "http://fixture.invalid", fetchImpl, env: { CLANKIE_OPERATOR_TOKEN: "fixture-owner" } };
  const id = randomUUID();
  const run = await runIntegrationCommand([approved, "--id", id, "--no-wait"], cli);
  expect(run.ok).toBe(true);
  await queue.wait();
  expect((await runIntegrationCommand(["status", id], cli)).batch?.state).toBe("passed");
  const holdId = randomUUID();
  const acquired = await runIntegrationCommand(
    ["hold", "--id", holdId, "--holder", "Bram w3Z:p2N", "--pane", "w3Z:p2N", "--reason", "live test"],
    cli,
  );
  expect(acquired.holds).toMatchObject([
    { id: holdId, holder: "Bram w3Z:p2N", reason: "live test", presence: "gone" },
  ]);
  expect(acquired.holds![0]!.createdAt).toMatch(/T/u);
  const held = await runIntegrationCommand(["push", id], cli);
  expect(held.ok).toBe(false);
  expect(held.batch?.error).toContain("Bram w3Z:p2N");
  expect(await git(f.core.source, "ls-remote", "origin", "refs/heads/main")).toContain(f.core.base);
  const deploy = await fetchImpl("http://fixture.invalid/v1/runtime-update", {
    method: "POST",
    headers: { authorization: "Bearer fixture-owner", "content-type": "application/json" },
    body: "{}",
  });
  expect(deploy.status).toBe(409);
  expect(await deploy.text()).toContain("live test");
  expect(
    (
      await fetchImpl("http://fixture.invalid/v1/integrate", {
        method: "POST",
        body: JSON.stringify({ action: "push", id }),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await runIntegrationCommand(
        ["push", id, "--override-hold", holdId, "--actor", "James", "--reason", "ship approved batch"],
        cli,
      )
    ).batch?.state,
  ).toBe("pushed");
  expect((await holds.list()).map((h) => h.id)).toEqual([holdId]);
  const audit = JSON.parse(await readFile(join(f.directory, "holds.json"), "utf8"));
  expect(audit.events).toMatchObject([
    {
      action: "override",
      actor: "James",
      reason: "ship approved batch",
      operation: `integrate:${id}`,
      hold: { id: holdId },
    },
  ]);
  await runIntegrationCommand(["release", holdId, "--actor", "James", "--reason", "test finished"], cli);
  expect(await holds.list()).toEqual([]);
  expect(
    await deployHoldPresence(acquired.holds![0]!, async () => {
      throw Error("socket unavailable");
    }),
  ).toBe("unknown");
});

it("restores a passed tree with a new gated forward commit, retaining bad history", async () => {
  const f = await fixture();
  const approved = await commit(f.core.source, "feature", "good");
  const goodRequest = IntegrationRunSchema.parse({
    action: "run",
    id: randomUUID(),
    core: [approved],
    push: true,
  });
  await f.queue.start(goodRequest, guard);
  await f.queue.wait();
  const good = await f.queue.status(goodRequest.id);
  expect(good.state).toBe("pushed");
  const repo = good.repos[0]!;
  // Simulate an unrelated bad push using only the disposable bare origin.
  await git(f.core.source, "fetch", "origin");
  await git(f.core.source, "checkout", "-B", "main", "origin/main");
  const bad = await commit(f.core.source, "feature", "bad");
  await git(f.core.source, "push", "origin", "HEAD:main");
  const restore = IntegrationRunSchema.parse({
    action: "run",
    id: randomUUID(),
    restore: good.id,
    push: true,
  });
  await f.queue.start(restore, guard);
  await f.queue.wait();
  const restored = await f.queue.status(restore.id);
  expect(restored.state).toBe("pushed");
  const head = restored.repos[0]!.head;
  expect(await git(restored.repos[0]!.directory, "rev-parse", `${head}^`)).toBe(bad);
  expect(await git(restored.repos[0]!.directory, "rev-parse", `${head}^{tree}`)).toBe(
    await git(repo.directory, "rev-parse", `${repo.head}^{tree}`),
  );
  expect(head).not.toBe(repo.head);
  expect(restored.repos[0]!.gate?.head).toBe(head);
});

it("records core landed/app pending on app rejection and retries only app", async () => {
  const f = await fixture("", true);
  const core = await commit(f.core.source, "feature", "core");
  const app = await commit(f.app!.source, "feature", "app");
  const count = join(f.root, "core-landings");
  const coreHook = join(f.core.origin, "hooks", "pre-receive");
  const appHook = join(f.app!.origin, "hooks", "pre-receive");
  await writeFile(coreHook, `#!/bin/sh\ncat >/dev/null\necho landed >> '${count}'\n`);
  await chmod(coreHook, 0o700);
  await writeFile(appHook, "#!/bin/sh\necho fixture-rejection >&2\nexit 1\n");
  await chmod(appHook, 0o700);
  const request = IntegrationRunSchema.parse({
    action: "run",
    id: randomUUID(),
    core: [core],
    app: [app],
    push: true,
  });
  await f.queue.start(request, guard);
  await f.queue.wait();
  const partial = await f.queue.status(request.id);
  expect(partial.state).toBe("partial");
  expect(partial.error).toContain(`Core landed at ${partial.repos[0]!.head}; app pending`);
  expect(partial.repos[0]!.push?.state).toBe("confirmed");
  expect(partial.repos[1]!.push?.state).toBe("rejected");
  expect(await readFile(count, "utf8")).toBe("landed\n");
  expect(await git(f.app!.source, "ls-remote", "origin", "refs/heads/main")).toContain(f.app!.base);
  await rm(appHook);
  const landed = await f.queue.land(request.id, [], guard);
  expect(landed.state).toBe("pushed");
  expect(await readFile(count, "utf8")).toBe("landed\n");
  expect(landed.repos[0]!.push).toEqual(partial.repos[0]!.push);
  expect(await git(f.app!.source, "ls-remote", "origin", "refs/heads/main")).toContain(landed.repos[1]!.head);
});

it("a confirmed integration push fast-forwards clean owner main and persists the sync receipt", async () => {
  const f = await fixture();
  await git(f.core.source, "switch", "-c", "worker");
  const approved = await commit(f.core.source, "new-feature", "approved");
  await git(f.core.source, "switch", "main");
  const request = IntegrationRunSchema.parse({ action: "run", id: randomUUID(), core: [approved] });
  await f.queue.start(request, guard);
  await f.queue.wait();
  const landed = await f.queue.land(request.id, [], guard);
  expect(landed.state).toBe("pushed");
  expect(landed.repos[0]!.ownerCheckoutSync).toMatchObject({
    outcome: "updated",
    path: f.core.source,
    before: f.core.base,
    after: landed.repos[0]!.head,
  });
  expect(await git(f.core.source, "rev-parse", "HEAD")).toBe(landed.repos[0]!.head);
  expect((await f.queue.status(request.id)).repos[0]!.ownerCheckoutSync).toEqual(
    landed.repos[0]!.ownerCheckoutSync,
  );
});
