/**
 * Which directory a console works in.
 *
 * The `clankie` launcher is a symlink into this repo, so the process it starts
 * always sits in the service repo no matter where it was typed. That is right
 * for the services it spawns and wrong for the operator: launching in a project
 * means "work here". A workspace is that launch directory, carried on the
 * conversation's scope so the captain's session runs its tools there.
 */
import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { OperatorConversation } from "@clankie/protocol";

/**
 * The workspace a console launched in `cwd` should attach to, or `undefined`
 * for the service repo itself — Clankie's own body is the global conversation's
 * home, not one project among the others.
 */
export function launchWorkspace(cwd: string, repoRoot: string): string | undefined {
  const workspace = workspaceRoot(cwd);
  return workspace === repoRoot || workspace.startsWith(`${repoRoot}${sep}`) ? undefined : workspace;
}

/**
 * A directory's project root: the nearest ancestor holding `.git`, else the
 * directory itself. `cd src && clankie` continues the conversation the repo
 * already has rather than opening a second one for the subdirectory.
 */
export function workspaceRoot(dir: string): string {
  const start = resolve(dir);
  let current = start;
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

/**
 * Resolves an operator-typed directory (`~`, relative, or absolute) against the
 * workspace they are currently in. Throws rather than attaching the captain's
 * shell to a path that is not a directory on this machine.
 */
export function resolveWorkspacePath(input: string, base: string): string {
  const home = homedir();
  const expanded = input === "~" ? home : input.startsWith(`~${sep}`) ? join(home, input.slice(2)) : input;
  const absolute = resolve(base, expanded);
  if (statSync(absolute, { throwIfNoEntry: false })?.isDirectory() !== true) {
    throw new Error(`${absolute} is not a directory`);
  }
  return workspaceRoot(realpathSync(absolute));
}

/** The directory a conversation works in; global conversations name none. */
export function conversationWorkspace(conversation: OperatorConversation): string | undefined {
  return conversation.scope.kind === "workspace" ? conversation.scope.workspaceId : undefined;
}

/**
 * A filesystem-safe, human-recognizable key for per-workspace console state.
 * The path itself cannot be a directory name, and a bare basename collides
 * across checkouts of the same project.
 */
export function workspaceStateKey(workspace: string): string {
  const name = workspace.split(sep).filter(Boolean).pop() ?? "workspace";
  const slug = name.replace(/[^a-zA-Z0-9._-]/gu, "-").slice(0, 48);
  return `${slug}-${createHash("sha256").update(workspace).digest("hex").slice(0, 8)}`;
}
