import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");
const archive = resolve(process.argv[2] ?? join(repoRoot, "dist", "clankie-darwin-arm64.tar.gz"));
const temporary = await mkdtemp(join(tmpdir(), "clankie-release-smoke-"));
const extracted = join(temporary, "clankie");
const workspace = join(temporary, "workspace");
let directService;
let activity;
let launcherStarted = false;

try {
  run("tar", ["-xzf", archive, "-C", temporary]);
  await mkdir(workspace);
  const version = (await readFile(join(extracted, "VERSION"), "utf8")).trim();
  const manifest = JSON.parse(await readFile(join(extracted, "release.json"), "utf8"));
  const sbom = JSON.parse(await readFile(join(extracted, "SBOM.cdx.json"), "utf8"));
  if (manifest.version !== version || !Array.isArray(sbom.components) || sbom.components.length === 0) {
    throw new Error("release metadata is incomplete");
  }

  const binary = join(extracted, "bin", "clankie");
  const node = join(extracted, "libexec", "node");
  const binaryDescription = capture("file", [binary]).stdout;
  if (!binaryDescription.includes("Mach-O 64-bit executable arm64")) {
    throw new Error(`launcher is not arm64 Mach-O: ${binaryDescription}`);
  }
  const shownVersion = capture(binary, ["--version"], { cwd: workspace }).stdout.trim();
  if (shownVersion !== `clankie ${version.slice(1)}`) {
    throw new Error(`unexpected version output: ${shownVersion}`);
  }
  const bundleRequire = pathToFileURL(join(extracted, "apps", "clankie", "src", "index.js")).href;
  capture(node, [
    "--input-type=module",
    "--eval",
    `import { createRequire } from "node:module"; const require = createRequire(${JSON.stringify(bundleRequire)}); for (const id of ["ajv-formats/dist/formats", "ajv/dist/runtime/equal", "ajv/dist/runtime/ucs2length", "ajv/dist/runtime/uri", "ajv/dist/runtime/validation_error"]) require(id);`,
  ]);

  const servicePort = await freePort();
  const activityPort = await freePort();
  const producerPort = await freePort();
  const env = {
    ...process.env,
    HOME: join(temporary, "home"),
    XDG_CONFIG_HOME: join(temporary, "config"),
    XDG_STATE_HOME: join(temporary, "state"),
    XDG_DATA_HOME: join(temporary, "data"),
    CLANKIE_STATE: join(temporary, "clankie-state"),
    CLANKIE_CREDENTIALS_FILE: join(temporary, "config", "clankie", "credentials.json"),
    CLANKIE_CONTROL_PLANE_URL: `http://127.0.0.1:${servicePort}`,
    CLANKIE_BROWSER_ENABLED: "false",
    CLANKIE_TLDRAW_ENABLED: "false",
    CLANKIE_DISCORD_PRESENCE_RUNTIME_MODULE: join(
      extracted,
      "apps",
      "discord-bridge",
      "src",
      "presence-runtime-module.js",
    ),
    CLANKIE_DISCORD_USER_PRESENCE_RUNTIME_MODULE: join(
      extracted,
      "apps",
      "discord-user-session",
      "src",
      "presence-runtime-module.js",
    ),
    PORT: String(servicePort),
    CLANKIE_ACTIVITY_PORT: String(activityPort),
    CLANKIE_ACTIVITY_PRODUCER_PORT: String(producerPort),
  };

  directService = start(node, [join(extracted, "apps", "clankie", "src", "index.js")], env, workspace);
  await waitFor(`http://127.0.0.1:${servicePort}/health`, directService);
  const health = await (await fetch(`http://127.0.0.1:${servicePort}/health`)).json();
  if (health.ok !== true) throw new Error("packaged service health check failed");
  const status = JSON.parse(capture(binary, ["status"], { cwd: workspace, env }).stdout);
  if (
    status.ok !== true ||
    status.services?.find((service) => service.id === "clankie")?.state !== "healthy"
  ) {
    throw new Error(`packaged status failed: ${JSON.stringify(status)}`);
  }
  await stop(directService);
  directService = undefined;

  activity = start(node, [join(extracted, "apps", "discord-activity", "src", "index.js")], env, workspace);
  await waitFor(`http://127.0.0.1:${activityPort}/`, activity);
  const activityHtml = await (await fetch(`http://127.0.0.1:${activityPort}/`)).text();
  if (!activityHtml.includes("Clankie")) throw new Error("packaged activity client asset was not served");
  await stop(activity);
  activity = undefined;

  capture(process.execPath, [join(repoRoot, "packages", "vox-client", "test", "ipc-smoke.ts")], {
    env: { ...process.env, CLANKIE_VOX_BIN: join(extracted, "apps", "vox", "target", "release", "clankvox") },
  });

  if (process.env.CLANKIE_RELEASE_SMOKE_SKIP_LAUNCHER_START !== "1") {
    launcherStarted = true;
    const launched = capture(binary, [], { cwd: workspace, env, allowFailure: true, timeout: 90_000 });
    if (launched.status !== 1 || !launched.stderr.includes("the TUI requires a TTY")) {
      throw new Error(`packaged launcher did not reach the TUI: ${launched.stderr}`);
    }
    const owned = JSON.parse(capture(binary, ["status"], { cwd: workspace, env }).stdout);
    if (owned.ok !== true || owned.owned !== true) throw new Error(`launcher did not own its service`);
    capture(binary, ["down", "clankie"], { cwd: workspace, env });
    launcherStarted = false;
  }

  process.stdout.write(`Clankie release smoke passed: ${version}\n`);
} finally {
  if (directService !== undefined) await stop(directService).catch(() => undefined);
  if (activity !== undefined) await stop(activity).catch(() => undefined);
  if (launcherStarted) {
    const binary = join(extracted, "bin", "clankie");
    spawnSync(binary, ["down", "clankie"], {
      cwd: workspace,
      env: {
        ...process.env,
        XDG_STATE_HOME: join(temporary, "state"),
        CLANKIE_CREDENTIALS_FILE: join(temporary, "config", "clankie", "credentials.json"),
      },
    });
  }
  await rm(temporary, { recursive: true, force: true });
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`);
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} failed (${String(result.status)}): ${result.stderr}`);
  }
  return result;
}

function start(command, args, env, cwd) {
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });
  child.smokeOutput = () => output;
  return child;
}

async function waitFor(url, child) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null)
      throw new Error(`process exited before ${url} was ready: ${child.smokeOutput()}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Startup is still in progress.
    }
    await sleep(100);
  }
  throw new Error(`${url} did not become ready: ${child.smokeOutput()}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = new Promise((done) => child.once("exit", done));
  if ((await Promise.race([exited.then(() => true), sleep(20_000).then(() => false)])) === false) {
    child.kill("SIGKILL");
    await exited;
  }
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : undefined;
  await new Promise((resolveClose) => server.close(resolveClose));
  if (port === undefined) throw new Error("failed to allocate a smoke-test port");
  return port;
}
