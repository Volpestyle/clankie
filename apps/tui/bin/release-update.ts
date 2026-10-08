/** Release-install cutover: stage an official release beside the running one, then switch `current`. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { boundedString, commitString, object, operationId } from "./update-files.ts";
import {
  errorText,
  parseHarnessRefresh,
  withHarnessRefreshDiagnostics,
  parseServiceReceipt,
  parseUpdateInitiator,
  writeRuntimeUpdate,
  type RuntimeServiceReceipt,
  type RuntimeUpdateInitiator,
  type RuntimeUpdateResult,
} from "./runtime-update.ts";

/** Releases built before targets were recorded are all macOS arm64. */
const DEFAULT_RELEASE_TARGET = "darwin-arm64";
const TARGET = /^(darwin-arm64|linux-arm64|linux-x64)$/u;

function releaseTarget(value: unknown): string {
  if (value === undefined) return DEFAULT_RELEASE_TARGET;
  const target = boundedString(value, 32);
  if (!TARGET.test(target)) throw Error("Invalid release target");
  return target;
}

/** Each official release publishes one archive per target. */
export function releaseArchive(target: string): string {
  return `clankie-${releaseTarget(target)}.tar.gz`;
}
const VERSION = /^v[0-9]+\.[0-9]+\.[0-9]+([-.][A-Za-z0-9.]+)?$/u;

export function releaseVersion(value: unknown): string {
  const version = boundedString(value, 64);
  if (!VERSION.test(version)) throw Error("Invalid release version");
  return version;
}

/** Official sources only: HTTPS, or loopback HTTP for a local fixture. */
export function releaseUrl(value: unknown): string {
  const url = new URL(boundedString(value, 2048));
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1"))
    throw Error("Release source must be HTTPS");
  return url.toString();
}

/** A release's own small, owned, regular file; releases are readable, not private. */
function readReleaseFile(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 65_536 || (process.getuid && stat.uid !== process.getuid()))
    throw Error("Invalid release manifest");
  return readFileSync(path, "utf8");
}

/** The identity a release directory declares in its own manifest. */
export function releaseManifest(root: string): {
  readonly version: string;
  readonly revision: string;
  readonly target: string;
  readonly runtimeProviderApi: number;
} {
  const manifest = object(JSON.parse(readReleaseFile(join(root, "release.json"))));
  const version = releaseVersion(manifest.version);
  if (readReleaseFile(join(root, "VERSION")).split("\n")[0] !== version)
    throw Error("Release VERSION does not match its manifest");
  const runtimeProviderApi = manifest.runtimeProviderApi ?? 1;
  if (!Number.isSafeInteger(runtimeProviderApi) || Number(runtimeProviderApi) < 1)
    throw Error("Invalid release provider API");
  return {
    version,
    revision: commitString(manifest.revision),
    target: releaseTarget(manifest.target),
    runtimeProviderApi: Number(runtimeProviderApi),
  };
}

/** `<install>/current` must be a symlink into `<install>/releases/`; returns the release it names. */
export function currentRelease(installRoot: string): string {
  const current = join(installRoot, "current");
  if (!lstatSync(current).isSymbolicLink()) throw Error("Install current is not a symlink");
  const target = realpathSync(current);
  if (dirname(target) !== realpathSync(join(installRoot, "releases")))
    throw Error("Install current points outside its releases");
  return target;
}

/** Point `current` at a release atomically; command links already follow `current`. */
function switchCurrent(installRoot: string, release: string): void {
  const current = join(installRoot, "current");
  const temporary = `${current}.update-${process.pid}`;
  rmSync(temporary, { force: true });
  symlinkSync(join("releases", basename(release)), temporary);
  renameSync(temporary, current);
  if (readlinkSync(current) !== join("releases", basename(release)))
    throw Error("Install current did not switch");
}

export interface ReleaseUpdatePlan {
  readonly kind: "release";
  readonly id: string;
  readonly ref: string;
  readonly home: string;
  readonly directory: string;
  readonly installRoot: string;
  readonly oldRelease: string;
  readonly oldVersion: string;
  readonly newVersion: string;
  readonly oldCommit: string;
  readonly newCommit: string;
  readonly target: string;
  /** The installed runtime provider's API versions; absent without a provider. */
  readonly providerApis?: readonly number[];
  readonly archiveUrl: string;
  readonly checksumUrl: string;
  readonly oldInstanceId: string;
  readonly warning?: "older-than-current-pin";
  readonly initiator?: RuntimeUpdateInitiator;
}

