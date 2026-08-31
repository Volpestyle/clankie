import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
  /** Stable operator-assigned identity for a managed agent. */
  readonly name?: string;
  readonly agent: string;
  readonly status: string;
  readonly title: string;
  /** Stable terminal address for this pane; not the occupying agent's identity. */
  readonly terminalId?: string;
  /** Absolute path the agent runs in; the commons district key (ADR 0022). */
  readonly cwd?: string;
  /** Harness-native session identity, independent of the pane holding it. */
  readonly session?: { readonly source: string; readonly kind: "id" | "path"; readonly value: string };
}

export type HerdrSessionCensus =
  | { readonly outcome: "ok"; readonly text: string }
  | { readonly outcome: "unavailable"; readonly error: string };

const CENSUS_TIMEOUT_MS = 5_000;
const SEAT_DIRECTORY_MAX = 1_024;
const MAX_AGENTS = 48;

export function occupantIdForHerdrSession(session: {
  readonly source: string;
  readonly kind: "id" | "path";
  readonly value: string;
}): string {
  const digest = createHash("sha256")
    .update(session.source)
    .update("\0")
    .update(session.kind)
    .update("\0")
    .update(session.value)
    .digest("hex");
  return `session-${digest}`;
}

/** Stable fallback identity for an unnamed agent while its Herdr pane exists. */
function subjectForHerdrPane(paneId: string): string {
  return `adhoc-${createHash("sha256").update(paneId).digest("hex").slice(0, 20)}`;
}

export interface ObservedFleetSeat {
  readonly seatId: string;
  /** Managed-agent name, or pane-derived fallback, used to recover the persona binding. */
  readonly subject: string;
  readonly occupantId: string;
  readonly harness: string;
  readonly status: string;
  readonly title: string;
  readonly summary?: string;
  readonly next?: string;
  readonly workingDirectory?: string;
}

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
    const rawSession = pane.agent_session;
    const session =
      rawSession !== null && typeof rawSession === "object"
        ? (rawSession as Record<string, unknown>)
        : undefined;
    agents.push({
      paneId,
      ...(typeof pane.name === "string" && pane.name.length > 0 ? { name: pane.name } : {}),
      agent,
      status: typeof pane.agent_status === "string" ? pane.agent_status : "unknown",
      title: titleOf(pane),
      ...(typeof pane.terminal_id === "string" && pane.terminal_id.length > 0
        ? { terminalId: pane.terminal_id }
        : {}),
      ...(typeof pane.cwd === "string" && pane.cwd.length > 0 ? { cwd: pane.cwd } : {}),
      ...(typeof session?.source === "string" &&
      (session.kind === "id" || session.kind === "path") &&
      typeof session.value === "string" &&
      session.source.length > 0 &&
      session.value.length > 0
        ? { session: { source: session.source, kind: session.kind, value: session.value } }
        : {}),
    });
  }
  return agents;
}

/**
 * A pane's own terminal grid in cells. A native surface renders the pane into a
 * viewport of its own size; without the real grid it can only crop, which is
 * what truncates wide agent output on a phone.
 */
export interface HerdrPaneGrid {
  readonly paneId?: string;
  readonly columns: number;
  readonly rows: number;
}

/**
 * The grid a terminal is actually running at. Undefined for an unknown terminal,
 * a down socket, or malformed vanilla Herdr output — callers keep their own
 * fallback rather than guessing a width. `pane layout` reports the pane's
 * content rectangle in cells; its height matches `scroll.viewport_rows`.
 */
