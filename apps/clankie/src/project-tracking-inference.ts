import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Project } from "@clankie/protocol/projects";
import type { ProjectTrackingSuggestion } from "@clankie/protocol/project-tracking";
import { readConvention } from "@clankie/work-items";
import { createGithubOriginReader } from "./captain/github-origin.ts";

const run = promisify(execFile);
const RECENT_COMMITS = "100";
/** A tracker key must recur: one `SHA-256` in a commit message is not a Linear team. */
const MIN_KEY_MATCHES = 3;

type Provider = "github" | "linear";
interface Signal {
  readonly provider: Provider;
  readonly board?: string;
  readonly detail: string;
}

function commitSignals(log: string, name: string): Signal[] {
  const keys = new Map<string, Set<string>>();
  for (const [, team, number] of log.matchAll(/\b([A-Z][A-Z0-9]{1,9})-(\d+)\b/gu))
    keys.set(team!, (keys.get(team!) ?? new Set()).add(number!));
  const teams = [...keys].filter(([, numbers]) => numbers.size >= MIN_KEY_MATCHES);
  const signals: Signal[] = teams.map(([team, numbers]) => ({
    provider: "linear",
    board: team,
    detail: `${name}: recent commits name ${String(numbers.size)} ${team} keys`,
  }));
  const closes = log.match(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#\d+/giu)?.length ?? 0;
  if (closes >= MIN_KEY_MATCHES)
    signals.push({
      provider: "github",
      detail: `${name}: recent commits close ${String(closes)} GitHub issues`,
    });
  return signals;
}

async function guideSignals(path: string, name: string): Promise<Signal[]> {
  const signals: Signal[] = [];
  for (const file of ["CLAUDE.md", "AGENTS.md"]) {
    const text = await readFile(join(path, file), "utf8").catch(() => "");
    if (/linear\.app\//u.test(text))
      signals.push({ provider: "linear", detail: `${name}: ${file} links Linear` });
    if (/github\.com\/[\w.-]+\/[\w.-]+\/issues/u.test(text))
      signals.push({ provider: "github", detail: `${name}: ${file} links GitHub issues` });
  }
  return signals;
}

async function repoSignals(path: string, name: string): Promise<Signal[]> {
  const signals = await guideSignals(path, name);
  // allow-swallowed-rejection -- an unreadable convention is simply one signal fewer
  const convention = await readConvention(path).catch(() => undefined);
  if (convention?.backend === "github")
    signals.push({
      provider: "github",
      ...(convention.github ? { board: convention.github.repo } : {}),
      detail: `${name}: .clankie/tracking.json says GitHub`,
    });
  if (convention?.backend === "linear")
    signals.push({
      provider: "linear",
      ...(convention.linear ? { board: convention.linear.project ?? convention.linear.team } : {}),
      detail: `${name}: .clankie/tracking.json says Linear`,
    });
  const log = await run("git", ["-C", path, "log", "-n", RECENT_COMMITS, "--format=%B"], {
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  }).then(
    ({ stdout }) => stdout,
    () => "",
  );
  return [...signals, ...commitSignals(log, name)];
}

/**
 * Local reads only, so setup opens with an answer. It stays a suggestion: nothing here saves
 * a setting or writes to a repo. Private work never gets a guessed board, because a wrong
 * guess there would send private work to a public tracker.
 */
export async function suggestProjectTracking(
  project: Project,
): Promise<ProjectTrackingSuggestion | undefined> {
  const origin = createGithubOriginReader();
  const paths = new Set(
    [
      ...project.workspaces.map((workspace) => ({ ...workspace, repoPath: workspace.path })),
      ...project.worktreeRoots,
      ...(project.linkedRepos ?? []).map((repo) => ({ ...repo, repoPath: repo.path })),
    ]
      .filter((entry) => entry.machineId === "local")
      .map((entry) => entry.repoPath),
  );
  const repos = new Set<string>();
  const found: Signal[] = project.linearProjectBinding
    ? [{ provider: "linear", detail: "the project is bound to a Linear project" }]
    : [];
  for (const path of paths) {
    const slug = origin(path);
    if (slug) repos.add(slug);
    found.push(...(await repoSignals(path, slug ?? path)));
  }
  const providers = new Set(found.map((signal) => signal.provider));
  const provider = providers.size === 1 ? [...providers][0] : undefined;
  const saved = project.tracking?.tracker.provider;
  if (saved !== undefined && (provider === undefined || provider === saved)) return undefined;
  const board =
    found.find((signal) => signal.provider === provider && signal.board !== undefined)?.board ??
    (provider === "github" ? [...repos][0] : undefined);
  const question =
    providers.size === 0
      ? "No signal names a tracker. Which tracker and boards does this project use?"
      : providers.size > 1
        ? "The signals name both GitHub and Linear. Which tracker does this project use?"
        : board === undefined
          ? "Which board takes public work, and which takes private work?"
          : "Which board takes private work?";
  return {
    repos: [...repos].slice(0, 32),
    ...(provider === undefined ? {} : { provider }),
    ...(provider === undefined || board === undefined ? {} : { publicBoard: board }),
    signals: found.slice(0, 64).map((signal) => signal.detail),
    question,
    ...(saved === undefined ? {} : { movedFromSetting: true }),
  };
}
