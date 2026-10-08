import { execFile, spawn } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterEach, expect, it } from "vitest";
import {
  defaultSettingsPath,
  localSandboxControl,
  localSandboxLaunch,
  readLocalSandbox,
  verifyLocalSandbox,
} from "@clankie/settings";
import { runMachinesCommand } from "../src/command/machines.ts";
import { startService, stopService, type ManagedService } from "../bin/service-supervisor.ts";

const exec = promisify(execFile);
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const native = it.skipIf(process.platform !== "darwin");

async function fixture() {
  // Short canonical roots keep the native fleet's Unix sockets below macOS's limit.
  const root = await realpath(await mkdtemp("/tmp/cs-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const runtimeRoot = join(root, "runtime"),
    workspace = join(root, "work"),
    home = join(root, "home");
  const env = { HOME: root, XDG_CONFIG_HOME: join(root, "config") };
  for (const dir of [join(runtimeRoot, "libexec"), workspace, join(root, "config", "clankie")])
    await mkdir(dir, { recursive: true });
  await symlink(process.execPath, join(runtimeRoot, "libexec", "node"));
  await writeFile(join(runtimeRoot, "release.json"), "{}");
  await writeFile(defaultSettingsPath(env), JSON.stringify({ schemaVersion: 1 }));
  await writeFile(join(root, "outside.txt"), "outside-owner-data");
  await writeFile(join(workspace, "allowed.txt"), "approved-data");
  await symlink(join(root, "outside.txt"), join(workspace, "outside-link"));
  const options = { env, repoRoot: runtimeRoot };
  await runMachinesCommand(
    ["sandbox", "prepare", "shell", "--workspace", workspace, "--home", home],
    options,
  );
  const control = localSandboxControl(env);
  const node = join(runtimeRoot, "libexec", "node");
  const launch = async (file: string) =>
    localSandboxLaunch({ control, command: node, args: [file, root, workspace], env, runtimeRoot });
  return { root, runtimeRoot, workspace, home, env, options, control, node, launch };
}

native(
  "OS boundary confines the service and its child worker, refuses symlink/control/runtime escapes, and restores a new full launch",
  async () => {
    const f = await fixture();
    const outsideSocket = createServer((socket) => socket.end("outside"));
    await new Promise<void>((done) => outsideSocket.listen(join(f.root, "outside.sock"), done));
    cleanups.push(() => new Promise<void>((done) => outsideSocket.close(() => done())));
    await symlink(join(f.root, "outside.sock"), join(f.home, "outside-link.sock"));
    // This disposable outside PTY is ours, not an owner's or another seat's.
    const tty = spawn(
      "python3",
      ["-u", "-c", "import os,sys; m,s=os.openpty(); print(os.ttyname(s),flush=True); sys.stdin.read()"],
      { stdio: "pipe" },
    );
    const ttyExited = new Promise<void>((done) => tty.once("exit", () => done()));
    cleanups.push(async () => {
      tty.stdin.end();
      await ttyExited;
    });
    const outsideTty = await new Promise<string>((done, reject) => {
      tty.stdout.once("data", (data: Buffer) => done(data.toString().trim()));
      tty.once("error", reject);
      tty.once("exit", () => reject(new Error("Disposable PTY helper exited before readiness")));
    });
    const ptySource = join(f.runtimeRoot, "pty.c"),
      ptyBinary = join(f.runtimeRoot, "pty");
    await writeFile(
      ptySource,
      `#include <util.h>
#include <stdio.h>
#include <unistd.h>
#include <string.h>
int main(void) { int master,slave; char buf[64];
  if(openpty(&master,&slave,0,0,0)) { perror("openpty"); return 1; }
  if(write(slave,"private-pty\\n",12)!=12) return 2;
  ssize_t n=read(master,buf,sizeof(buf)); close(master); close(slave);
  if(n<11 || memcmp(buf,"private-pty",11)) return 3;
  puts("private-pty"); return 0;
}`,
    );
    await exec("/usr/bin/clang", [ptySource, "-o", ptyBinary]);
    const source = `
    import { readFile, writeFile, link } from 'node:fs/promises';
    import { execFile } from 'node:child_process';
    import { promisify } from 'node:util';
    import { join } from 'node:path';
    import { createConnection, createServer } from 'node:net';
    import { verifyLocalSandbox, localSandboxAccess, removeLocalSandbox, SettingsStore } from ${JSON.stringify(resolve("packages/settings/src/index.ts"))};
    import { Machines } from ${JSON.stringify(resolve("apps/clankie/src/machines.ts"))};
    import { createMachineAccessRoutes } from ${JSON.stringify(resolve("apps/clankie/src/machine-access-routes.ts"))};
    import { ExecutionConnections } from ${JSON.stringify(resolve("apps/clankie/src/herdr-session.ts"))};
    import { serve } from '@hono/node-server';
    const [root, work] = process.argv.slice(2);
    const sandbox = await verifyLocalSandbox();
    const denied = async (effect) => { try { await effect(); return 'allowed'; } catch (error) { return error.code ?? error.message; } };
    const result = { level: localSandboxAccess('screen'), access: sandbox.accessLevel,
      allowed: await readFile(join(work, 'allowed.txt'), 'utf8'),
      outside: await denied(() => readFile(join(root, 'outside.txt'))),
      symlink: await denied(() => readFile(join(work, 'outside-link'))),
      outsideTty: await denied(() => readFile(${JSON.stringify(outsideTty)})),
      control: await denied(() => removeLocalSandbox(process.env.CLANKIE_LOCAL_SANDBOX)),
      runtime: await denied(() => writeFile(join(root, 'runtime', 'release.json'), 'poison')),
      hardlink: await denied(() => link(join(root, 'runtime', 'release.json'), join(work, 'runtime-link'))),
    };
    await writeFile(join(work, 'written.txt'), 'approved-write');
    const worker = await promisify(execFile)(process.execPath, ['-e',
      'require("node:fs").readFile(process.argv[1], (e) => { console.log(e?.code ?? "allowed") })', join(root, 'outside.txt')]);
    result.worker = worker.stdout.trim();
    result.pty = (await promisify(execFile)(join(root, 'runtime', 'pty'), [])).stdout.trim();
    const connect = (path) => new Promise((done, reject) => {
      const socket = createConnection(path); let bytes = '';
      socket.on('data', b => { bytes += b }); socket.on('end', () => done(bytes));
      socket.on('error', e => { socket.destroy(); reject(e) });
    });
    result.outsideSocket = await denied(() => connect(join(root, 'outside.sock')));
    result.outsideSocketLink = await denied(() => connect(join(sandbox.home, 'outside-link.sock')));
    const privatePath = join(sandbox.home, 'private.sock');
    const privateServer = createServer(socket => socket.end('private-ipc'));
    await new Promise(done => privateServer.listen(privatePath, done));
    result.privateSocket = await connect(privatePath);
    await new Promise(done => privateServer.close(done));
    const store = new SettingsStore();
    const connections = new ExecutionConnections({ settings: store, primary: { binding: () => undefined, status: () => 'unavailable' } });
    result.named = await denied(() => connections.connect({ id: 'injected', session: 'outside', socketPath: privatePath }));
    await store.update(current => ({ ...current, machineAccess: { ...current.machineAccess, local: 'screen' },
      execution: { ...current.execution, connections: [{ id:'injected', session:'outside', socketPath:privatePath, enabled:true, kind:'herdr', capabilities:[] }] } }));
    result.settingRaise = localSandboxAccess((await store.load()).machineAccess.local);
    result.injectedBinding = await connections.configuredBinding('injected') ?? 'refused';
    result.injectedLookup = await connections.binding('injected') ?? 'refused';
    result.namedRoster = (await connections.namedLocal()).length;
    const machines = new Machines({ settings: store, primary: () => undefined, changed: () => {} });
    const app = createMachineAccessRoutes({ machines, authenticateOperator: async () => ({ operatorId: 'fixture-owner' }) });
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    await new Promise(done => server.listening ? done() : server.once('listening', done));
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/v1/machines/local/access', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessLevel: 'screen' }) });
    result.raise = { status: response.status, body: await response.json() };
    result.local = (await machines.list()).machines.find(m => m.id === 'local');
    server.closeAllConnections();
    await new Promise(done => server.close(done));
    console.log(JSON.stringify(result));
  `;
    const program = join(f.runtimeRoot, "proof.mjs");
    await build({
      stdin: { contents: source, resolveDir: resolve("apps/clankie"), sourcefile: "sandbox-fixture.mjs" },
      outfile: program,
      bundle: true,
      platform: "node",
      format: "esm",
      banner: {
        js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
      },
    });
    const launch = await f.launch(program);
    const result = await exec(launch.command, launch.args, {
      env: launch.env,
      cwd: f.workspace,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    }).catch((error) => {
      throw new Error(
        JSON.stringify({
          code: error.code,
          signal: error.signal,
          stderr: error.stderr,
          stdout: error.stdout,
        }),
      );
    });
    const proof = JSON.parse(result.stdout.trim());
    expect(proof).toMatchObject({
      level: "shell",
      access: "shell",
      allowed: "approved-data",
      outside: "EPERM",
      symlink: "EPERM",
      outsideTty: "EPERM",
      control: "EPERM",
      runtime: "EPERM",
      hardlink: "EPERM",
      worker: "EPERM",
      pty: "private-pty",
      outsideSocket: "EPERM",
      outsideSocketLink: "EPERM",
      privateSocket: "private-ipc",
      settingRaise: "shell",
      injectedBinding: "refused",
      injectedLookup: "refused",
      namedRoster: 0,
      raise: { status: 400 },
      local: {
        accessLevel: "shell",
        accessEnforcement: "os-sandbox",
        accessCeiling: "shell",
        approvedDirectories: [f.workspace],
      },
    });
    expect(proof.raise.body.detail).toContain("owner removal");
    expect(proof.named).toContain("fresh private default fleet");
    expect(await readFile(join(f.workspace, "written.txt"), "utf8")).toBe("approved-write");
    expect(await readLocalSandbox(f.control)).toBeDefined();
    await runMachinesCommand(["sandbox", "remove"], f.options);
    const restored = await localSandboxLaunch({
      control: f.control,
      command: f.node,
      args: [
        "-e",
        "console.log(require('node:fs').readFileSync(process.argv[1], 'utf8'))",
        join(f.root, "outside.txt"),
      ],
      env: f.env,
      runtimeRoot: f.runtimeRoot,
    });
    expect(restored.command).toBe(f.node);
    expect((await exec(restored.command, restored.args, { env: restored.env })).stdout.trim()).toBe(
      "outside-owner-data",
    );
  },
);

native(
  "a marker alone cannot attest a sandbox; malformed or mismatched launch controls fail closed",
  async () => {
    const f = await fixture();
    await expect(verifyLocalSandbox({ CLANKIE_LOCAL_SANDBOX: f.control })).rejects.toThrow("was readable");
    await writeFile(join(f.control, "profile.sb"), "(version 1)\n(allow default)\n");
    await expect(f.launch("unused")).rejects.toThrow("does not match");
    await writeFile(join(f.control, "envelope.json"), "{broken");
    await expect(f.launch("unused")).rejects.toThrow();
  },
);

native("the real supervisor starts an installed service inside its persisted boundary", async () => {
  const f = await fixture();
  const program = join(f.runtimeRoot, "service.mjs");
  const source = `
    import { createServer } from 'node:http';
    import { writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { verifyLocalSandbox, localSandboxAccess } from ${JSON.stringify(resolve("packages/settings/src/index.ts"))};
    await verifyLocalSandbox();
    const server = createServer((req, res) => { res.setHeader('content-type','application/json'); res.end(JSON.stringify({level:localSandboxAccess('screen')})); });
    server.listen(0,'127.0.0.1',async () => { await writeFile(join(process.env.HOME,'ready.json'),JSON.stringify({port:server.address().port})); });
  `;
  await build({
    stdin: { contents: source, resolveDir: resolve("apps/clankie"), sourcefile: "sandbox-service.mjs" },
    outfile: program,
    bundle: true,
    platform: "node",
    format: "esm",
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
  });
  const service: ManagedService = {
    id: "clankie",
    label: "Disposable bounded fixture",
    command: f.node,
    spawnArgs: [program],
    commandMatches: (command) => command.includes(program),
    probe: async () => {
      try {
        const { port } = JSON.parse(await readFile(join(f.home, "ready.json"), "utf8"));
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        const body = (await response.json()) as { level?: string };
        return { state: body.level === "shell" ? "healthy" : "unhealthy" };
      } catch {
        return { state: "unreachable" };
      }
    },
  };
  const serviceOptions = {
    env: f.env,
    repoRoot: f.runtimeRoot,
    timeoutMs: 10_000,
  };
  cleanups.push(() => stopService(service, serviceOptions));
  const started = await startService(service, serviceOptions);
  expect(started).toMatchObject({ id: "clankie", state: "healthy", owned: true });
});

native("owner preparation rejects runtime/control overlap and canonical symlink grants", async () => {
  const f = await fixture();
  await runMachinesCommand(["sandbox", "remove"], f.options);
  await expect(
    runMachinesCommand(["sandbox", "prepare", "shell", "--workspace", f.workspace, "--home", "/"], f.options),
  ).rejects.toThrow("filesystem root");
  await symlink(f.runtimeRoot, join(f.root, "runtime-alias"));
  await expect(
    runMachinesCommand(
      ["sandbox", "prepare", "shell", "--workspace", join(f.root, "runtime-alias"), "--home", f.home],
      f.options,
    ),
  ).rejects.toThrow("disjoint");
  await expect(
    runMachinesCommand(["sandbox", "prepare", "shell", "--workspace", f.root, "--home", f.home], f.options),
  ).rejects.toThrow("disjoint");
  await expect(
    runMachinesCommand(
      ["sandbox", "prepare", "screen", "--workspace", f.workspace, "--home", f.home],
      f.options,
    ),
  ).rejects.toThrow("unrestricted owner launch");
  await link(join(f.runtimeRoot, "release.json"), join(f.workspace, "runtime-alias"));
  await expect(
    runMachinesCommand(
      ["sandbox", "prepare", "shell", "--workspace", f.workspace, "--home", f.home],
      f.options,
    ),
  ).rejects.toThrow("hard-linked");
});
