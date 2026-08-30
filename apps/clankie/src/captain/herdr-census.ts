import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { OperatorTerminalSession } from "@clankie/protocol";
import { readHerdrSummariesFile, type HerdrAgentSummary } from "./herdr-summaries.ts";

const execFileAsync = promisify(execFile);

export type HerdrCensusRunner = (
  command: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

export interface HerdrCensusAgent {
  readonly paneId: string;
  readonly agent: string;
  readonly status: string;
  readonly title: string;
  /** Stable across pane-id compaction; the seat identity for ADR 0135. */
  readonly terminalId?: string;
}

export type HerdrSessionCensus =
  | { readonly outcome: "ok"; readonly text: string }
  | { readonly outcome: "unavailable"; readonly error: string };

const CENSUS_TIMEOUT_MS = 5_000;
const MAX_AGENTS = 48;

function defaultRunner(
  command: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, [...args], { timeout: CENSUS_TIMEOUT_MS, maxBuffer: 1024 * 1024 }).then(
    ({ stdout, stderr }) => ({ stdout: String(stdout), stderr: String(stderr) }),
  );
}

function titleOf(pane: Record<string, unknown>): string {
  for (const key of ["title", "terminal_title_stripped", "terminal_title"] as const) {
    const value = pane[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}

export function parseHerdrAgentList(stdout: string): HerdrCensusAgent[] {
  const parsed = JSON.parse(stdout) as { result?: { agents?: unknown } };
  const rows = Array.isArray(parsed.result?.agents) ? parsed.result.agents : [];
  const agents: HerdrCensusAgent[] = [];
  for (const value of rows) {
    if (value === null || typeof value !== "object") continue;
    const pane = value as Record<string, unknown>;
    const paneId = typeof pane.pane_id === "string" ? pane.pane_id : undefined;
    const agent = typeof pane.agent === "string" ? pane.agent : undefined;
    if (paneId === undefined || agent === undefined) continue;
    agents.push({
      paneId,
      agent,
      status: typeof pane.agent_status === "string" ? pane.agent_status : "unknown",
      title: titleOf(pane),
      ...(typeof pane.terminal_id === "string" && pane.terminal_id.length > 0
        ? { terminalId: pane.terminal_id }
        : {}),
    });
  }
  return agents;
}

export function formatHerdrSessionCensus(
  herdrPaneId: string,
  agents: readonly HerdrCensusAgent[],
  summaries: Readonly<Record<string, HerdrAgentSummary>> = {},
): string {
  const counts = new Map<string, number>();
  const lines = [`HERDR SESSION (joined as ${herdrPaneId})`];
  const shown = agents.slice(0, MAX_AGENTS);
  for (const entry of shown) {
    counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
    const mark = entry.paneId === herdrPaneId ? "  <- YOU" : "";
    const title = entry.title.length <= 60 ? entry.title : `${entry.title.slice(0, 59)}…`;
    lines.push(`  ${entry.paneId}  ${entry.agent}  ${entry.status}  ${title}${mark}`);
    const written = summaries[entry.paneId];
    if (written) {
      lines.push(`        summary: ${written.summary}`);
      if (written.next) lines.push(`        next: ${written.next}`);
    }
  }
  if (agents.length > shown.length) lines.push(`  … ${agents.length - shown.length} more agents not listed`);
  const summary = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${count} ${status}`)
    .join(", ");
  lines.push(`  ${agents.length} agents${summary.length === 0 ? "" : ` — ${summary}`}`);
  const done = counts.get("done") ?? 0;
  const blocked = counts.get("blocked") ?? 0;
  if (done > 0) lines.push(`  ${done} done — finished work nobody has read. Harvest first.`);
  if (blocked > 0) lines.push(`  ${blocked} blocked — waiting on a human. Surface those before dispatching.`);
  return lines.join("\n");
}

/** Matches the protocol's OPERATOR_CONVERSATION_SUMMARY_MAX bound. */
const SEAT_SUMMARY_MAX = 512;

function bounded(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function recordMap(values: unknown, idKey: string): Map<string, Record<string, unknown>> {
  if (!Array.isArray(values)) return new Map();
  return new Map(
    values.flatMap((value) => {
      if (value === null || typeof value !== "object") return [];
      const record = value as Record<string, unknown>;
      const id = record[idKey];
      return typeof id === "string" ? [[id, record] as const] : [];
    }),
  );
}

/** Projects one Herdr API snapshot without flattening its workspace hierarchy. */
export function parseHerdrTerminalCatalog(stdout: string): OperatorTerminalSession[] {
  const parsed = JSON.parse(stdout) as { result?: { snapshot?: Record<string, unknown> } };
  const snapshot = parsed.result?.snapshot;
  if (!snapshot) return [];
  const workspaces = recordMap(snapshot.workspaces, "workspace_id");
  const tabs = recordMap(snapshot.tabs, "tab_id");
  const panes = Array.isArray(snapshot.panes)
    ? snapshot.panes
    : Array.isArray(snapshot.agents)
      ? snapshot.agents
      : [];

  return panes.flatMap((value): OperatorTerminalSession[] => {
    if (value === null || typeof value !== "object") return [];
    const pane = value as Record<string, unknown>;
    const terminalId = pane.terminal_id;
    const workspaceId = pane.workspace_id;
    const tabId = pane.tab_id;
    const paneId = pane.pane_id;
    if (
      typeof terminalId !== "string" ||
      typeof workspaceId !== "string" ||
      typeof tabId !== "string" ||
      typeof paneId !== "string"
    )
      return [];
    const workspace = workspaces.get(workspaceId);
    const tab = tabs.get(tabId);
    if (
      typeof workspace?.label !== "string" ||
      typeof workspace.number !== "number" ||
      typeof tab?.label !== "string" ||
      typeof tab.number !== "number"
    )
      return [];
    return [
      {
        terminalId,
        label: bounded(titleOf(pane), 200),
        workspace: { id: workspaceId, label: bounded(workspace.label, 200), number: workspace.number },
        tab: { id: tabId, label: bounded(tab.label, 200), number: tab.number },
        pane: { id: paneId },
      },
    ];
  });
}

/** Bounded observable terminal catalog, in Herdr's native workspace/tab/pane order. */
export async function readTerminalCatalog(
  options: { readonly runCommand?: HerdrCensusRunner } = {},
): Promise<OperatorTerminalSession[]> {
  const run = options.runCommand ?? defaultRunner;
  try {
    const { stdout } = await run("herdr", ["api", "snapshot"]);
    return parseHerdrTerminalCatalog(stdout).slice(0, MAX_AGENTS);
  } catch {
    return [];
  }
}

/**
 * The fleet as messageable seats (ADR 0135). Fail-soft: a down herdr socket
 * renders an empty roster — seats offline, never a failed conversation surface.
 */
export async function readFleetSeats(options: { readonly runCommand?: HerdrCensusRunner } = {}): Promise<
  readonly {
    seatId: string;
    harness: string;
    status: string;
    title: string;
    summary?: string;
    next?: string;
  }[]
> {
  const run = options.runCommand ?? defaultRunner;
  try {
    const { stdout } = await run("herdr", ["agent", "list"]);
    const summaries = readHerdrSummariesFile().agents;
    return parseHerdrAgentList(stdout)
      .filter(
        (entry): entry is HerdrCensusAgent & { readonly terminalId: string } =>
          entry.agent !== "shell" && entry.terminalId !== undefined,
      )
      .slice(0, MAX_AGENTS)
      .map((entry) => {
        const written = summaries[entry.paneId];
        return {
          seatId: entry.terminalId,
          harness: entry.agent,
          status: entry.status,
          title: bounded(entry.title, 200),
          ...(written === undefined ? {} : { summary: bounded(written.summary, SEAT_SUMMARY_MAX) }),
          ...(written?.next === undefined ? {} : { next: bounded(written.next, SEAT_SUMMARY_MAX) }),
        };
      });
  } catch {
    return [];
  }
}

/** Live agent census for a seated turn. Fail-soft: a down socket is not a failed turn. */
export async function readHerdrSessionCensus(
  herdrPaneId: string,
  options: { readonly runCommand?: HerdrCensusRunner } = {},
): Promise<HerdrSessionCensus> {
  const run = options.runCommand ?? defaultRunner;
  try {
    const { stdout } = await run("herdr", ["agent", "list"]);
    return {
      outcome: "ok",
      text: formatHerdrSessionCensus(
        herdrPaneId,
        parseHerdrAgentList(stdout),
        readHerdrSummariesFile().agents,
      ),
    };
  } catch (caught) {
    if (caught instanceof Error && "code" in caught && caught.code === "ENOENT") {
      return { outcome: "unavailable", error: "herdr is not on PATH" };
    }
    return { outcome: "unavailable", error: caught instanceof Error ? caught.message : String(caught) };
  }
}
