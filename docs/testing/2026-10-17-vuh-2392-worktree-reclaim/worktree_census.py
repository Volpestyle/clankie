"""VUH-2392 one-time worktree census and reclaim for the clankie core and app repos.

census: write candidates and exclusions (with reasons) as JSON; removes nothing.
remove: re-verify each candidate from a fresh census, archive ignored .local evidence,
        then `git worktree remove` (never --force), and finally `git worktree prune`.
"""

import json
import os
import shutil
import subprocess
import sys
import time

HOME = "/Users/james"
REPOS = {"core": f"{HOME}/dev/clankie", "app": f"{HOME}/dev/clankie-app"}
WAVE_PREFIX = f"{HOME}/dev/clankie-wt/vuh-23"
NAMED_EXCLUDES = [f"{HOME}/dev/clankie-wt/{name}" for name in ("vuh-2379", "vuh-1728", "vuh-2209")]
RUNTIME_ROOTS = [f"{HOME}/.clankie"]  # pinned, updates/*/previous, runtimes, integration batches
HARNESS_ROOTS = ["/.claude/worktrees/"]  # Claude Code isolation worktrees; the harness owns them
RECENT_SECONDS = 24 * 3600
ENV = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}


def git(path, *args, check=True):
    result = subprocess.run(
        ["git", "--no-optional-locks", "-C", path, *args],
        capture_output=True,
        text=True,
        env=ENV,
        timeout=120,
    )
    if check and result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} in {path}: {result.stderr.strip()[:300]}")
    return result


def inside(root, path):
    root = root.rstrip("/")
    return path == root or path.startswith(root + "/")


def real(path):
    try:
        return os.path.realpath(path)
    except OSError:
        return path


