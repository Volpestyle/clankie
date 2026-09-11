/** Workspace paths for explicit /cd selection; plain startup opens the main global room. */
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { OperatorConversation } from "@clankie/protocol";

/**
 * The workspace represented by `cwd`, or `undefined`
 * for the service repo itself — Clankie's own body is the global conversation's
 * home, not one project among the others.
 */
export function launchWorkspace(cwd: string, repoRoot: string): string | undefined {
  const workspace = workspaceRoot(cwd);
  return workspace === repoRoot || workspace.startsWith(`${repoRoot}${sep}`) ? undefined : workspace;
}

/**
 * A directory's project root: the nearest ancestor holding `.git`, else the
 * directory itself. `/cd src` selects the repository workspace rather than
 * creating a second workspace for its subdirectory.
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
