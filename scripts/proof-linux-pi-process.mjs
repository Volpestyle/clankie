// Manual kernel boundary proof; no model, owner state, AWS or existing worker is used.
// Run in an ephemeral Linux container through clankie heavy. The source tree may
// be mounted read-only; all processes, sockets and files belong to this fixture.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { createPreparedNativeHost } from "../apps/clankie/src/captain/prepared-native-host.ts";
import { discoverPiNativeCapability } from "../apps/clankie/src/captain/pi-native-capability.ts";

import { clientPid } from "../apps/clankie/src/local-fleet-proof.ts";
import { createPiWorkerStatusReader } from "../apps/clankie/src/captain/pi-worker-account.ts";
import {
  createWorkerAccountsReader,
  chooseWorkerHarness,
} from "../apps/clankie/src/captain/harness-accounts.ts";
import { SettingsStore } from "../packages/settings/src/index.ts";

assert.equal(process.platform, "linux", "this proof requires a real Linux kernel");
const execute = promisify(execFile);
const directory = await realpath(await mkdtemp(join(tmpdir(), "linux-pi-process-")));
const executable = await realpath(process.execPath);
const helper = fileURLToPath(new URL("../integrations/opencode-plugin/process-birth.py", import.meta.url));
const child = spawn(
  executable,
  [
    "-e",
    "process.on('message', x => { if (typeof x === 'number') require('node:net').createConnection({host:'127.0.0.1',port:x}); else {process.chdir(x);process.send('changed');} }); process.send('ready');",
  ],
  { cwd: directory, stdio: ["ignore", "ignore", "ignore", "ipc"] },
);
const ready = once(child, "message");
const golden = JSON.parse(
  await readFile(
    new URL("../apps/clankie/test/fixtures/herdr-0.9.3-reported-pane.json", import.meta.url),
    "utf8",
  ),
);
const pane = structuredClone(golden.pane);
delete pane.agent;
delete pane.agent_session;
const socketPath = join(directory, "herdr.sock");
const census = createServer((socket) => {
  let input = "";
  socket.on("data", (bytes) => {
    input += bytes;
    if (!input.includes("\n")) return;
    const request = JSON.parse(input.split("\n")[0]);
    let result;
    if (request.method === "pane.process_info")
      result = {
        type: "pane_process_info",
        process_info: { pane_id: pane.pane_id, shell_pid: child.pid, foreground_process_group_id: child.pid },
      };
    if (request.method === "pane.get") result = { type: "pane_info", pane };
    if (request.method === "pane.report_agent") {
      pane.agent_session = {
        source: request.params.source,
        agent: request.params.agent,
        kind: "path",
        value: request.params.agent_session_path,
      };
      result = { type: "ok" };
    }
    socket.end(JSON.stringify({ id: request.id, result }) + "\n");
  });
});
const sockets = [];
const server = createServer((socket) => sockets.push(socket));
let foreign;
const observe = async () =>
  JSON.parse(
    (await execute("/usr/bin/python3", ["-I", helper, String(child.pid)], { timeout: 5000 })).stdout,
  );
