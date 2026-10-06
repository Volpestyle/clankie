import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
else if (action === "restart" && ${JSON.stringify(restart)} === "fail") print({ ok: false, services: [{ id: target, label: target, ok: false, error: "fixture restart failed" }] }, 1);
else print({ ok: true, services: [{ id: target, label: target, ok: true, state: action === "down" ? "unreachable" : "healthy" }] });
`,
  );
  chmodSync(launcher, 0o755);
}

async function fixture(
  input: {
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
  const digest = input.badChecksum
    ? "0".repeat(64)
    : createHash("sha256").update(readFileSync(archive)).digest("hex");
  const server: Server = createServer((request, response) => {
    const send = (status: number, body: string | Buffer) => {
      response.writeHead(status);
      response.end(body);
    };
    if (request.url === "/api/releases/latest") return send(200, JSON.stringify({ tag_name: "v1.1.0" }));
    if (request.url === "/api/commits/v1.1.0") return send(200, JSON.stringify({ sha: "b".repeat(40) }));
    if (request.url === `/download/v1.1.0/${archiveName}`) return send(200, readFileSync(archive));
    if (request.url === `/download/v1.1.0/${archiveName}.sha256`)
      return send(200, `${digest}  ${archiveName}\n`);
    send(404, "missing");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  cleanup.push(() => server.close());
  const port = (server.address() as { port: number }).port;
  const env = { HOME: home, PATH: process.env.PATH, RELEASE_CALLS: join(home, "calls.jsonl") };
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
  return { home, install, old, updater, settled, calls };
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
