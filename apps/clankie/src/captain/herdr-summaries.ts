import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface HerdrAgentSummary {
  readonly summary: string;
  readonly next?: string;
  readonly at?: string;
}

export interface HerdrSummariesFile {
  readonly at: string;
  readonly agents: Record<string, HerdrAgentSummary>;
}

export function herdrSummariesPath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.HERD_LEAD_SUMMARIES_CACHE?.trim() ||
    join(
      env.HERDR_PLUGIN_STATE_DIR?.trim() || join(homedir(), ".local/state/herdr/plugins/herd-lead"),
      "summaries.json",
    )
  );
}

export function readHerdrSummariesFile(path: string = herdrSummariesPath()): HerdrSummariesFile {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { at?: unknown; agents?: unknown };
    const agents: Record<string, HerdrAgentSummary> = {};
    if (parsed.agents && typeof parsed.agents === "object" && !Array.isArray(parsed.agents)) {
      for (const [pane, value] of Object.entries(parsed.agents as Record<string, unknown>)) {
        if (value === null || typeof value !== "object") continue;
        const row = value as { summary?: unknown; next?: unknown; at?: unknown };
        if (typeof row.summary !== "string" || !row.summary.trim()) continue;
        agents[pane] = {
          summary: row.summary.trim(),
          ...(typeof row.next === "string" && row.next.trim() ? { next: row.next.trim() } : {}),
          ...(typeof row.at === "string" && row.at.trim() ? { at: row.at.trim() } : {}),
        };
      }
    }
    return { at: typeof parsed.at === "string" ? parsed.at : new Date(0).toISOString(), agents };
  } catch {
    return { at: new Date(0).toISOString(), agents: {} };
  }
}

export function upsertHerdrSummaries(
  updates: Record<string, { summary: string; next?: string }>,
  path: string = herdrSummariesPath(),
): HerdrSummariesFile {
  const now = new Date().toISOString();
  const current = readHerdrSummariesFile(path);
  const agents = { ...current.agents };
  for (const [pane, update] of Object.entries(updates)) {
    const summary = update.summary.trim();
    if (!summary) continue;
    agents[pane] = {
      summary,
      ...(update.next?.trim() ? { next: update.next.trim() } : {}),
      at: now,
    };
  }
  const next = { at: now, agents };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
