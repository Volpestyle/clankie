import { savedSessionHarness } from "../agent-sessions.ts";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { CodexAccount } from "@clankie/settings";
import type { WorkerAccountStatus } from "./harness-accounts.ts";
import type { SavedAgentSession } from "../agent-sessions.ts";
import type { HerdrFleet } from "../herdr-fleet.ts";
import type { HerdrAgentSnapshot } from "./herdr-watch.ts";

/** A friendly host id alone never proves which machine owns a transcript. */
export function savedSessionFleet(
  session: SavedAgentSession,
  requested: string | undefined,
  fleets: readonly HerdrFleet[],
  namedLocal: readonly { id: string }[] = [],
): string | undefined {
  if (session.host === "local") {
    if (requested !== undefined) {
      if (namedLocal.some((entry) => entry.id === requested)) return requested;
      throw new Error("A local transcript cannot be resumed on a remote fleet");
    }
    return undefined;
  }
  const host = session.host;
  const matches = fleets.filter((fleet) => fleet.ssh.host === host.ssh && fleet.ssh.shell === host.shell);
  const fleet =
    requested === undefined
      ? matches.length === 1
        ? matches[0]
        : undefined
      : matches.find((candidate) => candidate.id === requested);
  if (!fleet)
    throw new Error("Select a registered Herdr fleet with the transcript host's exact SSH target and shell");
  return fleet.id;
}

export function nativeSessionId(agent: HerdrAgentSnapshot): string | undefined {
  const session = agent.session;
  if (!session) return undefined;
  if (session.kind === "id") return session.value;
  // Claude/Pi transcript paths and Codex rollout paths carry the UUID at the end.
  return /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:\.jsonl)?$/iu.exec(session.value)?.[1];
}

/** An uncertain launch stays visible with this label until its identity is known. */
export const resumePaneLabel = (session: SavedAgentSession): string => `Resume ${session.sessionId}`;

export function existingNativeSession(
  panes: readonly HerdrAgentSnapshot[],
  session: SavedAgentSession,
): HerdrAgentSnapshot | undefined {
  const sameHarness = (pane: HerdrAgentSnapshot) =>
    pane.session?.source === `herdr:${savedSessionHarness(session)}` ||
    pane.agent === savedSessionHarness(session);
  const matches = panes.filter(
    (pane) =>
      sameHarness(pane) &&
      (session.source
        ? nativeSessionId(pane) === session.sessionId
        : nativeSessionId(pane)?.toLowerCase() === session.sessionId.toLowerCase()),
  );
  if (matches.length > 1)
    throw new Error("Several live panes hold this session; select the existing seat explicitly");
  if (matches.length === 1) return matches[0];
  if (
    panes.some(
      (pane) =>
        pane.title === resumePaneLabel(session) ||
        (sameHarness(pane) &&
          pane.session === undefined &&
          pane.workingDirectory === session.workingDirectory),
    )
  )
    throw new Error(
      "A pane may already hold this session but has not reported its identity; inspect it before resuming",
    );
  return undefined;
}

/** The original registered Codex home owns the history; headroom is irrelevant to resumption. */
export async function savedCodexAccount(
  session: SavedAgentSession,
  accounts: readonly CodexAccount[],
  requested?: string,
): Promise<CodexAccount> {
  if (session.source) throw new Error("Native database history is not a Codex account transcript");
  const path = await realpath(session.file.path);
  const matches: CodexAccount[] = [];
  for (const account of accounts) {
    const root = await realpath(`${account.home}/sessions`).catch(() => undefined);
    if (root === undefined) continue;
    const part = relative(root, path);
    if (part !== "" && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part))
      matches.push(account);
  }
  if (matches.length !== 1 || (requested !== undefined && matches[0]!.label !== requested))
    throw new Error("Resume requires the registered Codex account that owns this transcript");
  return matches[0]!;
}

/**
 * The signed-in Claude profile home whose projects hold this transcript. Claude
 * resumes only from its own config home, so the launch must use exactly that
 * home; another account or profile is never tried.
 */
export async function savedClaudeAccount(
  session: SavedAgentSession,
  accounts: readonly WorkerAccountStatus[],
  requested?: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<WorkerAccountStatus> {
  if (session.source) throw new Error("Native database history is not a Claude profile transcript");
  const path = await realpath(session.file.path);
  const matches: { account: WorkerAccountStatus; home: string }[] = [];
  for (const account of accounts) {
    if (account.harness !== "claude") continue;
    for (const { home } of account.homes ?? [{ home: account.home }]) {
      const root = await realpath(join(home, "projects")).catch(() => undefined);
      if (root === undefined) continue;
      const part = relative(root, path);
      if (part !== "" && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part))
        matches.push({ account, home });
    }
  }
  if (matches.length !== 1)
    throw new Error(
      matches.length === 0
        ? "No signed-in Claude profile on this Mac owns this transcript; no other profile was tried"
        : "Several Claude profiles claim this transcript; no profile was tried",
    );
  const { account, home } = matches[0]!;
  if (
    requested !== undefined &&
    requested !== account.label &&
    requested !== account.accountKey &&
    !account.aliases?.includes(requested)
  )
    throw new Error("Saved Claude session belongs to a different or unregistered account profile");
  if (!account.usable)
    throw new Error(`The Claude profile that owns this transcript cannot resume it: ${account.reason}`);
  // As the account probe reads it: only ~/.claude with no CLAUDE_CONFIG_DIR naming
  // it is the native default, which must launch with the variable unset (VUH-2241).
  const standard = await realpath(join(homedir(), ".claude")).catch(() => undefined);
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  const nativeDefault =
    home === standard && (!configured || (await realpath(configured).catch(() => configured)) !== standard);
  const { nativeDefault: _chosen, ...status } = account;
  return { ...status, home, ...(nativeDefault ? { nativeDefault: true as const } : {}) };
}

/** Native TUI flags only. No print/exec runner and no fork flag. */
export function nativeResumeArgs(session: SavedAgentSession): readonly string[] {
  if (session.source)
    throw new Error(
      "OpenCode resume needs original controller/exit proof; stored history is not launch authority",
    );
  switch (session.file.harness) {
    case "claude":
    case "grok":
      return ["--resume", session.sessionId];
    case "codex":
      return ["resume", session.sessionId];
    case "pi":
      return ["--session", session.file.path];
    case "prime":
      return ["--resume", session.sessionId];
  }
}
