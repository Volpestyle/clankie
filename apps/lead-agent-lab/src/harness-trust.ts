import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Pre-trust seeding for consumer-harness TUIs (VUH-829).
 *
 * First launch of a consumer TUI in an unknown directory raises a folder-trust
 * dialog that needs a human Enter — which breaks the arm's zero-assist
 * requirement. Each harness persists folder trust in its own store; seeding
 * that store for the candidate directory before launch means the dialog never
 * appears, instead of being answered by a screen-scrape nudge after the fact.
 *
 * Every seed is recorded as a receipt in the run report and undone at the end
 * of the run. Candidate directories are fresh mkdtemp paths, so a seeded entry
 * never collides with real operator trust state; cleanup removes only entries
 * this run created and leaves pre-existing trust untouched.
 */

export interface PreTrustReceipt {
  harness: "claude" | "codex" | "grok";
  store: string;
  action: "seeded" | "already-trusted" | "no-trust-surface";
  detail?: string;
}

export interface PreTrustResult {
  receipts: PreTrustReceipt[];
  /** Reverts exactly the entries this call created. Safe to call once. */
  cleanup: () => Promise<void>;
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/** Atomic same-directory replace so a concurrent reader never sees a torn file. */
async function writeFileAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.herdr-harness-${process.pid}.tmp`;
  await writeFile(temp, contents, "utf8");
  await rename(temp, path);
}

/**
 * Claude Code stores per-project trust in `~/.claude.json` under
 * `projects[<absolute path>].hasTrustDialogAccepted` (plus an onboarding flag
 * that gates the same first-launch flow).
 */
export async function preTrustClaude(
  candidate: string,
  configPath: string = join(homedir(), ".claude.json"),
): Promise<{ receipt: PreTrustReceipt; undo: () => Promise<void> }> {
  const raw = await readFileOrNull(configPath);
  const config: any = raw === null ? {} : JSON.parse(raw);
  if (typeof config.projects !== "object" || config.projects === null) config.projects = {};
  const existing = config.projects[candidate];
  if (existing?.hasTrustDialogAccepted === true) {
    return {
      receipt: { harness: "claude", store: configPath, action: "already-trusted" },
      undo: async () => undefined,
    };
  }
  const createdEntry = existing === undefined;
  config.projects[candidate] = {
    ...existing,
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
  };
  await writeFileAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return {
    receipt: {
      harness: "claude",
      store: configPath,
      action: "seeded",
      detail: createdEntry ? "created project entry" : "set trust flags on existing entry",
    },
    undo: async () => {
      // Re-read: a live Claude session may have rewritten the file meanwhile.
      const current = await readFileOrNull(configPath);
      if (current === null) return;
      const parsed: any = JSON.parse(current);
      if (typeof parsed.projects !== "object" || parsed.projects === null) return;
      if (createdEntry) {
        delete parsed.projects[candidate];
      } else if (parsed.projects[candidate] !== undefined) {
        parsed.projects[candidate] = {
          ...parsed.projects[candidate],
          hasTrustDialogAccepted: existing?.hasTrustDialogAccepted ?? false,
          hasCompletedProjectOnboarding: existing?.hasCompletedProjectOnboarding ?? false,
        };
      }
      await writeFileAtomic(configPath, `${JSON.stringify(parsed, null, 2)}\n`);
    },
  };
}

function codexProjectHeader(candidate: string): string {
  return `[projects."${candidate}"]`;
}

function codexTrustBlock(candidate: string): string {
  return `\n${codexProjectHeader(candidate)}\ntrust_level = "trusted"\n`;
}

/**
 * Codex stores folder trust in `~/.codex/config.toml` as
 * `[projects."<absolute path>"]` / `trust_level = "trusted"` — the same shape
 * Codex itself appends when the operator answers its trust prompt.
 */
export async function preTrustCodex(
  candidate: string,
  configPath: string = join(homedir(), ".codex/config.toml"),
): Promise<{ receipt: PreTrustReceipt; undo: () => Promise<void> }> {
  const raw = (await readFileOrNull(configPath)) ?? "";
  if (raw.includes(codexProjectHeader(candidate))) {
    return {
      receipt: { harness: "codex", store: configPath, action: "already-trusted" },
      undo: async () => undefined,
    };
  }
  const block = codexTrustBlock(candidate);
  await writeFileAtomic(configPath, raw + block);
  return {
    receipt: {
      harness: "codex",
      store: configPath,
      action: "seeded",
      detail: "appended trusted project block",
    },
    undo: async () => {
      const current = await readFileOrNull(configPath);
      if (current === null || !current.includes(block)) return;
      await writeFileAtomic(configPath, current.replace(block, ""));
    },
  };
}

/**
 * Seed folder trust for every consumer harness the arm launches. Grok exposes
 * no folder-trust store (its `~/.grok/projects/` holds MCP state only) and the
 * arm already launches it with `--always-approve`, so it is recorded as having
 * no trust surface rather than silently skipped.
 */
export async function preTrustHarnesses(
  candidate: string,
  options: { claudeConfigPath?: string; codexConfigPath?: string } = {},
): Promise<PreTrustResult> {
  const claude = await preTrustClaude(candidate, options.claudeConfigPath);
  const codex = await preTrustCodex(candidate, options.codexConfigPath);
  const receipts: PreTrustReceipt[] = [
    claude.receipt,
    codex.receipt,
    {
      harness: "grok",
      store: "none",
      action: "no-trust-surface",
      detail: "no folder-trust store found; launched with --always-approve",
    },
  ];
  return {
    receipts,
    cleanup: async () => {
      await claude.undo();
      await codex.undo();
    },
  };
}
