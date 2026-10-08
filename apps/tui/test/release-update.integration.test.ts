import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createReleaseUpdater } from "../bin/release-updater.ts";
import { readRuntimeUpdate, writeRuntimeUpdate, type RuntimeUpdateResult } from "../bin/runtime-update.ts";
import { DeployHolds } from "../../clankie/src/deploy-holds.ts";
import { RuntimeCanary } from "../../clankie/src/runtime-canary.ts";
import { createRuntimeHealthSampler } from "../../clankie/src/runtime-health-sample.ts";
import { createRuntimeUpdateRoutes } from "../../clankie/src/runtime-update-routes.ts";
import { createBearerAuthenticator } from "../../clankie/src/app/http-auth.ts";
import { writePrivateJson } from "../bin/update-files.ts";
import { runUpdateCommand } from "../src/command/update.ts";
import { startScheduledUpdates } from "../../clankie/src/scheduled-update.ts";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((step) => step()));
const authority = { guard: async () => {}, current: () => true };
const helperPath = resolve(import.meta.dirname, "../bin/release-update-helper.ts");

/** A release whose own `bin/clankie` answers the supervisor calls an update makes. */
function writeRelease(
  root: string,
  version: string,
  revision: string,
  restart: "ok" | "fail" = "ok",
  replaceCurrentOnDown = false,
  target?: string,
  runtimeProviderApi?: number,
) {
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "VERSION"), `${version}\n`);
  writeFileSync(
    join(root, "release.json"),
    JSON.stringify({
      schemaVersion: 1,
      version,
      revision,
      ...(target === undefined ? {} : { target }),
      ...(runtimeProviderApi === undefined ? {} : { runtimeProviderApi }),
    }),
  );
  const launcher = join(root, "bin", "clankie");
  writeFileSync(
    launcher,
    `#!${process.execPath}
const { appendFileSync, realpathSync, rmSync, symlinkSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { randomUUID } = require("node:crypto");
const root = realpathSync(join(dirname(realpathSync(process.argv[1])), ".."));
const [action, target] = process.argv.slice(2);
appendFileSync(process.env.RELEASE_CALLS, JSON.stringify({ root, action, target, operation: process.env.CLANKIE_UPDATE_OPERATION }) + "\\n");
const print = (value, code = 0) => { process.stdout.write(JSON.stringify(value)); process.exitCode = code; };
if (action === "down" && ${JSON.stringify(replaceCurrentOnDown)}) {
  const current = join(dirname(dirname(root)), "current");
  rmSync(current);
  symlinkSync(join("releases", "v1.2.0"), current);
}
if (action === "update") print({ runtime: { root, commit: ${JSON.stringify(revision)}, instanceId: randomUUID(), pid: process.pid } });
else if (action === "harness") print({ ok: true });
else if (action === "pair") print({ ok: true, localCompanion: true });
else if (action === "restart" && ${JSON.stringify(restart)} === "fail") print({ ok: false, services: [{ id: target, label: target, ok: false, error: "fixture restart failed" }] }, 1);
else print({ ok: true, services: [{ id: target, label: target, ok: true, state: action === "down" ? "unreachable" : "healthy" }] });
`,
  );
  chmodSync(launcher, 0o755);
}

