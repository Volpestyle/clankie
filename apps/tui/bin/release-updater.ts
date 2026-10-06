/** Release installs update to official releases; a checkout follows origin/main (runtime-updater.ts). */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, realpathSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  currentRelease,
  releaseArchive,
  releaseManifest,
  releaseUrl,
  releaseVersion,
  type ReleaseUpdatePlan,
} from "./release-update.ts";
import { parseUpdateInitiator, writeRuntimeUpdate, type RuntimeUpdateResult } from "./runtime-update.ts";
import { createUpdateJournal, type RuntimeUpdater } from "./runtime-updater.ts";
import { commitString, object, writePrivateJson } from "./update-files.ts";

/** Where official releases are published: the GitHub API and its download host. */
interface ReleaseSource {
  readonly api: string;
  readonly download: string;
}
const OFFICIAL_RELEASES: ReleaseSource = {
  api: "https://api.github.com/repos/Volpestyle/clankie",
  download: "https://github.com/Volpestyle/clankie/releases/download",
};

export interface ReleaseUpdaterOptions {
  readonly releaseRoot: string;
  /** The installed runtime provider's API versions; a release outside them is refused. */
  readonly providerApis?: readonly number[];
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly source?: ReleaseSource;
  /** The bundled helper inside the running release; checkout tests pass its source. */
  readonly helperPath?: string;
  readonly spawnHelper?: (
    command: string,
    args: readonly string[],
    options: Parameters<typeof spawn>[2],
  ) => ChildProcess;
}

function versionParts(version: string): readonly number[] {
  return version.slice(1).split(/[-.]/u).slice(0, 3).map(Number);
}
function olderThan(candidate: string, current: string): boolean {
  const [a, b] = [versionParts(candidate), versionParts(current)];
  for (let index = 0; index < 3; index += 1)
    if (a[index] !== b[index]) return (a[index] ?? 0) < (b[index] ?? 0);
  return false;
}

export function createReleaseUpdater(options: ReleaseUpdaterOptions): RuntimeUpdater {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const source = options.source ?? OFFICIAL_RELEASES;
  const home = realpathSync(env.HOME || homedir());
  const releaseRoot = realpathSync(options.releaseRoot);
  if (basename(dirname(releaseRoot)) !== "releases") throw Error("Release root is not an installed release");
  const installRoot = dirname(dirname(releaseRoot));
  const manifest = releaseManifest(releaseRoot);
  const helperPath =
    options.helperPath ?? join(releaseRoot, "apps", "tui", "bin", "release-update-helper.js");
  const boot = Object.freeze({
    root: releaseRoot,
    commit: manifest.revision,
    instanceId: randomUUID(),
    pid: process.pid,
  });
  const journal = createUpdateJournal(home, boot, () => {
    const root = currentRelease(installRoot);
    return { root, commit: releaseManifest(root).revision };
  });
  const { updates, lock, initialize, status } = journal;
  const api = async (path: string): Promise<Record<string, unknown>> => {
    const response = await fetchImpl(releaseUrl(`${source.api}${path}`), {
      headers: { accept: "application/vnd.github+json", "user-agent": "clankie-updater" },
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw Error(`Release lookup failed (${response.status})`);
    return object(await response.json());
  };
  /** `main`/`latest` mean the newest official release; `vX.Y.Z` pins one. */
  const resolveRelease = async (ref: string) => {
    const version = ["", "main", "latest"].includes(ref)
      ? releaseVersion((await api("/releases/latest")).tag_name)
      : releaseVersion(ref.replace(/^refs\/tags\//u, ""));
    const commit = commitString((await api(`/commits/${version}`)).sha);
    return { version, commit };
  };
  return {
    runtime: boot,
    status,
    reconcile: journal.reconcile,
    async request(ref, authority) {
      await authority.guard();
      if (!authority.current()) throw Error("Update authority expired");
      initialize();
      if (!journal.admit()) return { ...status(), accepted: false };
      if (currentRelease(installRoot) !== releaseRoot)
        throw Error("Running service is not the current release");
      const target = await resolveRelease(ref);
      if (target.version === manifest.version) return { ...status(), accepted: false, upToDate: true };
      if (!existsSync(helperPath)) throw Error("This release has no update helper");
      const initiator = parseUpdateInitiator(authority.initiator ?? { kind: "operator" });
      const id = randomUUID();
      const directory = join(updates, id);
      const plan: ReleaseUpdatePlan = {
        kind: "release",
        id,
        ref: ["", "main"].includes(ref) ? "latest" : ref,
        home,
        directory,
        installRoot,
        oldRelease: releaseRoot,
        oldVersion: manifest.version,
        newVersion: target.version,
        oldCommit: manifest.revision,
        newCommit: target.commit,
        target: manifest.target,
        ...(options.providerApis === undefined ? {} : { providerApis: options.providerApis }),
        archiveUrl: releaseUrl(`${source.download}/${target.version}/${releaseArchive(manifest.target)}`),
        checksumUrl: releaseUrl(
          `${source.download}/${target.version}/${releaseArchive(manifest.target)}.sha256`,
        ),
        oldInstanceId: boot.instanceId,
        ...(olderThan(target.version, manifest.version)
          ? { warning: "older-than-current-pin" as const }
          : {}),
        initiator,
      };
      mkdirSync(lock, { mode: 0o700 });
      writePrivateJson(join(lock, "operation.json"), { id });
      mkdirSync(directory, { mode: 0o700 });
      let accepted = false;
      try {
        writePrivateJson(join(directory, "plan.json"), plan);
        await authority.guard();
        if (!authority.current()) throw Error("Update authority expired");
        const result: RuntimeUpdateResult = {
          id,
          ref: plan.ref,
          oldCommit: plan.oldCommit,
          newCommit: plan.newCommit,
          resolvedRef: `refs/tags/${plan.newVersion}`,
          versions: { old: plan.oldVersion, new: plan.newVersion },
          ...(plan.warning === undefined ? {} : { warning: plan.warning }),
          initiator,
          phase: "scheduled",
          updatedAt: new Date().toISOString(),
        };
        writeRuntimeUpdate(directory, result);
        writePrivateJson(join(updates, "latest.json"), { id });
        accepted = true;
        const log = openSync(join(directory, "helper.log"), "ax", 0o600);
        try {
          writeSync(log, `${JSON.stringify({ event: "release-update-accepted", ...result })}\n`);
          const helperEnv: NodeJS.ProcessEnv = { ...env };
          for (const name of [
            "PI_SESSION_FILE",
            "PI_SESSION_ID",
            "NODE_OPTIONS",
            "NODE_PATH",
            "CLANKIE_LAUNCHER_PATH",
          ])
            delete helperEnv[name];
          const child = (options.spawnHelper ?? spawn)(process.execPath, [helperPath, directory], {
            cwd: directory,
            env: helperEnv,
            detached: true,
            stdio: ["ignore", log, log],
          });
          child.on("error", () => {
            /* Acceptance is durable; an uncertain spawn is never resent. */
          });
          child.unref();
        } finally {
          closeSync(log);
        }
        return { ...status(), accepted: true };
      } catch (error) {
        if (!accepted) {
          // No helper was scheduled; only this preparation owns this lock.
          if (journal.activeId() === id) rmSync(lock, { recursive: true });
          rmSync(directory, { recursive: true });
          throw error;
        }
        return { ...status(), accepted: true, needsReconciliation: true };
      }
    },
  };
}