export function parseReleasePlan(input: unknown): ReleaseUpdatePlan {
  const value = object(input);
  if (value.kind !== "release") throw Error("Not a release update plan");
  if (value.warning !== undefined && value.warning !== "older-than-current-pin")
    throw Error("Invalid release update warning");
  return {
    kind: "release",
    id: operationId(value.id),
    ref: boundedString(value.ref, 256),
    home: boundedString(value.home, 4096),
    directory: boundedString(value.directory, 4096),
    installRoot: boundedString(value.installRoot, 4096),
    oldRelease: boundedString(value.oldRelease, 4096),
    oldVersion: releaseVersion(value.oldVersion),
    newVersion: releaseVersion(value.newVersion),
    oldCommit: commitString(value.oldCommit),
    newCommit: commitString(value.newCommit),
    target: releaseTarget(value.target),
    ...(value.providerApis === undefined ? {} : { providerApis: providerApis(value.providerApis) }),
    archiveUrl: releaseUrl(value.archiveUrl),
    checksumUrl: releaseUrl(value.checksumUrl),
    oldInstanceId: operationId(value.oldInstanceId),
    ...(value.warning === undefined ? {} : { warning: "older-than-current-pin" as const }),
    ...(value.initiator === undefined ? {} : { initiator: parseUpdateInitiator(value.initiator) }),
  };
}

function providerApis(value: unknown): readonly number[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 16 ||
    !value.every((api) => Number.isSafeInteger(api) && api > 0)
  )
    throw Error("Invalid provider APIs");
  return value as number[];
}

interface ReleaseUpdatePorts {
  readonly fetchImpl?: typeof fetch;
  /** The release's own supervisor, as `runtimeUpdateServices` drives a checkout. */
  readonly services: (release: string, action: "down" | "restart") => Promise<RuntimeServiceReceipt>;
  readonly refreshHarnesses?: (release: string) => Promise<{ ok: boolean }>;
  readonly now?: () => Date;
}

const exec = promisify(execFile);

async function download(url: string, path: string, fetchImpl: typeof fetch): Promise<void> {
  const response = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(10 * 60_000) });
  if (!response.ok || response.body === null) throw Error(`Release download failed (${response.status})`);
  await pipeline(
    Readable.fromWeb(response.body as never),
    createWriteStream(path, { flags: "wx", mode: 0o600 }),
  );
}

/** Download, verify and unpack exactly as install.sh does; returns the staged `clankie` tree. */
async function stageRelease(plan: ReleaseUpdatePlan, fetchImpl: typeof fetch): Promise<string> {
  const archive = join(plan.directory, releaseArchive(plan.target));
  const checksum = `${archive}.sha256`;
  await download(plan.archiveUrl, archive, fetchImpl);
  await download(plan.checksumUrl, checksum, fetchImpl);
  const expected = readFileSync(checksum, "utf8").trim().split(/\s+/u)[0];
  const actual = createHash("sha256").update(readFileSync(archive)).digest("hex");
  if (!expected || !/^[a-f0-9]{64}$/u.test(expected) || actual !== expected)
    throw Error("Release checksum does not match");
  const { stdout } = await exec("tar", ["-tzf", archive], { maxBuffer: 64 * 1024 * 1024 });
  for (const entry of stdout.split("\n").filter(Boolean))
    if (!/^clankie(\/|$)/u.test(entry) || /(^|\/)\.\.(\/|$)/u.test(entry))
      throw Error("Release archive contains an unsafe path");
  const unpacked = join(plan.directory, "unpacked");
  await mkdir(unpacked, { mode: 0o700 });
  await exec("tar", ["-xzf", archive, "-C", unpacked]);
  const staged = join(unpacked, "clankie");
  const manifest = releaseManifest(staged);
  if (manifest.version !== plan.newVersion || manifest.revision !== plan.newCommit)
    throw Error("Release archive is not the accepted version");
  if (manifest.target !== plan.target) throw Error("Release archive is for another target");
  return staged;
}

