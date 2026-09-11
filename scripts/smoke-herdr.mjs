import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const checkout = resolve(import.meta.dirname, "..");

export async function smokeHerdr(repoRoot = checkout) {
  const compiled = join(repoRoot, "apps/clankie/src/herdr-runtime.js");
  const { startHerdrRuntime } = await import(
    pathToFileURL(existsSync(compiled) ? compiled : compiled.replace(/\.js$/u, ".ts")).href
  );
  const binary = join(
    repoRoot,
    existsSync(join(repoRoot, "libexec/herdr")) ? "libexec/herdr" : ".data/herdr/bin/herdr",
  );
  const root = await mkdtemp("/tmp/ch-smoke-");
  const env = {
    ...process.env,
    SHELL: "/bin/sh",
    XDG_CONFIG_HOME: "/owner/config",
    HERDR_PANE_ID: "external-pane",
    HERD_LEAD_SUMMARIES_CACHE: "/external/summaries.json",
  };
  let runtime;
  let owner;
  let orphanPid;
  const options = { binary, repoRoot, stateRoot: root, env };
  const command = async (...args) => (await exec(binary, args, { env, timeout: 5_000 })).stdout;
  const snapshot = async () => JSON.parse(await command("api", "snapshot")).result.snapshot;
  try {
    runtime = await startHerdrRuntime(options);
    assert.equal(runtime.status(), "healthy");
    assert.equal(env.HERDR_PANE_ID, undefined);
    assert.equal(env.HERD_LEAD_SUMMARIES_CACHE, undefined);
    assert.ok(env.HERDR_PLUGIN_STATE_DIR.startsWith(root));
    assert.equal((await stat(env.HERDR_SOCKET_PATH)).mode & 0o777, 0o600);
    // A live server that answers is adopted, never refused (ADR 0164).
    const adopter = await startHerdrRuntime({ ...options, env: { ...env } });
    assert.equal(adopter.status(), "healthy");
    await adopter.close();
    await command("workspace", "create", "--cwd", root, "--label", "clankie-runtime-proof");
    const first = await snapshot();
    assert.equal(first.workspaces.length, 1);
    assert.ok(first.panes.length > 0);
    const marker = join(root, "worker-result");
    const pidFile = join(root, "server-pid");
    const paneEnv = join(root, "pane-env");
    await command(
      "pane",
      "run",
      first.panes[0].pane_id,
      `printf clankie-herdr-ok > '${marker}'; printf '%s' "$PPID" > '${pidFile}'; printf '%s|%s' "$XDG_CONFIG_HOME" "$SHELL" > '${paneEnv}'`,
    );
    await until(async () => existsSync(marker) && (await readFile(marker, "utf8")) === "clankie-herdr-ok");
    // The pane is the owner's shell with the owner's environment, not the
    // server's private XDG isolation.
    await until(async () => (await readFile(paneEnv, "utf8")) === "/owner/config|/bin/sh");
    const previousPid = Number(await readFile(pidFile, "utf8"));
    assert.ok(Number.isSafeInteger(previousPid) && previousPid > 1);
    const configPath = join(root, "herdr/herdr/config.toml");
    await appendFile(configPath, "\n# viewer preferences survive restart\n");
    // A stop through Clankie detaches and the fleet outlives him (ADR 0164);
    // stopping the fleet itself is explicit and persists the session. The next
    // start then restores it, and the config keeps its additions.
    await runtime.close();
    await command("server", "stop");
    await until(async () => !processAlive(previousPid));
    runtime = await startHerdrRuntime(options);
    await until(async () => (await snapshot()).workspaces.length === 1);
    assert.ok((await readFile(configPath, "utf8")).includes("# viewer preferences survive restart"));
    const restored = await snapshot();
    await rm(pidFile, { force: true });
    await command("pane", "run", restored.panes[0].pane_id, `printf '%s' "$PPID" > '${pidFile}'`);
    await until(async () => existsSync(pidFile) && Number(await readFile(pidFile, "utf8")) > 1);
    const crashedPid = Number(await readFile(pidFile, "utf8"));
    assert.notEqual(crashedPid, previousPid, "an explicit stop ends the server");
    const processCommand = (await exec("ps", ["-p", String(crashedPid), "-o", "command="])).stdout;
    assert.ok(
      processCommand.includes(binary) && processCommand.includes("server"),
      "only crash our owned Herdr child",
    );
    process.kill(crashedPid, "SIGKILL");
    await until(async () => runtime.status() === "recovering");
    await until(async () => runtime.status() === "healthy" && (await snapshot()).workspaces.length === 1);
    assert.equal(await readFile(marker, "utf8"), "clankie-herdr-ok");
    await command("workspace", "create", "--cwd", root, "--label", "after-reconnect");
    assert.equal((await snapshot()).workspaces.length, 2);
    // Clankie leaving does not end the fleet: the server still answers, a new
    // owner adopts it, and losing that owner to SIGKILL leaves it working too.
    await runtime.close();
    runtime = undefined;
    assert.equal((await snapshot()).workspaces.length, 2);
    const ownerScript = join(root, "owner.mjs");
    const runtimeModule = pathToFileURL(
      existsSync(compiled) ? compiled : compiled.replace(/\.js$/u, ".ts"),
    ).href;
    await writeFile(
      ownerScript,
      `import { startHerdrRuntime } from ${JSON.stringify(runtimeModule)}; await startHerdrRuntime({ binary: ${JSON.stringify(binary)}, repoRoot: ${JSON.stringify(repoRoot)}, stateRoot: ${JSON.stringify(root)}, env: process.env });`,
    );
    owner = spawn(process.execPath, [ownerScript], { env, stdio: "ignore" });
    await until(async () => (await snapshot()).workspaces.length === 2);
    const adopted = await snapshot();
    await rm(pidFile, { force: true });
    await command("pane", "run", adopted.panes[0].pane_id, `printf '%s' "$PPID" > '${pidFile}'`);
    await until(async () => Number(await readFile(pidFile, "utf8")) > 1);
    orphanPid = Number(await readFile(pidFile, "utf8"));
    const ownedCommand = (await exec("ps", ["-p", String(orphanPid), "-o", "command="])).stdout;
    assert.ok(ownedCommand.includes(binary) && ownedCommand.includes("server"));
    owner.kill("SIGKILL");
    await until(async () => !processAlive(owner.pid));
    owner = undefined;
    await sleep(500);
    assert.ok(processAlive(orphanPid), "the fleet outlives its owner");
    assert.equal((await snapshot()).workspaces.length, 2);
    // Stopping the fleet is explicit, and only that ends the server.
    await command("server", "stop");
    await until(async () => !processAlive(orphanPid));
    await assert.rejects(command("api", "snapshot"));
    orphanPid = undefined;
    process.stdout.write(
      `Herdr smoke passed (${process.platform}-${process.arch}): worker execution, owner environment in panes, adoption, restore, crash recovery, reconnect, fleet outlives owner, explicit stop\n`,
    );
  } finally {
    await runtime?.close();
    owner?.kill("SIGKILL");
    if (orphanPid) await until(async () => !processAlive(orphanPid));
    await rm(root, { recursive: true, force: true });
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function until(check) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      /* The native server is recovering. */
    }
    await sleep(50);
  }
  throw new Error("Herdr lifecycle check timed out");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename))
  await smokeHerdr();