def pane_census():
    out = subprocess.run(["herdr", "pane", "list"], capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        raise RuntimeError("herdr pane list failed")
    panes = json.loads(out.stdout)["result"]["panes"]
    paths = set()
    for pane in panes:
        for key in ("cwd", "foreground_cwd"):
            if pane.get(key):
                paths.add(real(pane[key]))
    return sorted(paths), len(panes)


def cwd_census():
    cwd = subprocess.run(["lsof", "-n", "-w", "-a", "-d", "cwd", "-Fn"], capture_output=True, text=True, timeout=300)
    cwds = {real(line[1:]) for line in cwd.stdout.splitlines() if line.startswith("n/")}
    if not cwds:
        raise RuntimeError("process cwd census empty")
    return cwds


def process_census():
    # Every process cwd, plus every open regular file/dir under the worktree parents.
    cwd = subprocess.run(["lsof", "-n", "-w", "-a", "-d", "cwd", "-Fn"], capture_output=True, text=True, timeout=300)
    cwds = {real(line[1:]) for line in cwd.stdout.splitlines() if line.startswith("n/")}
    files = subprocess.run(["lsof", "-n", "-w", "-Fn"], capture_output=True, text=True, timeout=600)
    opened = {line[1:] for line in files.stdout.splitlines() if line.startswith(f"n{HOME}/dev/")}
    if not cwds:
        raise RuntimeError("process cwd census empty")
    return sorted(cwds), sorted(opened)


def inventory(repo):
    raw = git(repo, "worktree", "list", "--porcelain", "-z").stdout
    records = []
    for record in raw.split("\0\0"):
        fields = [f for f in record.split("\0") if f]
        if not fields:
            continue
        entry = {"locked": False, "prunable": False, "bare": False}
        for field in fields:
            if field.startswith("worktree "):
                entry["path"] = field[9:]
            elif field.startswith("HEAD "):
                entry["sha"] = field[5:]
            elif field.startswith("branch "):
                entry["branch"] = field[7:].removeprefix("refs/heads/")
            elif field == "bare":
                entry["bare"] = True
            elif field.startswith("locked"):
                entry["locked"] = True
            elif field.startswith("prunable"):
                entry["prunable"] = True
        records.append(entry)
    return records


def stashes(repo):
    out = git(repo, "stash", "list", "--format=%H%x00%P%x00%gs").stdout
    result = []
    for line in out.splitlines():
        sha, parents, subject = line.split("\0")
        result.append({"sha": sha, "parent": parents.split()[0] if parents else "", "subject": subject})
    return result


def gitdir_of(path):
    out = git(path, "rev-parse", "--path-format=absolute", "--git-dir").stdout.strip()
    return out


def last_activity(path, gitdir):
    stamps = []
    for candidate in (path, os.path.join(gitdir, "index"), os.path.join(gitdir, "HEAD"), os.path.join(gitdir, "logs", "HEAD")):
        try:
            stamps.append(os.stat(candidate).st_mtime)
        except OSError:
            pass
    return max(stamps) if stamps else None


def reflog_shas(gitdir):
    try:
        with open(os.path.join(gitdir, "logs", "HEAD"), encoding="utf8", errors="replace") as handle:
            shas = set()
            for line in handle:
                parts = line.split(" ", 2)
                if len(parts) >= 2:
                    shas.update(parts[:2])
            return shas
    except OSError:
        return set()


EVIDENCE_PREFIXES = ("docs/testing/", "artifacts/", ".tmp/", ".claude/", "evals/")


def ignored_of_value(path):
    """Ignored paths that may be evidence or source rather than reinstallable output."""
    out = git(path, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z").stdout
    flagged = []
    for item in (p for p in out.split("\0") if p):
        parts = item.rstrip("/").split("/")
        if parts[0] == ".local":
            continue  # moved into the evidence archive before removal
        if item.startswith(EVIDENCE_PREFIXES) or "/docs/testing/" in item:
            flagged.append(item)
        elif item.endswith("/") and len(parts) == 2 and parts[0] in ("apps", "packages", "integrations"):
            flagged.append(item)  # a whole workspace package is ignored: not ordinary build output
        elif item.endswith("/") and os.path.exists(os.path.join(path, item, ".git")):
            flagged.append(item)  # nested repository
    return flagged


def census():
    now = time.time()
    panes, pane_count = pane_census()
    cwds, opened = process_census()
    registered = []
    data = {"generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)), "repos": {}}
    for name, repo in REPOS.items():
        git(repo, "fetch", "-q", "origin")
        registered.extend(e["path"] for e in inventory(repo))
    for name, repo in REPOS.items():
        main = git(repo, "rev-parse", "--verify", "origin/main^{commit}").stdout.strip()
        entries = inventory(repo)
        stash_list = stashes(repo)
        candidates, excluded = [], []
        for index, entry in enumerate(entries):
            path = entry["path"]
            reason = None
            detail = None
            if index == 0 or entry["bare"]:
                reason = "main_worktree"
            elif any(inside(root, path) for root in RUNTIME_ROOTS):
                reason = "managed_runtime_or_integration"
            elif path.startswith(WAVE_PREFIX) or any(inside(root, path) for root in NAMED_EXCLUDES):
                reason = "named_exclusion_active_wave"
            elif any(marker in path + "/" for marker in HARNESS_ROOTS):
                reason = "harness_isolation_worktree"
            elif entry["locked"]:
                reason = "locked"
            elif entry["prunable"]:
                reason = "prunable_missing_directory"
            elif any(other != path and inside(path, other) for other in registered):
                reason = "nested_worktree"
            elif any(inside(path, pane) for pane in panes):
                reason = "live_pane_cwd"
            elif any(inside(path, cwd) for cwd in cwds):
                reason = "live_process_cwd"
            elif any(inside(path, item) for item in opened):
                reason = "open_file"
            else:
                try:
                    if real(path) != path or not os.path.isfile(os.path.join(path, ".git")):
                        raise RuntimeError("worktree_unverified")
                    head = git(path, "rev-parse", "--verify", "HEAD^{commit}").stdout.strip()
                    if head != entry.get("sha"):
                        raise RuntimeError("head_changed")
                    gitdir = gitdir_of(path)
                    status = git(path, "status", "--porcelain=v1", "-z", "--untracked-files=all").stdout
                    ancestor = git(path, "merge-base", "--is-ancestor", head, main, check=False).returncode
                    seen = reflog_shas(gitdir) | {head}
                    held_stash = [
                        s["sha"]
                        for s in stash_list
                        if s["parent"] in seen
                        or (entry.get("branch") and (f"On {entry['branch']}:" in s["subject"] or f"WIP on {entry['branch']}:" in s["subject"]))
                    ]
                    activity = last_activity(path, gitdir)
                    if status:
                        reason = "dirty_or_untracked"
                        detail = f"{status.count(chr(0))} entries"
                    elif ancestor == 1:
                        reason = "unpushed_commits"
                        detail = git(path, "rev-list", "--count", f"{main}..{head}").stdout.strip() + " commits not in origin/main"
                    elif ancestor != 0:
                        raise RuntimeError("merge_base_failed")
                    elif held_stash:
                        reason = "stash"
                        detail = ",".join(held_stash)
                    elif activity is None or now - activity < RECENT_SECONDS:
                        reason = "recent_activity_24h"
                    elif flagged := ignored_of_value(path):
                        reason = "ignored_files_of_possible_value"
                        detail = ", ".join(flagged[:6]) + (f" (+{len(flagged) - 6})" if len(flagged) > 6 else "")
                    else:
                        local = os.path.join(path, ".local")
                        candidates.append(
                            {
                                "path": path,
                                "sha": head,
                                **({"branch": entry["branch"]} if entry.get("branch") else {}),
                                "lastActivity": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(activity)),
                                "hasLocal": os.path.isdir(local) and not os.path.islink(local),
                            }
                        )
                        continue
                except Exception as error:  # noqa: BLE001 - every unknown keeps the tree
                    reason = "unverified"
                    detail = str(error)[:200]
            excluded.append({"path": path, "reason": reason, **({"detail": detail} if detail else {})})
        data["repos"][name] = {
            "repository": repo,
            "originMain": main,
            "registered": len(entries),
            "candidates": candidates,
            "excluded": excluded,
        }
    # Core and app trees often pair as siblings (the app reads ../clankie/packages/protocol).
    # Keep a candidate whose sibling tree in the other repo is retained, so that pair still builds.
    for _ in range(2):
        for name, other in (("core", "app"), ("app", "core")):
            mine = data["repos"][name]
            theirs = data["repos"][other]
            pair = {"clankie", "clankie-app", "app"}
            kept_parents = {
                os.path.dirname(e["path"]) for e in theirs["excluded"] if os.path.basename(e["path"]) in pair
            }
            survivors = []
            for candidate in mine["candidates"]:
                if os.path.basename(candidate["path"]) in pair and os.path.dirname(candidate["path"]) in kept_parents:
                    mine["excluded"].append({"path": candidate["path"], "reason": "paired_with_retained_sibling"})
                else:
                    survivors.append(candidate)
            mine["candidates"] = survivors
    data["census"] = {"panes": pane_count, "paneDirectories": len(panes), "processCwds": len(cwds), "openFilesUnderDev": len(opened)}
    return data


def remove(plan_path, evidence_root, log_path):
    plan = json.load(open(plan_path, encoding="utf8"))
    fresh = census()
    log = []
    removals = 0
    cwds = set()
    for name, repo in REPOS.items():
        planned = {c["path"]: c for c in plan["repos"][name]["candidates"]}
        current = {c["path"]: c for c in fresh["repos"][name]["candidates"]}
        for path, candidate in planned.items():
            now_candidate = current.get(path)
            if not now_candidate or now_candidate["sha"] != candidate["sha"]:
                why = next((e for e in fresh["repos"][name]["excluded"] if e["path"] == path), {"reason": "gone"})
                log.append({"repo": name, "path": path, "outcome": "kept", "reason": why.get("reason")})
                continue
            # Re-check the live census for this tree immediately before removal.
            panes, _ = pane_census()
            if any(inside(path, pane) for pane in panes):
                log.append({"repo": name, "path": path, "outcome": "kept", "reason": "live_pane_cwd"})
                continue
            if removals % 10 == 0:
                cwds = cwd_census()
            if any(inside(path, cwd) for cwd in cwds):
                log.append({"repo": name, "path": path, "outcome": "kept", "reason": "live_process_cwd"})
                continue
            if git(path, "status", "--porcelain=v1", "-z", "--untracked-files=all").stdout:
                log.append({"repo": name, "path": path, "outcome": "kept", "reason": "dirty_or_untracked"})
                continue
            if git(path, "rev-parse", "--verify", "HEAD^{commit}").stdout.strip() != candidate["sha"]:
                log.append({"repo": name, "path": path, "outcome": "kept", "reason": "head_changed"})
                continue
            archived = None
            local = os.path.join(path, ".local")
            if os.path.isdir(local) and not os.path.islink(local):
                archived = os.path.join(evidence_root, name, path.removeprefix(HOME + "/").replace("/", "__"), ".local")
                os.makedirs(os.path.dirname(archived), mode=0o700, exist_ok=False)
                # Same APFS volume: a rename keeps every byte and costs no copy.
                os.rename(local, archived)
            removals += 1
            result = git(repo, "worktree", "remove", path, check=False)
            if result.returncode and archived and os.path.isdir(path) and not os.path.exists(local):
                try:
                    os.rename(archived, local)  # the tree stays; so does its evidence
                    archived = None
                except OSError:
                    pass
            log.append(
                {
                    "repo": name,
                    "path": path,
                    "sha": candidate["sha"],
                    "outcome": "removed" if result.returncode == 0 else "kept",
                    **({"reason": result.stderr.strip()[:300]} if result.returncode else {}),
                    **({"archivedLocal": archived} if archived else {}),
                }
            )
            with open(log_path, "w", encoding="utf8") as handle:
                json.dump(log, handle, indent=1)
        git(repo, "worktree", "prune")
    with open(log_path, "w", encoding="utf8") as handle:
        json.dump(log, handle, indent=1)
    return log


if __name__ == "__main__":
    if sys.argv[1] == "census":
        result = census()
        with open(sys.argv[2], "w", encoding="utf8") as handle:
            json.dump(result, handle, indent=1)
        for name, repo in result["repos"].items():
            reasons = {}
            for entry in repo["excluded"]:
                reasons[entry["reason"]] = reasons.get(entry["reason"], 0) + 1
            print(name, "registered", repo["registered"], "candidates", len(repo["candidates"]), reasons)
        print(result["census"])
    elif sys.argv[1] == "remove":
        log = remove(sys.argv[2], sys.argv[3], sys.argv[4])
        outcomes = {}
        for entry in log:
            outcomes[entry["outcome"]] = outcomes.get(entry["outcome"], 0) + 1
        print(outcomes)