async function fixture(
  input: {
    readonly app?: boolean;
    readonly badAppChecksum?: boolean;
    readonly noApp?: boolean;
    readonly restart?: "ok" | "fail";
    readonly badChecksum?: boolean;
    readonly replaceCurrentOnDown?: "old" | "new";
    /** The installed release's target; older releases record none (macOS). */
    readonly target?: string;
    /** The target the published archive's manifest claims, when it differs. */
    readonly publishedTarget?: string;
    /** The provider API the published release expects, and what the installed provider serves. */
    readonly publishedProviderApi?: number;
    readonly providerApis?: readonly number[];
    /** A managed body's fleet answer; absent for a self-run body. */
    readonly approved?: string | null;
  } = {},
) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "clankie-release-update-")));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const install = join(home, "install");
  const old = join(install, "releases", "v1.0.0");
  writeRelease(old, "v1.0.0", "a".repeat(40), "ok", input.replaceCurrentOnDown === "old", input.target);
  writeRelease(join(install, "releases", "v1.2.0"), "v1.2.0", "c".repeat(40));
  symlinkSync(join("releases", "v1.0.0"), join(install, "current"));
  mkdirSync(join(home, ".clankie"), { mode: 0o700 });
  // The published archive, exactly as install.sh downloads and verifies it.
  const published = join(home, "published");
  writeRelease(
    join(published, "clankie"),
    "v1.1.0",
    "b".repeat(40),
    input.restart,
    input.replaceCurrentOnDown === "new",
    input.publishedTarget ?? input.target,
    input.publishedProviderApi,
  );
  const archiveName = `clankie-${input.target ?? "darwin-arm64"}.tar.gz`;
  const archive = join(home, archiveName);
  execFileSync("tar", ["-czf", archive, "-C", published, "clankie"]);
  let digest = input.badChecksum
    ? "0".repeat(64)
    : createHash("sha256").update(readFileSync(archive)).digest("hex");
  let publishedVersion = "v1.1.0";
  let publishedCommit = "b".repeat(40);
  const server: Server = createServer((request, response) => {
    const send = (status: number, body: string | Buffer) => {
      response.writeHead(status);
      response.end(body);
    };
    if (request.url === "/app.tar.gz") return send(200, readFileSync(join(home, "app.tar.gz")));
    if (request.url === "/api/releases/latest")
      return send(200, JSON.stringify({ tag_name: publishedVersion }));
    if (request.url === `/api/commits/${publishedVersion}`)
      return send(200, JSON.stringify({ sha: publishedCommit }));
    if (request.url === `/download/${publishedVersion}/${archiveName}`)
      return send(200, readFileSync(archive));
    if (request.url === `/download/${publishedVersion}/${archiveName}.sha256`)
      return send(200, `${digest}  ${archiveName}\n`);
    send(404, "missing");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  cleanup.push(() => server.close());
  const port = (server.address() as { port: number }).port;
  const applications = join(home, "Applications");
  if (input.noApp) writeFileSync(join(install, "app-policy.json"), '{"disabled":true}');
  if (input.app) {
    const appSource = join(home, "app-source");
    mkdirSync(join(appSource, "Clankie.app/Contents/MacOS"), { recursive: true });
    writeFileSync(join(appSource, "Clankie.app/Contents/Info.plist"), "fixture app plist");
    writeFileSync(join(appSource, "Clankie.app/Contents/MacOS/Clankie"), "fixture executable");
    execFileSync("tar", ["-czf", join(home, "app.tar.gz"), "-C", appSource, "Clankie.app"]);
    const sha256 = input.badAppChecksum
      ? "0".repeat(64)
      : createHash("sha256")
          .update(readFileSync(join(home, "app.tar.gz")))
          .digest("hex");
    const pinRoot = join(published, "clankie/scripts/release");
    mkdirSync(pinRoot, { recursive: true });
    writeFileSync(
      join(pinRoot, "mac-app.json"),
      JSON.stringify({
        schemaVersion: 1,
        app: { version: "v1.0.0", url: `http://127.0.0.1:${port}/app.tar.gz`, sha256 },
      }),
    );
    execFileSync("tar", ["-czf", archive, "-C", published, "clankie"]);
    digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
  }
  const commands = join(home, "commands");
  mkdirSync(commands);
  writeFileSync(join(commands, "open"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(commands, "open"), 0o755);
  const env = {
    CLANKIE_APPLICATIONS_DIR: applications,
    HOME: home,
    PATH: `${commands}:${process.env.PATH}`,
    RELEASE_CALLS: join(home, "calls.jsonl"),
  };
  const updater = (releaseRoot: string) =>
    createReleaseUpdater({
      releaseRoot,
      env,
      helperPath,
      ...(input.providerApis === undefined ? {} : { providerApis: input.providerApis }),
      ...(input.approved === undefined ? {} : { approvedRelease: async () => input.approved! }),
      source: { api: `http://127.0.0.1:${port}/api`, download: `http://127.0.0.1:${port}/download` },
    });
  const settled = async (id: string): Promise<RuntimeUpdateResult> => {
    const directory = join(home, ".clankie", "updates", id);
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const result = readRuntimeUpdate(directory);
      if (!["scheduled", "installing", "stopping", "activating", "restarting"].includes(result.phase))
        return result;
      await new Promise((done) => setTimeout(done, 100));
    }
    throw Error(`Release update did not settle:\n${readFileSync(join(directory, "helper.log"), "utf8")}`);
  };
  const calls = () =>
    existsSync(env.RELEASE_CALLS)
      ? readFileSync(env.RELEASE_CALLS, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  const publishNext = () => {
    publishedVersion = "v1.2.0";
    publishedCommit = "c".repeat(40);
    writeRelease(join(published, "clankie"), publishedVersion, publishedCommit);
    execFileSync("tar", ["-czf", archive, "-C", published, "clankie"]);
    digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
  };
  return { home, install, old, updater, settled, calls, applications, publishNext };
}

it("updates a release install to the latest official release and then reports it current", async () => {
  const f = await fixture();
  const accepted = await f.updater(f.old).request("main", authority);
  expect(accepted).toMatchObject({
    accepted: true,
    latest: {
      ref: "latest",
      oldCommit: "a".repeat(40),
      newCommit: "b".repeat(40),
      versions: { old: "v1.0.0", new: "v1.1.0" },
    },
  });
  const result = await f.settled(accepted.pending!);
  expect(result).toMatchObject({ phase: "healthy", healthy: true, canary: { state: "pending" } });
  expect(result.harnessRefresh?.ok).toBe(true);
  expect(readlinkSync(join(f.install, "current"))).toBe(join("releases", "v1.1.0"));
  const next = realpathSync(join(f.install, "releases", "v1.1.0"));
  expect(JSON.parse(readFileSync(join(next, "release.json"), "utf8")).revision).toBe("b".repeat(40));
  // The old release stops through its own launcher; the new one starts through its own.
  const calls = f.calls();
  expect(
    calls.filter((call) => call.action === "down").every((call) => call.root === realpathSync(f.old)),
  ).toBe(true);
  expect(calls.filter((call) => call.action === "restart").every((call) => call.root === next)).toBe(true);
  expect(calls.every((call) => call.operation === accepted.pending)).toBe(true);
  // Once its canary passes, the new release is already the latest official one.
  writeRuntimeUpdate(join(f.home, ".clankie", "updates", accepted.pending!), {
    ...result,
    canary: { state: "passed", holdReleased: true },
  });
  expect(await f.updater(next).request("main", authority)).toMatchObject({ accepted: false, upToDate: true });
});

it("updates a Linux release install from its own target's archive", async () => {
  const f = await fixture({ target: "linux-arm64" });
  const accepted = await f.updater(f.old).request("main", authority);
  expect(accepted).toMatchObject({ accepted: true });
  expect(await f.settled(accepted.pending!)).toMatchObject({ phase: "healthy", healthy: true });
  const next = realpathSync(join(f.install, "releases", "v1.1.0"));
  expect(JSON.parse(readFileSync(join(next, "release.json"), "utf8")).target).toBe("linux-arm64");
});

it("refuses an archive built for another target before stopping anything", async () => {
  const f = await fixture({ target: "linux-arm64", publishedTarget: "linux-x64" });
  const accepted = await f.updater(f.old).request("main", authority);
  const result = await f.settled(accepted.pending!);
  expect(result).toMatchObject({ phase: "failed", reason: "pre-cutover-failed" });
  expect(result.error).toContain("another target");
  expect(readlinkSync(join(f.install, "current"))).toBe(join("releases", "v1.0.0"));
  expect(f.calls().filter((call) => call.action === "down")).toEqual([]);
});

it("refuses a release the installed runtime provider cannot serve before stopping anything", async () => {
  const f = await fixture({ publishedProviderApi: 2, providerApis: [1] });
  const accepted = await f.updater(f.old).request("main", authority);
  expect(await f.settled(accepted.pending!)).toMatchObject({
    phase: "refused",
    reason: "provider-api-unsupported",
  });
  expect(readlinkSync(join(f.install, "current"))).toBe(join("releases", "v1.0.0"));
  expect(f.calls().filter((call) => call.action === "down")).toEqual([]);
});

it("installs a release whose provider API the installed provider serves", async () => {
  const f = await fixture({ publishedProviderApi: 2, providerApis: [1, 2] });
  const accepted = await f.updater(f.old).request("main", authority);
  expect(await f.settled(accepted.pending!)).toMatchObject({ phase: "healthy" });
});

it("a managed body installs the fleet-approved release and nothing newer", async () => {
  const held = await fixture({ approved: null });
  await expect(held.updater(held.old).request("main", authority)).rejects.toThrow("holding releases");
  const current = await fixture({ approved: "v1.0.0" });
  expect(await current.updater(current.old).request("main", authority)).toMatchObject({
    accepted: false,
    upToDate: true,
  });
  await expect(current.updater(current.old).request("v1.1.0", authority)).rejects.toThrow(
    "not approved for this body",
  );
  const approved = await fixture({ approved: "v1.1.0" });
  const accepted = await approved.updater(approved.old).request("main", authority);
  expect(await approved.settled(accepted.pending!)).toMatchObject({ phase: "healthy" });
  expect(readlinkSync(join(approved.install, "current"))).toBe(join("releases", "v1.1.0"));
});

it("a hosted body's scheduled check installs only while idle and enabled", async () => {
  const logger = { info() {}, warn() {} };
  const schedule = (
    updater: ReturnType<Awaited<ReturnType<typeof fixture>>["updater"]>,
    state: { enabled: boolean; idle: boolean },
  ) => {
    const scheduled = startScheduledUpdates({
      updater,
      enabled: async () => state.enabled,
      idle: async () => state.idle,
      logger,
      initialDelayMs: 3_600_000,
    });
    cleanup.push(() => scheduled.close());
    return scheduled;
  };
  const held = await fixture({ approved: null });
  expect(await schedule(held.updater(held.old), { enabled: true, idle: true }).check()).toBe("waiting");

  const f = await fixture();
  const state = { enabled: false, idle: false };
  const scheduled = schedule(f.updater(f.old), state);
  expect(await scheduled.check()).toBe("disabled");
  state.enabled = true;
  expect(await scheduled.check()).toBe("body-busy");
  expect(f.calls()).toEqual([]);
  state.idle = true;
  expect(await scheduled.check()).toBe("accepted");
  const pending = JSON.parse(readFileSync(join(f.home, ".clankie", "updates", "latest.json"), "utf8")).id;
  const result = await f.settled(pending);
  expect(result).toMatchObject({ phase: "healthy", initiator: { kind: "schedule" } });
  expect(readlinkSync(join(f.install, "current"))).toBe(join("releases", "v1.1.0"));
});

it("restores the previous release when the new one fails to come up", async () => {
  const f = await fixture({ restart: "fail" });
  const accepted = await f.updater(f.old).request("main", authority);
  const result = await f.settled(accepted.pending!);
  expect(result).toMatchObject({ phase: "rolled-back", reason: "cutover-failed", rollbackHealthy: true });
  expect(result.error).toContain("failed health checks");
  expect(readlinkSync(join(f.install, "current"))).toBe(join("releases", "v1.0.0"));
  expect(f.calls().at(-1)).toMatchObject({ action: "update", root: realpathSync(f.old) });
});

it("refuses an archive whose checksum does not verify before stopping anything", async () => {
  const f = await fixture({ badChecksum: true });
  const accepted = await f.updater(f.old).request("main", authority);
  const result = await f.settled(accepted.pending!);
  expect(result).toMatchObject({ phase: "failed", reason: "pre-cutover-failed" });
  expect(result.error).toContain("checksum");
  expect(readlinkSync(join(f.install, "current"))).toBe(join("releases", "v1.0.0"));
  expect(existsSync(join(f.install, "releases", "v1.1.0"))).toBe(false);
  expect(f.calls()).toEqual([]);
});

it.each(["guard rejects", "authority expires"])(
  "cleans unaccepted release preparation when %s",
  async (failure) => {
    const f = await fixture();
    const updater = f.updater(f.old);
    let guards = 0;
    await expect(
      updater.request("main", {
        guard: async () => {
          guards += 1;
          if (guards === 2 && failure === "guard rejects") throw Error("revoked preparation");
        },
        current: () => !(guards === 2 && failure === "authority expires"),
      }),
    ).rejects.toThrow(failure === "guard rejects" ? "revoked preparation" : "authority expired");
    expect(existsSync(join(f.home, ".clankie", "updates", "active"))).toBe(false);
    expect(updater.status().pending).toBeUndefined();
    expect(f.calls()).toEqual([]);
    expect(readlinkSync(join(f.install, "current"))).toBe(join("releases", "v1.0.0"));
    const accepted = await updater.request("main", authority);
    expect(accepted.accepted).toBe(true);
    expect(await f.settled(accepted.pending!)).toMatchObject({ phase: "healthy" });
  },
);

it("retains another release selected while the old services stop", async () => {
  const f = await fixture({ replaceCurrentOnDown: "old" });
  const accepted = await f.updater(f.old).request("main", authority);
  expect(await f.settled(accepted.pending!)).toMatchObject({
    phase: "refused",
    reason: "current-release-changed",
  });
  expect(readlinkSync(join(f.install, "current"))).toBe(join("releases", "v1.2.0"));
  expect(f.calls().filter((call) => call.action === "restart")).toEqual([]);
});

it("retains another release selected while the failed new services stop", async () => {
  const f = await fixture({ restart: "fail", replaceCurrentOnDown: "new" });
  const accepted = await f.updater(f.old).request("main", authority);
  expect(await f.settled(accepted.pending!)).toMatchObject({
    phase: "refused",
    reason: "current-release-changed",
  });
  expect(readlinkSync(join(f.install, "current"))).toBe(join("releases", "v1.2.0"));
  expect(
    f
      .calls()
      .filter((call) => call.action === "restart")
      .map((call) => call.root),
  ).toEqual([realpathSync(join(f.install, "releases", "v1.1.0"))]);
});

it("release helper installs the pinned fixture app and prepares a private handoff", async () => {
  const f = await fixture({ app: true });
  const accepted = await f.updater(f.old).request("main", authority);
  expect(await f.settled(accepted.pending!)).toMatchObject({ phase: "healthy" });
  expect(readFileSync(join(f.applications, "Clankie.app/Contents/MacOS/Clankie"), "utf8")).toContain(
    "fixture",
  );
  expect(f.calls()).toContainEqual(expect.objectContaining({ action: "pair", target: "--local-companion" }));
  expect(
    JSON.parse(readFileSync(join(f.home, ".clankie/updates", accepted.pending!, "app-handoff.json"), "utf8")),
  ).toEqual({ paired: true });
});

it.each([{ noApp: true }, { target: "linux-arm64" }])(
  "release helper skips the app for %j",
  async (input) => {
    const f = await fixture({ app: true, ...input });
    const accepted = await f.updater(f.old).request("main", authority);
    expect(await f.settled(accepted.pending!)).toMatchObject({ phase: "healthy" });
    expect(existsSync(join(f.applications, "Clankie.app"))).toBe(false);
    expect(f.calls().filter((call) => call.action === "pair")).toEqual([]);
  },
);

it("app checksum mismatch aborts a release before runtime cutover", async () => {
  const f = await fixture({ app: true, badAppChecksum: true });
  const accepted = await f.updater(f.old).request("main", authority);
  const result = await f.settled(accepted.pending!);
  expect(result).toMatchObject({ phase: "failed", reason: "pre-cutover-failed" });
  expect(result.error).toContain("Mac app checksum");
  expect(readlinkSync(join(f.install, "current"))).toBe(join("releases", "v1.0.0"));
  expect(f.calls()).toEqual([]);
  expect(existsSync(join(f.applications, "Clankie.app"))).toBe(false);
});

it("failed runtime health leaves the staged app uninstalled", async () => {
  const f = await fixture({ app: true, restart: "fail" });
  const accepted = await f.updater(f.old).request("main", authority);
  expect(await f.settled(accepted.pending!)).toMatchObject({ phase: "rolled-back" });
  expect(existsSync(join(f.applications, "Clankie.app"))).toBe(false);
  expect(existsSync(join(f.applications, ".clankie-app-install.lock"))).toBe(false);
});

it("failed canary → owner override deploy → passing canary → next deploy schedules without an override", async () => {
  const f = await fixture();
  const updates = join(f.home, ".clankie", "updates");
  const holds = new DeployHolds(join(f.home, "integration"));
  const failedId = randomUUID();
  mkdirSync(join(updates, failedId), { recursive: true, mode: 0o700 });
  mkdirSync(join(updates, "active"), { mode: 0o700 });
  writePrivateJson(join(updates, "active", "operation.json"), { id: failedId });
  writePrivateJson(join(updates, "latest.json"), { id: failedId });
  writePrivateJson(join(updates, "canary-policy.json"), {
    windowMs: 1000,
    sampleIntervalMs: 400,
    cpuPercent: 10000,
    healthLatencyMs: 1000,
  });
  writeRuntimeUpdate(join(updates, failedId), {
    id: failedId,
    ref: "main",
    oldCommit: "9".repeat(40),
    newCommit: "a".repeat(40),
    phase: "healthy",
    healthy: true,
    canary: { state: "pending" },
    updatedAt: new Date().toISOString(),
  });
  let updater = f.updater(f.old);
  let healthy = false;
  const authenticate = createBearerAuthenticator("fixture-owner", { operatorId: "fixture-owner" });
  let routes = createRuntimeUpdateRoutes({
    updater,
    holds,
    authorize: async (request) => {
      const actor = await authenticate(request);
      return actor ? { ...authority, initiator: { kind: "cli", operatorId: actor.operatorId } } : undefined;
    },
  });
  const server = createServer(async (request, response) => {
    if (request.url === "/health") {
      response.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: healthy, service: "clankie", runtime: updater.runtime }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const result = await routes.request(request.url!, {
      method: request.method ?? "GET",
      headers: { authorization: request.headers.authorization ?? "", "content-type": "application/json" },
      ...(chunks.length ? { body: Buffer.concat(chunks).toString("utf8") } : {}),
    });
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(await result.text());
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const host = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let canary: RuntimeCanary;
  const observe = async (state: "failed" | "passed") => {
    canary = new RuntimeCanary({
      updatesDirectory: updates,
      runtime: updater.runtime,
      holds,
      sample: createRuntimeHealthSampler({ healthUrl: `${host}/health` }),
    });
    await canary.recover();
    canary.start();
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const result = updater.status().latest!;
      if (
        result.canary?.state === state &&
        (state === "failed" ? result.canary.holdEstablished : result.canary.holdReleased)
      )
        return result;
      await new Promise((done) => setTimeout(done, 50));
    }
    throw Error(`Canary did not finish: ${JSON.stringify(updater.status())}`);
  };
  const cli = { host, env: { CLANKIE_OPERATOR_TOKEN: "fixture-owner" } };
  try {
    const failed = await observe("failed");
    await canary!.close();
    expect(failed.canary!.samples).toBe(0);
    expect(updater.status().pending).toBeUndefined();
    expect(await holds.list()).toMatchObject([{ id: failedId }]);
    expect(await runUpdateCommand([], cli)).toMatchObject({ error: "update_refused" });
    const override = (await runUpdateCommand(
      ["--override-holds", "--reason", "Reviewed failed health; try replacement"],
      cli,
    )) as { accepted: boolean; pending: string };
    expect(override.accepted).toBe(true);
    expect(await holds.list()).toMatchObject([{ id: failedId }]);
    expect(
      JSON.parse(readFileSync(join(updates, override.pending, "overridden-holds.json"), "utf8")),
    ).toMatchObject([{ id: failedId }]);
    expect(await f.settled(override.pending)).toMatchObject({
      phase: "healthy",
      canary: { state: "pending" },
    });
    updater = f.updater(join(f.install, "releases", "v1.1.0"));
    healthy = true;
    const passed = await observe("passed");
    await canary!.close();
    expect(passed.canary!.samples).toBeGreaterThanOrEqual(2);
    expect(
      Date.parse(passed.canary!.completedAt!) - Date.parse(passed.canary!.startedAt!),
    ).toBeGreaterThanOrEqual(1000);
    expect(await holds.list()).toEqual([]);
    expect(updater.status().pending).toBeUndefined();
    expect(readRuntimeUpdate(join(updates, failedId)).canary!.state).toBe("failed");
    const events = JSON.parse(readFileSync(join(f.home, "integration", "holds.json"), "utf8")).events;
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "override",
          actor: "fixture-owner",
          hold: expect.objectContaining({ id: failedId }),
        }),
        expect.objectContaining({ action: "release", hold: expect.objectContaining({ id: failedId }) }),
      ]),
    );
    f.publishNext();
    routes = createRuntimeUpdateRoutes({
      updater,
      holds,
      authorize: async (request) => ((await authenticate(request)) ? authority : undefined),
    });
    const next = (await runUpdateCommand([], cli)) as { accepted: boolean; pending: string };
    expect(next.accepted).toBe(true);
    expect(next.pending).not.toBe(override.pending);
    expect(await f.settled(next.pending)).toMatchObject({ newCommit: "c".repeat(40), phase: "healthy" });
  } finally {
    await canary!.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
}, 30000);
