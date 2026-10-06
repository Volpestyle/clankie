import { execFile } from "node:child_process";
import { chmod, readFile, mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
// Tracked here so both source and bundled launchers install the same guard.
export const MAIN_PUSH_GUARD = `#!/bin/sh
# clankie-main-push-guard v1
while read -r local_ref local_sha remote_ref remote_sha; do
  [ "$remote_ref" = refs/heads/main ] || continue
  if [ "$CLANKIE_MAIN_PUSH_BYPASS" = owner ] && [ -n "$CLANKIE_MAIN_PUSH_REASON" ]; then
    audit=$(git rev-parse --path-format=absolute --git-common-dir)/clankie-main-push-bypass.log
    reason=$(printf '%s' "$CLANKIE_MAIN_PUSH_REASON" | tr '\\n\\r\\t' '   ')
    printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(id -un)" "$remote_ref" "$local_sha" "$reason" >> "$audit" || exit 1
    printf '%s\\n' "Owner bypass: $reason (recorded in $audit)" >&2
    continue
  fi
  printf '%s\\n' 'Direct push to main refused. Commit, push a branch, then:' '  clankie integrate <sha> --push --no-wait' '  clankie integrate status' 'For clankie-app commits, use --app <sha> instead of a positional SHA.' 'Owner-only bypass: CLANKIE_MAIN_PUSH_BYPASS=owner CLANKIE_MAIN_PUSH_REASON="reason" git push ...' >&2
  exit 1
done
exit 0
`;

export interface MainPushGuardReport {
  repository: string;
  status: "installed" | "offered" | "conflict" | "unavailable" | "not_applicable";
  hook?: string;
  detail: string;
  installCommand?: string;
}
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
async function git(repository: string, args: string[]): Promise<string> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return (await execute("git", ["-C", repository, ...args], { env })).stdout.trim();
}

/** Observe the effective hook; never trust a file that core.hooksPath bypasses. */
export async function inspectMainPushGuard(repository: string): Promise<MainPushGuardReport> {
  const report: MainPushGuardReport = {
    repository: resolve(repository),
    status: "not_applicable",
    detail: "Not a clankie or clankie-app Git checkout",
  };
  try {
    const origin = await git(repository, ["remote", "get-url", "origin"]);
    if (!/(?:^|[/:])clankie(?:-app)?(?:\.git)?$/u.test(origin)) return report;
    report.installCommand = `clankie doctor --install-main-guard ${quote(report.repository)}`;
    const hooksPath = await git(repository, ["config", "--get", "core.hooksPath"]).catch(
      (error: { code?: number }) => {
        if (error.code === 1) return "";
        throw error;
      },
    );
    const conflict = {
      ...report,
      status: "conflict" as const,
      detail: "Existing hook or core.hooksPath needs owner review; nothing was replaced",
    };
    const hook = await git(repository, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "hooks/pre-push",
    ]).catch((error) => {
      if (hooksPath) return undefined;
      throw error;
    });
    if (!hook) return conflict;
    report.hook = hook;
    const contents = await readFile(hook, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
      throw error;
    });
    if (contents === MAIN_PUSH_GUARD) {
      // Git ignores non-executable hooks on Unix.
      const { access, constants } = await import("node:fs/promises");
      const executable = await access(hook, constants.X_OK).then(
        () => true,
        () => false,
      );
      return {
        ...report,
        status: executable ? "installed" : "offered",
        detail: executable ? "Direct main pushes guarded" : "Guard needs executable permission",
      };
    }
    if (hooksPath || contents !== undefined) return { ...conflict, hook };
    return {
      ...report,
      status: "offered",
      detail: "Ready to install with owner approval; linked worktrees share this hook",
    };
  } catch (error) {
    return { ...report, status: "unavailable", detail: String(error) };
  }
}

/** Explicit doctor setup action. Default doctor is read-only; existing hooks are preserved. */
export async function installMainPushGuard(repository: string): Promise<MainPushGuardReport> {
  const report = await inspectMainPushGuard(repository);
  if (report.status === "installed") return report;
  if (report.status !== "offered" || !report.hook) throw Error(report.detail);
  await mkdir(dirname(report.hook), { recursive: true });
  try {
    const file = await open(report.hook, "wx", 0o755);
    try {
      await file.writeFile(MAIN_PUSH_GUARD);
      await file.sync();
    } finally {
      await file.close();
    }
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "EEXIST" ||
      (await readFile(report.hook, "utf8")) !== MAIN_PUSH_GUARD
    )
      throw error;
  }
  await chmod(report.hook, 0o755);
  return inspectMainPushGuard(repository);
}
