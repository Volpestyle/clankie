import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  WorkConventionSchema,
  type WorkBackendKind,
  type WorkConvention,
  type WorkSignal,
} from "@clankie/protocol/work-items";

/**
 * Where a repo tracks work (ADR 0191): discovered from what it already does,
 * recorded once in `.clankie/tracking.json`, then followed by every agent.
 */

export const CONVENTION_FILE = ".clankie/tracking.json";
export const DEFAULT_WORK_DIRECTORY = ".clankie/work";

/** Runs a command in the repo; resolves stdout, rejects on failure. Injected so tests never touch git or the network. */
export type CommandRunner = (command: string, args: readonly string[], cwd: string) => Promise<string>;

export async function readConvention(root: string): Promise<WorkConvention | undefined> {
  let text: string;
  try {
    text = await readFile(join(root, CONVENTION_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return WorkConventionSchema.parse(JSON.parse(text));
}

export async function writeConvention(root: string, convention: WorkConvention): Promise<void> {
  const parsed = WorkConventionSchema.parse(convention);
  await mkdir(join(root, ".clankie"), { recursive: true });
  const path = join(root, CONVENTION_FILE);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

const INSTRUCTION_FILES = [
  "CLAUDE.md",
  "AGENTS.md",
  "README.md",
  "CONTRIBUTING.md",
  ".github/copilot-instructions.md",
  "docs/README.md",
];
const ITEM_DIRECTORIES = [
  "docs/tasks",
  "docs/work",
  "docs/todo",
  "docs/issues",
  "docs/backlog",
  "tasks",
  ".tasks",
  "work",
];
/** Prefixes that look like issue keys but are versions, standards or model names. */
const DENIED_KEYS = new Set([
  "ADR",
  "UTF",
  "RFC",
  "ISO",
  "HTTP",
  "SHA",
  "MD",
  "CVE",
  "PR",
  "TLS",
  "ES",
  "GPT",
  "GROK",
  "CLAUDE",
  "GEMINI",
  "LLAMA",
  "QWEN",
  "KIMI",
  "OPUS",
  "SONNET",
  "HAIKU",
  "ARM",
  "AMD",
  "WIN",
  "IOS",
  "MACOS",
]);
const TODO_FILES = ["TODO.md", "TODO", "docs/TODO.md"];
const DECISION_DIRECTORIES = ["docs/adr", "docs/adrs", "docs/decisions", "adr", "decisions"];

function markdownCount(path: string): number {
  try {
    if (!statSync(path).isDirectory()) return 0;
    return readdirSync(path).filter((name) => name.endsWith(".md") && !/^readme\.md$/iu.test(name)).length;
  } catch {
    return 0;
  }
}

/** Markdown files under a directory, bounded so discovery stays cheap in large repos. */
function markdownUnder(directory: string, root: string, limit = 400): { file: string; text: string }[] {
  const found: { file: string; text: string }[] = [];
  const walk = (current: string, depth: number) => {
    if (found.length >= limit || depth > 4) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= limit) return;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".md"))
        found.push({ file: relative(root, path), text: readText(path) });
    }
  };
  walk(directory, 0);
  return found;
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export interface Discovery {
  readonly signals: WorkSignal[];
  /** The convention to record, when discovery is unambiguous. */
  readonly suggestion?: Omit<WorkConvention, "decidedAt">;
  /** The one question for the owner, when it is not. */
  readonly question?: string;
}

async function quiet(run: CommandRunner | undefined, command: string, args: readonly string[], cwd: string) {
  if (run === undefined) return "";
  try {
    return await run(command, args, cwd);
  } catch {
    return "";
  }
}

/** Reads what the repo already does. Never writes. */
export async function discoverConvention(root: string, run?: CommandRunner): Promise<Discovery> {
  const signals: WorkSignal[] = [];

  // Linear: a project linked from the agent instructions or docs, issue links
  // in the docs, and issue keys on commits and branches. The key cited most,
  // by distinct issue numbers, is the team. A key repeating one number is a
  // version or a model name ("GROK-4"), not a tracker.
  const instructions = INSTRUCTION_FILES.map((file) => ({ file, text: readText(join(root, file)) }));
  const documents = [...instructions, ...markdownUnder(join(root, "docs"), root)];
  const projectLink = documents
    .map(({ file, text }) => ({
      file,
      match: /https:\/\/linear\.app\/[\w-]+\/project\/([\w-]+)/u.exec(text),
    }))
    .find((entry) => entry.match !== null);
  const issueNumbers = new Map<string, Set<string>>();
  const cite = (key: string, number: string) => {
    if (DENIED_KEYS.has(key)) return;
    issueNumbers.set(key, (issueNumbers.get(key) ?? new Set()).add(number));
  };
  let linkedIssues = 0;
  for (const { text } of documents)
    for (const match of text.matchAll(/https:\/\/linear\.app\/[\w-]+\/issue\/([A-Za-z]{2,6})-(\d{1,6})/gu)) {
      linkedIssues += 1;
      cite(match[1]!.toUpperCase(), match[2]!);
    }
  for (const match of (await quiet(run, "git", ["log", "-200", "--format=%s"], root)).matchAll(
    /\b([A-Z]{2,6})-(\d{1,6})\b/gu,
  ))
    cite(match[1]!, match[2]!);
  for (const match of (await quiet(run, "git", ["branch", "-a", "--format=%(refname:short)"], root)).matchAll(
    /(?:^|\/)([a-z]{2,6})-(\d{1,6})-/gmu,
  ))
    cite(match[1]!.toUpperCase(), match[2]!);
  const [team, numbers] = [...issueNumbers.entries()]
    .map(([key, set]) => [key, set.size] as const)
    .sort((a, b) => b[1] - a[1])[0] ?? [undefined, 0];
  const namedInInstructions = instructions.some(({ text }) => /\bLinear\b/u.test(text));
  if (
    projectLink !== undefined ||
    linkedIssues > 0 ||
    (team !== undefined && numbers >= 5 && namedInInstructions)
  ) {
    signals.push({
      kind: "linear",
      detail: [
        projectLink === undefined ? undefined : `${projectLink.file} links a Linear project`,
        linkedIssues === 0 ? undefined : `docs link ${String(linkedIssues)} Linear issues`,
        team === undefined
          ? undefined
          : `${String(numbers)} distinct ${team}-* issues cited in docs, commits or branches`,
      ]
        .filter(Boolean)
        .join("; "),
      suggests: {
        backend: "linear",
        ...(team === undefined
          ? {}
          : {
              linear: {
                team,
                ...(projectLink?.match?.[1] === undefined ? {} : { project: projectLink.match[1] }),
              },
            }),
      },
    });
  }

  // GitHub: issues actually in use on the origin repo.
  const origin = (await quiet(run, "git", ["remote", "get-url", "origin"], root)).trim();
  const repo = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/u.exec(origin)?.[1];
  if (repo !== undefined) {
    const sample = await quiet(
      run,
      "gh",
      [
        "api",
        `repos/${repo}/issues?state=all&per_page=100`,
        "--jq",
        "[.[] | select(.pull_request == null)] | length",
      ],
      root,
    );
    const count = Number(sample.trim());
    if (Number.isFinite(count) && count > 0) {
      signals.push({
        kind: "github",
        detail: `${repo} has ${count >= 100 ? "100+" : String(count)} GitHub issues`,
        suggests: { backend: "github", github: { repo } },
      });
    }
  }

  // The repo's own one-file-per-item directory.
  for (const directory of ITEM_DIRECTORIES) {
    const count = markdownCount(join(root, directory));
    if (count > 0)
      signals.push({
        kind: "markdown",
        detail: `${directory}/ holds ${String(count)} Markdown item files`,
        suggests: { backend: "markdown", directory },
      });
  }
  const existingDefault = markdownCount(join(root, DEFAULT_WORK_DIRECTORY));
  if (existingDefault > 0)
    signals.push({
      kind: "markdown",
      detail: `${DEFAULT_WORK_DIRECTORY}/ already holds ${String(existingDefault)} items`,
      suggests: { backend: "default" },
    });

  const todo = TODO_FILES.find((file) => existsSync(join(root, file)));
  if (todo !== undefined) signals.push({ kind: "todo_file", detail: `${todo} is a single task list` });

  const decisions = DECISION_DIRECTORIES.find((directory) => markdownCount(join(root, directory)) > 0);
  if (decisions !== undefined)
    signals.push({ kind: "adr", detail: `${decisions}/ records decisions`, suggests: { decisions } });

  const trackers = signals.filter((signal) => signal.suggests?.backend !== undefined);
  const withDecisions = <T extends object>(value: T) =>
    decisions === undefined ? value : { ...value, decisions };
  if (trackers.length === 1) {
    const only = trackers[0]!.suggests!;
    if (only.backend === "linear" && only.linear === undefined)
      return {
        signals,
        question:
          "This repo points at Linear but no issue key shows up in its history. Which Linear team (and project) should its work go in?",
      };
    return {
      signals,
      suggestion: withDecisions({
        schemaVersion: 1 as const,
        backend: only.backend as WorkBackendKind,
        ...(only.directory === undefined ? {} : { directory: only.directory }),
        ...(only.github === undefined ? {} : { github: only.github }),
        ...(only.linear === undefined ? {} : { linear: only.linear }),
        decidedBy: "discovery" as const,
      }),
    };
  }
  if (trackers.length > 1)
    return {
      signals,
      question: `This repo tracks work in more than one place (${trackers
        .map((signal) => signal.detail)
        .join("; ")}). Which one should Clankie and his workers use?`,
    };
  if (todo !== undefined)
    return {
      signals,
      question: `${todo} is a single task list, which cannot hold per-item criteria and evidence. Keep using it by hand and track agent work in .clankie/work/, or somewhere else?`,
    };
  return {
    signals,
    suggestion: withDecisions({
      schemaVersion: 1 as const,
      backend: "default" as const,
      decidedBy: "discovery" as const,
    }),
  };
}