export async function executeReleaseUpdate(
  plan: ReleaseUpdatePlan,
  ports: ReleaseUpdatePorts,
): Promise<RuntimeUpdateResult> {
  const serviceReceipts: RuntimeServiceReceipt[] = [];
  const target = join(plan.installRoot, "releases", plan.newVersion);
  const service = async (release: string, action: "down" | "restart", expectedCommit: string) => {
    const receipt = parseServiceReceipt(await ports.services(release, action));
    serviceReceipts.push(receipt);
    if (
      !receipt.ok ||
      !receipt.services.every((entry) => entry.ok) ||
      !receipt.services.some((entry) => entry.id === "clankie")
    )
      return false;
    if (action === "down") return true;
    return (
      receipt.runtime?.root === realpathSync(release) &&
      receipt.runtime.commit === expectedCommit &&
      receipt.runtime.instanceId !== plan.oldInstanceId
    );
  };
  const persist = (phase: RuntimeUpdateResult["phase"], fields: Partial<RuntimeUpdateResult> = {}) => {
    const result: RuntimeUpdateResult = {
      id: plan.id,
      ref: plan.ref,
      oldCommit: plan.oldCommit,
      newCommit: plan.newCommit,
      resolvedRef: `refs/tags/${plan.newVersion}`,
      versions: { old: plan.oldVersion, new: plan.newVersion },
      ...(plan.warning === undefined ? {} : { warning: plan.warning }),
      ...(plan.initiator === undefined ? {} : { initiator: plan.initiator }),
      phase,
      updatedAt: (ports.now?.() ?? new Date()).toISOString(),
      ...(serviceReceipts.length === 0 ? {} : { serviceReceipts: [...serviceReceipts] }),
      ...fields,
    };
    writeRuntimeUpdate(plan.directory, result);
    return result;
  };
  let stopAttempted = false;
  let oldStopped = false;
  let switched = false;
  try {
    if (currentRelease(plan.installRoot) !== plan.oldRelease)
      return persist("refused", { reason: "current-release-changed" });
    persist("installing");
    const staged = await stageRelease(plan, ports.fetchImpl ?? fetch);
    // Managed policy must keep working: never install a release its provider cannot serve.
    if (plan.providerApis && !plan.providerApis.includes(releaseManifest(staged).runtimeProviderApi))
      return persist("refused", { reason: "provider-api-unsupported" });
    if (existsSync(target)) {
      // An earlier install of this version is reused only when it is that exact release.
      if (releaseManifest(target).revision !== plan.newCommit)
        return persist("refused", { reason: "release-directory-conflict" });
    } else renameSync(staged, target);
    rmSync(join(plan.directory, "unpacked"), { recursive: true, force: true });
    if (currentRelease(plan.installRoot) !== plan.oldRelease)
      return persist("refused", { reason: "current-release-changed" });
    persist("stopping");
    stopAttempted = true;
    if (!(await service(plan.oldRelease, "down", plan.oldCommit)))
      return persist("stop-unconfirmed", { reason: "old-services-stop-unconfirmed" });
    oldStopped = true;
    if (currentRelease(plan.installRoot) !== plan.oldRelease)
      return persist("refused", { reason: "current-release-changed" });
    persist("activating");
    switchCurrent(plan.installRoot, target);
    switched = true;
    persist("restarting");
    if (!(await service(target, "restart", plan.newCommit))) throw Error("New services failed health checks");
    let harnessRefresh: RuntimeUpdateResult["harnessRefresh"];
    if (ports.refreshHarnesses) {
      try {
        const result = await ports.refreshHarnesses(target);
        harnessRefresh = parseHarnessRefresh(
          withHarnessRefreshDiagnostics({ ok: result.ok === true, result }, plan.directory),
        );
      } catch (error) {
        harnessRefresh = { ok: false, error: errorText(error) };
      }
    }
    return persist("healthy", {
      healthy: true,
      canary: { state: "pending" },
      ...(harnessRefresh
        ? {
            harnessRefresh,
            ...(harnessRefresh.ok
              ? {}
              : {
                  reason: harnessRefresh.sourceManaged?.length
                    ? "harness-refresh-source-managed"
                    : "harness-refresh-incomplete",
                }),
          }
        : {}),
    });
  } catch (failure) {
    const error = errorText(failure);
    if (!oldStopped)
      return persist(stopAttempted ? "stop-unconfirmed" : "failed", {
        reason: stopAttempted ? "old-services-stop-unconfirmed" : "pre-cutover-failed",
        error,
      });
    try {
      if (switched) {
        if (!(await service(target, "down", plan.newCommit)))
          return persist("stop-unconfirmed", {
            reason: "new-services-stop-unconfirmed",
            error,
            healthy: false,
          });
        if (currentRelease(plan.installRoot) !== target)
          return persist("refused", { reason: "current-release-changed", error, healthy: false });
        switchCurrent(plan.installRoot, plan.oldRelease);
      }
      if (currentRelease(plan.installRoot) !== plan.oldRelease)
        throw Error("Previous release is not current");
      const rollbackHealthy = await service(plan.oldRelease, "restart", plan.oldCommit);
      return persist(rollbackHealthy ? "rolled-back" : "failed", {
        reason: "cutover-failed",
        error,
        healthy: false,
        rollbackHealthy,
      });
    } catch (rollbackFailure) {
      return persist("failed", {
        reason: "rollback-unconfirmed",
        error,
        rollbackError: errorText(rollbackFailure),
        healthy: false,
        rollbackHealthy: false,
      });
    }
  }
}
