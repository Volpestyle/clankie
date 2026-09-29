import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createBrowserHost } from "../../../../apps/clankie/src/browser-host.ts";
const exec = promisify(execFile);
const root = await mkdtemp("/tmp/vuh1448-");
const profile = join(root, "browser/profile");
const socket = join(root, "browser/run");
const home = join(root, "browser/home");
for (const dir of [profile, socket, home]) await mkdir(dir, { recursive: true });
const env = {
  PATH: process.env.PATH,
  HOME: home,
  AGENT_BROWSER_PROFILE: profile,
  AGENT_BROWSER_SOCKET_DIR: socket,
  AGENT_BROWSER_NAMESPACE: "clankie",
  AGENT_BROWSER_SESSION: "clankie",
  AGENT_BROWSER_HEADED: "1",
};
const events = [];
const log = (event) => {
  event.time = new Date().toISOString();
  events.push(event);
  console.log(JSON.stringify(event));
};
const processes = async () =>
  (await exec("ps", ["-axo", "pid=,command="])).stdout
    .split("\n")
    .filter((line) => line.includes(`--user-data-dir=${profile}`) && !line.includes("--type="));
const seed = await exec("agent-browser", ["open", "https://example.com", "--headed", "true"], {
  env,
  timeout: 60000,
});
log({ root, seed: seed.stdout, stale: await processes() });
assert((await processes()).some((line) => !line.includes("--headless")));
let host;
let recordingEnabled = true;
try {
  host = await createBrowserHost({
    stateRoot: root,
    attachmentRoot: join(root, "attachments"),
    environment: { ...process.env, AGENT_BROWSER_HEADED: "1" },
    idleMs: 2000,
    recordSessions: async () => recordingEnabled,
    logger: { info: log, warn: log },
  });
  assert((await host.catalog()).available);
  assert.equal((await processes()).length, 0);
  const call = async (tool, args = {}) => {
    const result = await host.call({ schemaVersion: 1, tool, arguments: args });
    log({ tool, result });
    assert.equal(result.outcome, "ok");
    assert.equal(result.isError, false);
    return result;
  };
  await call("agent_browser_open", { url: "https://example.com" });
  log({ headless: await processes() });
  assert((await processes()).every((line) => line.includes("--headless")));
  await call("agent_browser_eval", {
    script:
      'document.cookie="vuh1448=retained; Max-Age=3600; Secure; SameSite=Lax"; localStorage.setItem("vuh1448", "retained"); ({title:document.title,cookie:document.cookie,storage:localStorage.getItem("vuh1448"),ua:navigator.userAgent})',
  });
  const idle = async () => {
    for (let i = 0; i < 900; i++) {
      if (!(await processes()).length) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("Browser did not close on idle");
  };
  await idle();
  log({ idleClosed: true });
  recordingEnabled = false;
  await call("agent_browser_open", { url: "https://example.com", headed: true });
  await call("agent_browser_snapshot");
  assert((await processes()).some((line) => !line.includes("--headless")));
  log({ takeover: await processes() });
  const stored = await call("agent_browser_eval", {
    script: '({cookie:document.cookie,storage:localStorage.getItem("vuh1448")})',
  });
  assert(stored.content.includes("vuh1448=retained"));
  assert(stored.content.includes("retained"));
  await idle();
  log({ takeoverIdleClosed: true });
  recordingEnabled = true;
  await call("agent_browser_open", { url: "https://example.com" });
  assert((await processes()).length > 0);
  assert((await processes()).every((line) => line.includes("--headless")));
  log({ returnedHeadless: await processes() });
  await idle();
  const paths = (await readdir(join(root, "browser/recordings"))).filter((p) => p.endsWith(".webm"));
  assert.equal(paths.length, 2);
  for (const path of paths) {
    const full = join(root, "browser/recordings", path);
    const probe = await exec("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration,size:stream=codec_name,width,height",
      "-of",
      "json",
      full,
    ]);
    log({ recording: full, probe: JSON.parse(probe.stdout) });
  }
  assert(!events.some((event) => event.event?.includes("failed")));
  log({ passed: true, liveDaemon: "untouched" });
} finally {
  await host?.close();
  // Only this script's private socket/session. Never the live browser.
  const { AGENT_BROWSER_PROFILE: _unused, ...cleanup } = env;
  await exec("agent-browser", ["close"], { env: { ...cleanup, AGENT_BROWSER_HEADED: "0" }, timeout: 60000 });
  await writeFile(join(root, "evidence.json"), JSON.stringify(events, null, 2));
}