export async function readTerminalGrid(
  terminalId: string,
  options: { readonly runCommand?: HerdrCensusRunner } = {},
): Promise<HerdrPaneGrid | undefined> {
  const run = options.runCommand ?? defaultRunner;
  try {
    const listed = JSON.parse((await run("herdr", ["pane", "list"])).stdout) as {
      result?: { panes?: unknown };
    };
    const pane = (Array.isArray(listed.result?.panes) ? listed.result.panes : []).find(
      (value) =>
        value !== null &&
        typeof value === "object" &&
        (value as Record<string, unknown>).terminal_id === terminalId,
    ) as Record<string, unknown> | undefined;
    const paneId = pane?.pane_id;
    if (typeof paneId !== "string") return undefined;

    const laidOut = JSON.parse((await run("herdr", ["pane", "layout", "--pane", paneId])).stdout) as {
      result?: { layout?: { panes?: unknown } };
    };
    const layoutPane = (Array.isArray(laidOut.result?.layout?.panes) ? laidOut.result.layout.panes : []).find(
      (value) =>
        value !== null && typeof value === "object" && (value as Record<string, unknown>).pane_id === paneId,
    ) as Record<string, unknown> | undefined;
    const rect = layoutPane?.rect;
    if (rect === null || typeof rect !== "object") return undefined;
    const { width, height } = rect as Record<string, unknown>;
    if (!Number.isInteger(width) || !Number.isInteger(height)) return undefined;
    if ((width as number) <= 0 || (height as number) <= 0) return undefined;
    return { paneId, columns: width as number, rows: height as number };
  } catch {
    return undefined;
  }
}

export function formatHerdrSessionCensus(
  herdrPaneId: string | undefined,
  agents: readonly HerdrCensusAgent[],
  summaries: Readonly<Record<string, HerdrAgentSummary>> = {},
): string {
  const counts = new Map<string, number>();
  const lines = [
    herdrPaneId === undefined
      ? "HERDR SESSION (led from the service — no pane is you)"
      : `HERDR SESSION (joined as ${herdrPaneId})`,
  ];
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
 * Which seat a Herdr pane is, for a caller that can only name the pane it sits
 * in (ADR 0148). This lookup is what makes an agent-reachable op safe: the seat
 * comes from the live census rather than from the caller's word, so a pane can
 * only ever resolve to itself. Undefined for a shell pane, an unknown pane, or
 * a down socket.
 */
export async function readSeatIdForHerdrPane(
  herdrPaneId: string,
  options: { readonly runCommand?: HerdrCensusRunner } = {},
): Promise<string | undefined> {
  const run = options.runCommand ?? defaultRunner;
  try {
    const { stdout } = await run("herdr", ["agent", "list"]);
    return parseHerdrAgentList(stdout).find((entry) => entry.paneId === herdrPaneId)?.terminalId;
  } catch {
    return undefined;
  }
}

/**
 * The fleet as occupied, messageable seats (ADR 0147). Fail-soft: a down herdr socket
 * renders an empty roster — seats offline, never a failed conversation surface.
 */
export async function readFleetSeats(
  options: { readonly runCommand?: HerdrCensusRunner } = {},
): Promise<readonly ObservedFleetSeat[]> {
  const run = options.runCommand ?? defaultRunner;
  try {
    const { stdout } = await run("herdr", ["agent", "list"]);
    const summaries = readHerdrSummariesFile().agents;
    return parseHerdrAgentList(stdout)
      .filter(
        (
          entry,
        ): entry is HerdrCensusAgent & {
          readonly terminalId: string;
          readonly session: NonNullable<HerdrCensusAgent["session"]>;
        } =>
          entry.agent !== "shell" &&
          entry.agent !== "clankie" &&
          entry.terminalId !== undefined &&
          entry.session !== undefined,
      )
      .slice(0, MAX_AGENTS)
      .map((entry) => {
        const written = summaries[entry.paneId];
        return {
          seatId: entry.terminalId,
          // The owner-selected session is the fleet boundary (ADR 0149).
          // Named agents rebind across panes; an ad-hoc one remains stable for
          // its pane and never borrows identity from a rotating harness session.
          subject: entry.name ?? subjectForHerdrPane(entry.paneId),
          occupantId: occupantIdForHerdrSession(entry.session),
          harness: entry.agent,
          status: entry.status,
          title: bounded(entry.title, 200),
          ...(written === undefined ? {} : { summary: bounded(written.summary, SEAT_SUMMARY_MAX) }),
          ...(written?.next === undefined ? {} : { next: bounded(written.next, SEAT_SUMMARY_MAX) }),
          ...(entry.cwd === undefined ? {} : { workingDirectory: bounded(entry.cwd, SEAT_DIRECTORY_MAX) }),
        };
      });
  } catch {
    return [];
  }
}

/** Live agent census for a seated turn. Fail-soft: a down socket is not a failed turn. */
export async function readHerdrSessionCensus(
  herdrPaneId: string | undefined,
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
