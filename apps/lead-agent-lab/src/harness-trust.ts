import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
 * (and files) this run created and restores pre-existing entries to their
 * prior state.
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
 * `projects[<absolute path>]`. Both the trust-dialog flag AND the project
 * onboarding flag gate the first-launch flow, so "trusted" requires both.
 */
export async function preTrustClaude(
  candidate: string,
  configPath: string = join(homedir(), ".claude.json"),
): Promise<{ receipt: PreTrustReceipt; undo: () => Promise<void> }> {
  const raw = await readFileOrNull(configPath);
  const createdFile = raw === null;
  const config: any = raw === null ? {} : JSON.parse(raw);
  if (typeof config.projects !== "object" || config.projects === null) config.projects = {};
  const existing = config.projects[candidate];
  if (existing?.hasTrustDialogAccepted === true && existing?.hasCompletedProjectOnboarding === true) {
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
      // If this run created the store and nothing else has landed in it since,
      // restore file absence instead of leaving an empty husk behind.
      if (createdFile && Object.keys(parsed).length === 1 && Object.keys(parsed.projects).length === 0) {
        await rm(configPath, { force: true });
        return;
      }
      await writeFileAtomic(configPath, `${JSON.stringify(parsed, null, 2)}\n`);
    },
  };
}

/** TOML basic-string escaping for paths interpolated into table headers. */
function tomlEscape(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function codexProjectHeader(candidate: string): string {
  return `[projects."${tomlEscape(candidate)}"]`;
}

function codexTrustBlock(candidate: string): string {
  return `\n${codexProjectHeader(candidate)}\ntrust_level = "trusted"\n`;
}

/** The table section spans from its header to the next table header or EOF. */
function findCodexSection(raw: string, header: string): { start: number; end: number; text: string } | null {
  const start = raw.indexOf(header);
  if (start === -1) return null;
  const afterHeader = start + header.length;
  const nextTable = raw.slice(afterHeader).search(/^\s*\[/m);
  const end = nextTable === -1 ? raw.length : afterHeader + nextTable;
  return { start, end, text: raw.slice(start, end) };
}

const CODEX_TRUSTED_PATTERN = /^\s*trust_level\s*=\s*"trusted"\s*$/m;
const CODEX_TRUST_LINE_PATTERN = /^(\s*trust_level\s*=\s*).*$/m;

/**
 * Codex stores folder trust in `~/.codex/config.toml` as
 * `[projects."<absolute path>"]` / `trust_level = "trusted"` — the same shape
 * Codex itself appends when the operator answers its trust prompt. A project
 * entry counts as trusted only when its own section says `trust_level =
 * "trusted"`; any other state (missing line, "untrusted", …) is seeded.
 */
export async function preTrustCodex(
  candidate: string,
  configPath: string = join(homedir(), ".codex/config.toml"),
): Promise<{ receipt: PreTrustReceipt; undo: () => Promise<void> }> {
  const raw = await readFileOrNull(configPath);
  const createdFile = raw === null;
  const contents = raw ?? "";
  const header = codexProjectHeader(candidate);
  const section = findCodexSection(contents, header);
  if (section && CODEX_TRUSTED_PATTERN.test(section.text)) {
    return {
      receipt: { harness: "codex", store: configPath, action: "already-trusted" },
      undo: async () => undefined,
    };
  }
  if (section) {
    // Existing entry in a non-trusted state: rewrite only its trust_level line
    // (or add one), and restore the exact original section text on undo.
    const seededSection = CODEX_TRUST_LINE_PATTERN.test(section.text)
      ? section.text.replace(CODEX_TRUST_LINE_PATTERN, '$1"trusted"')
      : `${section.text.replace(/\n*$/, "\n")}trust_level = "trusted"\n`;
    await writeFileAtomic(
      configPath,
      contents.slice(0, section.start) + seededSection + contents.slice(section.end),
    );
    return {
      receipt: {
        harness: "codex",
        store: configPath,
        action: "seeded",
        detail: "set trust_level on existing project section",
      },
      undo: async () => {
        const current = await readFileOrNull(configPath);
        if (current === null) return;
        const nowSection = findCodexSection(current, header);
        // Restore only if the section still matches what this run wrote — a
        // concurrent rewrite of the same section wins over our restoration.
        if (nowSection === null || nowSection.text !== seededSection) return;
        await writeFileAtomic(
          configPath,
          current.slice(0, nowSection.start) + section.text + current.slice(nowSection.end),
        );
      },
    };
  }
  const block = codexTrustBlock(candidate);
  await writeFileAtomic(configPath, contents + block);
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
      const restored = current.replace(block, "");
      if (createdFile && restored.trim() === "") {
        await rm(configPath, { force: true });
        return;
      }
      await writeFileAtomic(configPath, restored);
    },
  };
}

/**
 * Seed folder trust for every consumer harness the arm launches. Grok exposes
 * no folder-trust store (its `~/.grok/projects/` holds MCP state only) and the
 * arm already launches it with `--always-approve`, so it is recorded as having
 * no trust surface rather than silently skipped. Seeding is transactional
 * across stores: if the Codex seed throws, the Claude seed is undone before
 * the error propagates, so a caller never holds a partial, unrevertable seed.
 */
export async function preTrustHarnesses(
  candidate: string,
  options: { claudeConfigPath?: string; codexConfigPath?: string } = {},
): Promise<PreTrustResult> {
  const claude = await preTrustClaude(candidate, options.claudeConfigPath);
  let codex: Awaited<ReturnType<typeof preTrustCodex>>;
  try {
    codex = await preTrustCodex(candidate, options.codexConfigPath);
  } catch (error) {
    await claude.undo().catch(() => undefined);
    throw error;
  }
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