try {
  assert.equal((await ready)[0], "ready");
  const sessions = join(directory, "sessions");
  await mkdir(sessions);
  process.env.PI_CODING_AGENT_SESSION_DIR = sessions;
  const capability = await discoverPiNativeCapability({
    harness: "pi",
    cwd: directory,
    brief: "fixture only; no native agent turn",
  });
  await capability.verify();
  assert.equal(capability.executable, executable);
  const settings = new SettingsStore(join(directory, "settings.json"));
  const seatModel = async () => ({
    model: "clankie/default",
    provider: {
      id: "clankie",
      config: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-responses", apiKey: "local" },
    },
  });
  let enabled = true;
  const piStatus = createPiWorkerStatusReader({ enabled: () => enabled, cwd: directory, seatModel });
  const accounts = createWorkerAccountsReader({
    settings: () => settings.load(),
    piStatus,
    fleet: async () => undefined,
  });
  const report = await accounts(undefined, ["pi"]);
  assert.equal(report.accounts.length, 1);
  assert.equal(report.accounts[0].usable, true);
  assert.deepEqual(report.accounts[0].models, ["clankie/default"]);
  assert.equal(chooseWorkerHarness("local", report).harness, "pi");
  await settings.update((current) => ({
    ...current,
    workerAccountHolds: [{ machine: "local", harness: "pi", label: "default", reason: "fixture owner hold" }],
  }));
  const held = await accounts(undefined, ["pi"]);
  assert.deepEqual(held.accounts[0].held, { reason: "fixture owner hold" });
  assert.ok("refused" in chooseWorkerHarness("local", held));
  await settings.update((current) => ({ ...current, workerAccountHolds: [] }));
  assert.equal(chooseWorkerHarness("local", await accounts(undefined, ["pi"])).harness, "pi");
  enabled = false;
  const disabled = await accounts(undefined, ["pi"]);
  assert.equal(disabled.accounts[0].usable, false);
  assert.ok("refused" in chooseWorkerHarness("local", disabled));
  enabled = true;
  for (const unavailableModel of [
    async () => undefined,
    async () => ({ model: "clankie/default" }),
    async () => {
      throw new Error("fixture unavailable callback");
    },
  ]) {
    const unavailable = await createPiWorkerStatusReader({
      enabled: () => true,
      cwd: directory,
      seatModel: unavailableModel,
    })();
    assert.equal(unavailable.usable, false);
    assert.ok("refused" in chooseWorkerHarness("local", { machine: "local", accounts: [unavailable] }));
  }
  const id = randomUUID();
  const nativeFile = join(sessions, `fixture_${id}.jsonl`);
  await writeFile(nativeFile, JSON.stringify({ type: "session", version: 3, id, cwd: directory }) + "\n");
  await capability.verifySession(id, nativeFile, directory);
  await new Promise((resolve) => census.listen(socketPath, resolve));
  const host = createPreparedNativeHost({
    harness: "pi",
    binding: async () => ({ runtime: "external", session: "golden", socketPath }),
    processHelper: helper,
  });
  const root = await host.capture(pane.pane_id, executable, directory);
  const session = { source: "herdr:pi", kind: "path", value: nativeFile };
  await root.report(session, "idle");
  assert.equal((await root.proof(session)).shell.pid, child.pid);
  const first = await observe();
  assert.equal(first.pid, child.pid);
  assert.equal(first.uid, process.getuid());
  assert.equal(await realpath(first.executable), executable);
  assert.equal(await realpath(first.cwd), directory);
  assert.match(first.birth[0], /^[1-9]\d*$/u);
  assert.match(first.birth[1], /^\d{1,6}$/u);
  assert.deepEqual(await observe(), first);
  const changedDirectory = join(directory, "changed");
  await mkdir(changedDirectory);
  const changed = once(child, "message");
  child.send(changedDirectory);
  await changed;
  const second = await observe();
  assert.equal(second.cwd, changedDirectory);
  assert.deepEqual(second.birth, first.birth);
  await assert.rejects(root.proof(session), /cwd changed/u);
  const restored = once(child, "message");
  child.send(directory);
  await restored;
  await root.proof(session);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const nativeConnected = once(server, "connection");
  child.send(port);
  const [nativeSocket] = await nativeConnected;
  const owners = async () =>
    (
      await execute("/usr/bin/lsof", ["-nP", "-a", `-iTCP:${port}`, "-sTCP:ESTABLISHED", "-Fpn"], {
        timeout: 5000,
      })
    ).stdout;
  assert.equal(clientPid(await owners(), nativeSocket.remotePort, port), child.pid);
  assert.equal(await root.check(nativeSocket), true);
  const otherConnected = once(server, "connection");
  foreign = createConnection({ host: "127.0.0.1", port });
  const [otherSocket] = await otherConnected;
  assert.equal(clientPid(await owners(), otherSocket.remotePort, port), process.pid);
  assert.notEqual(clientPid(await owners(), otherSocket.remotePort, port), child.pid);
  assert.equal(await root.check(otherSocket), false);
  pane.agent_session.value = join(directory, "replacement.jsonl");
  await assert.rejects(root.proof(session), /allocation changed/u);
  pane.agent_session.value = nativeFile;
  const exited = once(child, "exit");
  child.kill();
  await exited;
  await assert.rejects(observe);
  await assert.rejects(root.proof(session));
  console.log(
    JSON.stringify({
      result: "passed",
      kernel: "linux",
      checks: [
        "published-pi-0.87.1-bundle-hashes-linux-elf",
        "native-session-file-header",
        "shared-pi-usability-producer-models-auto-choice",
        "durable-owner-hold-refuses-auto-then-release-restores",
        "flag-off-and-unverified-models-refuse",
        "production-host-capture-golden-herdr",
        "original-pid-uid-executable-cwd-birth",
        "changed-cwd-visible-stable-birth",
        "original-tcp-client-owner",
        "other-process-not-original-owner",
        "exited-process-refused",
      ],
      modelCalls: 0,
    }),
  );
} finally {
  foreign?.destroy();
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => census.close(resolve));
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
  await rm(directory, { recursive: true, force: true });
}
