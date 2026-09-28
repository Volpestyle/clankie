import { TuiAltScreen, ProcessTerminal, truncateToWidth, visibleWidth, sliceByColumn, fuzzyFilter, matchesKey, decodeKittyPrintable, Key } from "@earendil-works/pi-tui";
import type { Component, TuiInputListenerResult } from "@earendil-works/pi-tui";
import {
  rpc, subscribe, loadTheme, scanWorktrees, refreshMRs, readMRCache,
  mrFor, classify, sessionIndex, correlate, probeEditors, correlateEditors, openTab,
  scanLibrary, annotateLibraryVcs, scanDocs, docScanIssues, readDatadog, DATADOG_CACHE,
  LIB_ROOTS,
  readLinear, LINEAR_CACHE, readSummaries, SUMMARIES_CACHE, parseAgentRecap,
  readSettings, writeSettings, SETTINGS, shOut,
  realpath, tilde, buildSnapshot, removeWorktree, ticketFor,
  readScanCache, writeScanCache, pullCandidates, syncWorktrees, fetchRepo,
  saveSnapshot, coalesceAsync, ME, ROOT, ROOTS, DD_DASHBOARDS, reloadCfg, cfgRaw,
} from "./lib.ts";
import { buildSwarm, startMap } from "./swarm.ts";
import { renderSwarmFrame } from "./swarm-tui.ts";
import type { SwarmFrame } from "./swarm-tui.ts";
import type { SwarmData } from "./types.ts";
import type {
  AgentStatus, AgentSummariesCache, ColorName, Correlations, DatadogCache, DatadogIncident, DatadogMonitor,
  DatadogSeries, DocumentEntry, DocumentScanIssue, Editor, EditorCorrelations,
  HerdrSnapshot, LibraryEntry, LibraryVcs, LinearCache, MergeRequest, MergeRequestCache,
  Pane, SessionIndex, Tab, Ticket, Worktree, WorktreeState, Workspace,
} from "./types.ts";

import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";

const c = loadTheme();

type Glyph = readonly [string, ColorName];

const AGENT_GLYPH: Record<AgentStatus, Glyph> = {
  working: ["●", "blue"],
  blocked: ["▲", "red"],
  done: ["★", "green"],
  idle: ["○", "subtext"],
  unknown: ["·", "overlay"],
};

const WT_GLYPH: Record<WorktreeState, Glyph> = {
  dirty: ["✎", "peach"],
  prunable: ["⌫", "overlay"],
  ahead: ["↑", "blue"],
  unpushed: ["⇡", "mauve"],
  behind: ["↓", "yellow"],
  clean: ["✓", "green"],
};

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MR_COLOR: Record<string, ColorName> = { opened: "mauve", merged: "green", closed: "red", locked: "yellow" };
const FILTERS = ["overview", "swarm", "worktrees", "library", "docs", "datadog"] as const;
const parseAgents = (v: unknown): string[] =>
  (Array.isArray(v) ? v.map(String) : String(v).split(",")).map((s) => s.trim()).filter(Boolean);

let NEW_AGENTS = parseAgents(readSettings().agents || process.env.HERD_LEAD_AGENTS || "claude,codex");

function setAgents(v: string): void {
  const next = parseAgents(v);
  if (!next.length) { state.note = "kept the old commands — need at least one"; return; }
  NEW_AGENTS = next;
  state.note = writeSettings({ ...readSettings(), agents: next })
    ? `a → ${next[0]}${next[1] ? ` · A → ${next[1]}` : ""}`
    : `a → ${next[0]} for this session — could not write ${tilde(SETTINGS)}`;
}

const agentCmds = () => NEW_AGENTS.slice();

type ConfigKey = Parameters<typeof cfgRaw>[0];

const CONFIG_FIELDS: Array<[ConfigKey, string, string]> = [
  ["roots", "worktree scan roots", "colon-separated dirs"],
  ["depth", "worktree scan depth", "levels below each root — default 2"],
  ["linearTeams", "linear team keys", "comma-separated, e.g. ENG,OPS"],
  ["linearUrl", "linear workspace url", "https://linear.app/<workspace>"],
  ["libRoots", "skill library roots", "colon-separated dirs · default ~/dev/skills:~/.agents/skills"],
  ["libDocs", "instruction docs", "colon-separated files"],
  ["docRoots", "docs view roots", "colon-separated dirs"],
  ["ddDashboards", "datadog quick links", "label=url, space-separated"],
];
const RESCAN_KEYS = new Set<ConfigKey>(["roots", "depth", "libRoots", "libDocs", "docRoots"]);

function saveCfg(key: ConfigKey, label: string, v: string): void {
  const next = { ...readSettings() };
  const val = v.trim();
  if (val) next[key] = val; else delete next[key];
  state.note = writeSettings(next)
    ? `${label} ${val ? "saved" : "cleared"} · ${tilde(SETTINGS)}`
    : `could not write ${tilde(SETTINGS)}`;
  reloadCfg();
  if (RESCAN_KEYS.has(key)) background("rescan", refreshWorktrees());
  else tui.requestRender();
}

interface Prompt {
  label: string;
  value: string;
  hint: string;
  run: (value: string) => void;
}

interface MenuItem {
  label: string;
  hint: string;
  run: () => void | Promise<void>;
  /** keep the modal open when this item runs — for rows that edit in place */
  keepOpen?: boolean;
}

interface MenuEdit {
  value: string;
  hint: string;
  save: (value: string) => void;
}

interface Menu {
  title: string;
  items: MenuItem[];
  cursor: number;
  /** set while the selected row is being typed into */
  edit?: MenuEdit | null;
}

interface MenuGeometry {
  firstLine: number;
  count: number;
}

interface TipGeometry {
  top: number;
  height: number;
}

interface SyncResult {
  updated: Array<{ w: Worktree; ok: boolean; already: boolean; err: string }>;
  unchanged: number;
  failed: Array<{ w: Worktree; ok: boolean; already: boolean; err: string }>;
  skipped: Array<{ w: Worktree; why: string; reason: string }>;
  fetchFailed: Array<{ root: string; ok: boolean; err: string }>;
}

interface DashboardState {
  agents: Pane[];
  tabs: Tab[];
  workspaces: Workspace[];
  collapsed: Set<string>;
  worktrees: Worktree[];
  editors: Editor[];
  library: LibraryEntry[];
  docs: DocumentEntry[];
  datadog: DatadogCache | null;
  linear: LinearCache | null;
  summaries: AgentSummariesCache | null;
  recaps: Record<string, { recap: string | null; pending: string | null }>;
  mrs: MergeRequestCache;
  sessions: SessionIndex;
  corr: Correlations;
  edCorr: EditorCorrelations;
  ws: string;
  cursor: number;
  scroll: number;
  filter: number;
  loading: string;
  tick: number;
  note: string;
  search: string;
  mode: "normal" | "search" | "prompt";
  prompt: Prompt | null;
  help: boolean;
  menu: Menu | null;
  menuGeom: MenuGeometry | null;
  headSel: string | null;
  tipGeom: TipGeometry | null;
  inspect: boolean;
  cachedAt: number;
  mapUrl: string;
  mapSel: string | null;
  lastSync?: SyncResult;
}

interface SettingsRow {
  label: string;
  hint: string;
  get: () => string;
  set: (value: string) => void;
}

function settingsRows(): SettingsRow[] {
  return [
    {
      label: "agent commands",
      hint: "comma separated — first is a, second is A",
      get: () => agentCmds().join(","),
      set: setAgents,
    },
    ...CONFIG_FIELDS.map(([key, label, hint]): SettingsRow => ({
      label,
      hint,
      get: () => cfgRaw(key),
      set: (v: string) => saveCfg(key, label, v),
    })),
  ];
}

function settingsMenu(cursor = 0): Menu {
  const menu: Menu = {
    title: "settings — settings.json wins, HERD_LEAD_* env is the fallback",
    items: settingsRows().map((row, i) => ({
      label: row.label,
      hint: row.get() || `unset — ${row.hint}`,
      keepOpen: true,
      run: () => {
        if (!state.menu) return;
        state.menu.edit = {
          value: row.get(),
          hint: `${row.hint} · empty clears`,
          // rebuild so every row's hint reflects what the save actually took
          save: (v: string) => { row.set(v); state.menu = settingsMenu(i); },
        };
      },
    })),
    cursor: 0,
    edit: null,
  };
  menu.cursor = Math.min(Math.max(cursor, 0), menu.items.length - 1);
  return menu;
}


const MY_PANE = process.env.HERDR_PANE_ID || "";

const state: DashboardState = {
  agents: [],
  tabs: [],
  workspaces: [],
  collapsed: new Set<string>(),
  worktrees: [],
  editors: [],
  library: [],
  docs: [],
  datadog: readDatadog(),
  linear: readLinear(),
  summaries: readSummaries(),
  recaps: {},
  mrs: readMRCache(),
  sessions: {},
  corr: { agentDirs: new Map(), dirAgents: new Map() },
  edCorr: { byDir: new Map() },
  ws: "",
  cursor: 0,
  scroll: 0,
  filter: 0,
  loading: "worktrees",
  tick: 0,
  note: "",
  search: "",
  mode: "normal",
  prompt: null,
  help: false,
  menu: null,
  menuGeom: null,
  headSel: null,
  tipGeom: null,
  inspect: false,
  cachedAt: 0,
  mapUrl: "",
  mapSel: null,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportFailure(label: string, error: unknown): void {
  setLoading("");
  state.note = `${label} failed: ${errorMessage(error)}`;
  tui.requestRender();
}

function background(label: string, task: Promise<unknown>): void {
  task.catch((error) => reportFailure(label, error));
}

function runMenuItem(item: MenuItem | undefined): void {
  if (!item) return;
  try {
    const result = item.run();
    if (result) background(item.label, result);
  } catch (error) {
    reportFailure(item.label, error);
  }
}

const HELP = [
  ["j / k  ↑ ↓", "move"],
  ["ctrl+d / ctrl+u", "half page"],
  ["{ / }", "prev / next section · jumps 5 in a flat list"],
  ["g / G", "top / bottom"],
  ["tab", "cycle filter"],
  ["1 … 6", "overview / swarm / worktrees / library / docs / datadog"],
  ["1 overview", "agents, their nvim panes, and every worktree — not library/docs/datadog"],
  ["2 swarm", "the live pixel map — jk or click picks a node, ↵ focuses it, o opens it in the browser"],
  ["tab bar", "the same views, clickable — the row under the counts"],
  ["/", "fuzzy search"],
  ["enter", "leave find, keep filter"],
  ["i", "toggle the detail panel for the selected row"],
  ["esc", "close detail · leave find + clear · close help"],
  ["enter / l / space", "agent·nvim: focus · worktree·doc: menu · group: fold"],
  ["z", "fold / unfold all tabs"],
  ["y", "copy the selected row's path — file for docs/skills, dir otherwise"],
  ["e", "nvim on the selection · focuses an nvim already on it"],
  ["t", "tode in a new tab on the selection \u2014 file for docs/skills, dir otherwise"],
  ["a / A", "first / second agent command in a tab at the selection"],
  ["c / C", "settings — agent commands, scan roots + depth, linear, library, datadog links"],
  ["r", "rescan everything local — panes, worktrees, library, docs · no network"],
  ["worktree menu", "refresh one repo's local origin refs without merging"],
  ["R", "agent-owned data — reread, or spawn an agent to refresh it via MCP"],
  ["m", "merge requests only"],
  ["p", "fetch every repo, then fast-forward each safe worktree"],
  ["P", "prune every eligible worktree — merged/closed MR, clean, no working agent"],
  ["?", "toggle this help"],
  ["q", "quit"],
  ["", ""],
  ["in a menu", "j/k move · 1-9 pick · enter run · esc cancel"],
  ["in settings", "enter edits the row in place · enter saves · esc discards · empty clears"],
  ["mouse", "click selects · click again opens · wheel scrolls"],
  ["detail panel", "follows the selection · i turns it off · shift+drag selects text in it"],
  ["open MRs", "click the header count to list them · click again opens all in the browser"],
  ["active tickets", "same — ticket per worktree branch, stage read off the MR · shipped ones drop out of the count"],
  ["", ""],
  ["library ▪ green", "in sync with origin main"],
  ["library ⇡ blue", "committed, but only on that branch"],
  ["library ✎ peach", "uncommitted local edits"],
  ["library + mauve", "untracked — never committed"],
  ["note", "all plain keys — herdr owns ctrl+b prefix only"],
] as const;

interface AgentRow { kind: "agent"; id: string; a: Pane }
interface GroupRow {
  kind: "group";
  id: string;
  tabId: string;
  label: string;
  wsLabel: string;
  wsId: string;
  number: number;
  rows: AgentRow[];
  worst: number;
}
interface WorktreeRow { kind: "wt"; id: string; w: Worktree; mr: MergeRequest | null; st: WorktreeState }
interface EditorRow { kind: "ed"; id: string; e: Editor }
interface LibraryRow { kind: "lib"; id: string; e: LibraryEntry }
interface DocumentRow { kind: "doc"; id: string; e: DocumentEntry }
interface HeadRow { kind: "head"; label: string }
interface EmptyRow { kind: "empty"; label: string }
interface SpinRow { kind: "spin"; label: string }
interface WorkspaceHeadRow { kind: "wshead"; id: string; label: string }
interface RepoHeadRow { kind: "repohead"; id: string; label: string; count: number; tally: string }
interface PermissionRow { kind: "perm"; id: string; label: string; issue: DocumentScanIssue }
interface DatadogEntryFields {
  name?: string;
  title?: string;
  label?: string;
  scope?: string;
  url?: string;
  query?: string;
  severity?: string;
  since?: string;
  status?: string;
  note?: string;
  message?: string;
}
type DatadogDashboardEntry = DatadogEntryFields & { type: "dashboard"; label: string; url: string };
type DatadogSeriesEntry = DatadogEntryFields & DatadogSeries & { type: "series" };
type DatadogMonitorEntry = DatadogEntryFields & DatadogMonitor & { type: "monitor" };
type DatadogIncidentEntry = DatadogEntryFields & DatadogIncident & {
  type: "incident";
  status: "incident";
};
type DatadogEntry = DatadogDashboardEntry | DatadogSeriesEntry | DatadogMonitorEntry | DatadogIncidentEntry;
interface DatadogRow { kind: "dd"; id: string; e: DatadogEntry }
interface DatadogRollupRow {
  kind: "ddroll";
  counts: Record<string, number>;
  incidents: number;
  at: string;
  atMs: number | null;
}
interface MrHeaderRow { kind: "mrs"; id: "@openmrs" }
interface TicketHeaderRow { kind: "tickets"; id: "@tickets" }
interface TabRow { kind: "tab"; id: string; filter: number; name: string }
type HeaderActionRow = MrHeaderRow | TicketHeaderRow;
type Row = AgentRow | GroupRow | WorktreeRow | EditorRow | LibraryRow | DocumentRow |
  HeadRow | EmptyRow | SpinRow | WorkspaceHeadRow | RepoHeadRow | PermissionRow |
  DatadogRow | DatadogRollupRow;
type SelectableRow = AgentRow | GroupRow | WorktreeRow | EditorRow | LibraryRow | DocumentRow | PermissionRow | DatadogRow;
type HitRow = SelectableRow | HeaderActionRow | TabRow;
interface HitRef { i: number; row: HitRow }
interface Detail { title: string; rows: Array<[string, string, ColorName]> }

function color(name: ColorName): (value: string) => string {
  return c[name];
}

function pad(s: string, n: number): string {
  const w = visibleWidth(s);
  return w >= n ? truncateToWidth(s, n) : s + " ".repeat(n - w);
}

function agentRows(): AgentRow[] {
  return state.agents
    .filter((a) => a.agent)
    .map((a) => ({ kind: "agent", id: a.pane_id, a }));
}

const RANK: Record<AgentStatus, number> = { blocked: 0, done: 1, working: 2, idle: 3, unknown: 4 };

function tallyOf(rows: AgentRow[]): string {
  const counts = rows.reduce<Record<string, number>>((m, r) => {
    const status = r.a.agent_status || "unknown";
    m[status] = (m[status] || 0) + 1;
    return m;
  }, {});
  const bits: string[] = [];
  for (const st of ["blocked", "done", "working", "idle"] as const) {
    if (!counts[st]) continue;
    const [g, col] = AGENT_GLYPH[st];
    bits.push(c[col](`${g}${counts[st]}`));
  }
  return bits.join(" ");
}

function buildSwarmData(): SwarmData {
  return buildSwarm({
    agents: state.agents,
    tabs: state.tabs,
    worktrees: state.worktrees,
    corr: state.corr,
    sessions: state.sessions,
    me: MY_PANE,
  });
}

function groupAgents(ags: AgentRow[]): Array<GroupRow | AgentRow | WorkspaceHeadRow> {
  const tabs = new Map<string, Tab>(state.tabs.map((t) => [t.tab_id, t]));
  const wss = new Map<string, Workspace>(state.workspaces.map((w) => [w.workspace_id, w]));
  const byTab = new Map<string, AgentRow[]>();
  for (const r of ags) {
    const key = r.a.tab_id || "?";
    const rows = byTab.get(key) || [];
    if (!byTab.has(key)) byTab.set(key, rows);
    rows.push(r);
  }
  const groups: GroupRow[] = [...byTab.entries()].map(([tabId, rows]) => {
    const first = rows[0];
    const t = tabs.get(tabId);
    const w = first ? wss.get(first.a.workspace_id) : undefined;
    rows.sort((a, b) => (RANK[a.a.agent_status || "unknown"] ?? 9) - (RANK[b.a.agent_status || "unknown"] ?? 9));
    const worst = rows.reduce((m, r) => Math.min(m, RANK[r.a.agent_status || "unknown"] ?? 9), 9);
    return {
      kind: "group",
      id: tabId,
      tabId,
      label: t?.label || t?.tab_id || "unlabelled",
      wsLabel: w?.label || "",
      wsId: first?.a.workspace_id || "",
      number: t?.number ?? 0,
      rows,
      worst,
    };
  });
  groups.sort((a, b) => a.worst - b.worst || a.number - b.number);

  const multiWs = new Set(groups.map((g) => g.wsId)).size > 1;
  const out: Array<GroupRow | AgentRow | WorkspaceHeadRow> = [];
  let lastWs: string | null = null;
  for (const g of groups) {
    if (multiWs && g.wsId !== lastWs) {
      out.push({ kind: "wshead", label: g.wsLabel || g.wsId, id: `ws:${g.wsId}` });
      lastWs = g.wsId;
    }
    out.push(g);
    if (!state.collapsed.has(g.tabId)) out.push(...g.rows);
  }
  return out;
}

function worktreeRows(): WorktreeRow[] {
  return state.worktrees.map((w) => {
    const mr = mrFor(w, state.mrs);
    return { kind: "wt", id: w.dir, w, mr, st: classify(w, mr) };
  });
}

function editorRows(): EditorRow[] {
  return state.editors.map((e) => ({ kind: "ed", id: e.pane_id, e }));
}

function libraryRows(): LibraryRow[] {
  return state.library.map((e) => ({ kind: "lib", id: e.file, e }));
}

function docRows(): DocumentRow[] {
  return state.docs.map((e) => ({ kind: "doc", id: e.file, e }));
}

function docsEmpty(): string {
  const issue = docScanIssues()[0];
  if (!issue) return "nothing found";
  if (issue.code === "ENOENT") return `${issue.dir}: no such directory — C sets docs view roots`;
  return `${issue.dir}: ${issue.code}`;
}

const HOST_APP = process.env.HERD_LEAD_HOST_APP || "com.mitchellh.ghostty";
const PRIVACY_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders";
const TCC_ARGS = ["reset", "SystemPolicyDocumentsFolder", HOST_APP];

function resetTcc(): void {
  state.note = "resetting the Documents prompt…";
  tui.requestRender();
  execFile("tccutil", TCC_ARGS, (err, _o, stderr) => {
    state.note = err
      ? `tccutil failed: ${((stderr || err.message || "").split("\n")[0]) || "unknown"}`
      : "reset — restart herdr, then macOS will ask on the next docs scan";
    tui.requestRender();
  });
}

function permissionMenu(issue: DocumentScanIssue): Menu {
  return {
    title: `${issue.dir} — macOS denied access`,
    items: [
      {
        label: "ask macOS again, then restart herdr",
        hint: `tccutil ${TCC_ARGS.join(" ")}`,
        run: () => resetTcc(),
      },
      {
        label: "open Privacy & Security settings",
        hint: "Files and Folders › your terminal › Documents",
        run: () => openUrl(PRIVACY_URL, "privacy settings"),
      },
      {
        label: "copy the tccutil command",
        hint: "run it yourself, then restart herdr",
        run: () => copyPath(`tccutil ${TCC_ARGS.join(" ")}`),
      },
    ],
    cursor: 0,
  };
}

function groupedView<T extends LibraryRow | DocumentRow>(rows: T[], label: string, emptyLabel = "nothing found"): Array<T | HeadRow | EmptyRow | WorkspaceHeadRow> {
  if (state.search) {
    const order = new Map();
    for (const r of rows) if (!order.has(r.e.group)) order.set(r.e.group, order.size);
    rows = fuzzyFilter(rows, state.search, (r) => `${r.e.name} ${r.e.group} ${r.e.file}`)
      .map((r, i) => ({ r, i }))
      .sort((a, b) => (order.get(a.r.e.group) ?? 99) - (order.get(b.r.e.group) ?? 99) || a.i - b.i)
      .map(({ r }) => r);
  }
  const out: Array<T | HeadRow | EmptyRow | WorkspaceHeadRow> = [{ kind: "head", label: `${label} (${rows.length})` }];
  if (!rows.length) out.push({ kind: "empty", label: state.search ? "no match" : emptyLabel });
  let group: string | null = null;
  for (const r of rows) {
    if (r.e.group !== group) {
      group = r.e.group;
      out.push({ kind: "wshead", label: group, id: `${label}:${group}` });
    }
    out.push(r);
  }
  return out;
}

const DD_RANK: Record<string, number> = { incident: 0, Alert: 1, Warn: 2, "No Data": 3, OK: 4 };

function datadogView(): Row[] {
  const d = state.datadog;
  const out: Row[] = [{ kind: "head", label: `DATADOG${d?.env ? ` — ${d.env}` : ""}` }];

  const dashboards = d?.dashboards?.length ? d.dashboards : DD_DASHBOARDS;
  if (dashboards.length) {
    out.push({ kind: "head", label: "LINKS" });
    for (const b of dashboards) out.push({ kind: "dd", id: `dash:${b.label}`, e: { type: "dashboard", ...b } });
  } else {
    out.push({ kind: "empty", label: "no quick links — C sets datadog quick links (label=url …)" });
  }

  if (!d) {
    out.push({ kind: "head", label: "HEALTH" });
    out.push({ kind: "empty", label: `no cache yet — an agent writes ${tilde(DATADOG_CACHE)}` });
    out.push({ kind: "empty", label: "ask the lead agent to refresh it, then press r" });
    return out;
  }

  const mons = d.monitors || [];
  const counts = mons.reduce<Record<string, number>>((m, x) => ((m[x.status] = (m[x.status] || 0) + 1), m), {});
  const inc = d.incidents || [];
  out.push({ kind: "head", label: "HEALTH" });
  out.push({ kind: "ddroll", counts, incidents: inc.length, at: d.at, atMs: d.atMs });

  const series = d.series || [];
  if (series.length) {
    out.push({ kind: "head", label: "SIGNAL" });
    for (const s of series) out.push({ kind: "dd", id: `series:${s.label}`, e: { type: "series", ...s } });
  }

  const loud = [
    ...inc.map((x): DatadogIncidentEntry => ({ ...x, type: "incident", status: "incident" })),
    ...mons.filter((m) => m.status === "Alert" || m.status === "Warn").map((m): DatadogMonitorEntry => ({ ...m, type: "monitor" })),
  ].sort((a, b) => (DD_RANK[a.status] ?? 9) - (DD_RANK[b.status] ?? 9));

  out.push({ kind: "head", label: `ATTENTION (${loud.length})` });
  if (!loud.length) out.push({ kind: "empty", label: "nothing alerting" });
  for (const x of loud) out.push({ kind: "dd", id: `dd:${x.id}`, e: x });

  const quiet = mons.filter((m) => m.status === "No Data");
  if (quiet.length) {
    out.push({ kind: "head", label: `NO DATA — nothing to evaluate (${quiet.length})` });
    for (const x of quiet) out.push({ kind: "dd", id: `dd:${x.id}`, e: { ...x, type: "monitor" } });
  }

  if (state.search) {
    return out.filter((r) => r.kind !== "dd" ||
      `${r.e.name || r.e.title || r.e.label} ${r.e.scope || ""}`.toLowerCase().includes(state.search.toLowerCase()));
  }
  return out;
}

function visibleRows(): Row[] {
  const f = FILTERS[state.filter];
  if (f === "library") {
    return groupedView(
      libraryRows(),
      "LIBRARY",
      LIB_ROOTS.length ? "nothing found" : "no library roots — C sets skill library roots",
    );
  }
  if (f === "docs") {
    const rows: Row[] = groupedView(docRows(), "DOCS", docsEmpty());
    const issue = docScanIssues().find((i) => i.code === "EPERM");
    if (issue && !state.docs.length && !state.search) {
      const at = rows.findIndex((r) => r.kind === "empty");
      if (at >= 0) {
        rows[at] = {
          kind: "perm",
          id: `perm:${issue.dir}`,
          issue,
          label: `${issue.dir}: macOS denied access — ↵ to fix`,
        };
      }
    }
    return rows;
  }
  if (f === "datadog") return datadogView();
  if (f === "swarm") return [];
  let ags = agentRows();
  let eds = editorRows();
  let wts = worktreeRows();
  if (state.search) {
    ags = fuzzyFilter(ags, state.search, (r) => `${r.a.pane_id} ${r.a.terminal_title_stripped || ""}`);
    eds = fuzzyFilter(eds, state.search, (r) => `${r.e.pane_id} ${r.e.wt} ${r.e.file}`);
    wts = fuzzyFilter(wts, state.search, (r) => `${r.w.name} ${r.w.branch}`);
  }
  const out: Row[] = [];
  if (f === "overview") {
    out.push({ kind: "head", label: `AGENTS (${ags.length})` });
    if (!ags.length) out.push({ kind: "empty", label: "no agents" });
    else out.push(...groupAgents(ags));
    out.push({ kind: "head", label: `NVIM (${eds.length})` });
    if (!eds.length) out.push({ kind: "empty", label: state.search ? "no match" : "no editor panes" });
    else out.push(...eds);
  }
  out.push({ kind: "head", label: `WORKTREES (${wts.length})` });
  if (!ROOTS.length && !wts.length) out.push({ kind: "empty", label: "no scan roots — C sets them (or HERD_LEAD_ROOT)" });
  else if (state.loading && !wts.length) out.push({ kind: "spin", label: `${state.loading} worktrees` });
  if (!wts.length && state.search) out.push({ kind: "empty", label: "no match" });
  out.push(...byRepo(wts));
  return out;
}

interface RepoGroup {
  key: string;
  name: string;
  rows: WorktreeRow[];
  newest: number;
}

function byRepo(rows: WorktreeRow[]): Array<RepoHeadRow | WorktreeRow> {
  const groups = new Map<string, RepoGroup>();
  for (const r of rows) {
    const key = r.w.repoRoot || r.w.dir;
    if (!groups.has(key)) groups.set(key, { key, name: r.w.repo || r.w.name, rows: [], newest: 0 });
    const g = groups.get(key)!;
    g.rows.push(r);
    g.newest = Math.max(g.newest, r.w.commitEpoch || 0);
  }
  const ordered = [...groups.values()].sort((a, b) => b.newest - a.newest);
  const out: Array<RepoHeadRow | WorktreeRow> = [];
  for (const g of ordered) {
    g.rows.sort((a, b) =>
      (a.w.linked ? 1 : 0) - (b.w.linked ? 1 : 0) || (b.w.commitEpoch || 0) - (a.w.commitEpoch || 0));
    const dirty = g.rows.filter((r) => r.st === "dirty").length;
    const prune = g.rows.filter((r) => r.st === "prunable").length;
    const bits: string[] = [];
    if (dirty) bits.push(c.peach(`✎${dirty}`));
    if (prune) bits.push(c.overlay(`⌫${prune}`));
    out.push({
      kind: "repohead",
      id: `repo:${g.key}`,
      label: g.name,
      count: g.rows.length,
      tally: bits.join(" "),
    });
    out.push(...g.rows);
  }
  return out;
}

function dirsOf(row: Row | HeaderActionRow | TabRow): string[] {
  if (row.kind === "agent") return (state.corr.agentDirs.get(row.id) || []).map((h) => h.dir);
  if (row.kind === "ed") return row.e.dir ? [row.e.dir] : [];
  if (row.kind === "wt") return [row.id];
  return [];
}

function targetOf(row: Row | undefined): { dir: string; file: string; label: string } | null {
  if (!row) return null;
  if (row.kind === "wt") return { dir: row.id, file: "", label: row.w.name };
  if (row.kind === "lib" || row.kind === "doc") return { dir: row.e.dir, file: row.e.file, label: row.e.name };
  if (row.kind === "ed") {
    const file = (row.e.file || "").split(" ")[0];
    return { dir: row.e.dir || row.e.cwd, file: file ? path.resolve(row.e.cwd, file) : "", label: row.e.wt || row.e.pane_id };
  }
  if (row.kind === "agent") {
    const dir = dirsOf(row)[0] || row.a.foreground_cwd || row.a.cwd;
    return dir ? { dir, file: "", label: path.basename(dir) } : null;
  }
  return null;
}

const FLAGW = 13;
const MRW = 6;
const BADGEW = 3;
const EDW = 3;
const LINKW = 8;
const SIZEW = 7;
const AGEW = 5;
const VCSW = 20;
const VCS_NONE: LibraryVcs = { state: "none", branch: "", onMain: false };
const BRANCH_MIN = 46;
const TRUNK = new Set(["main", "master"]);

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

const kb = (n: number): string => (n >= 1024 ? `${(n / 1024).toFixed(1)}k` : `${n}b`);

const SURFACE_OPEN = c.on.surface("").split("\x1b[49m")[0];

function line(selected: boolean, parts: string[]): string {
  const s = parts.join("");
  return selected ? c.on.surface(s.replaceAll("\x1b[0m", "\x1b[0m" + SURFACE_OPEN)) : s;
}

function renderAgent(row: AgentRow, width: number, selected: boolean, link: boolean): string {
  const a = row.a;
  const [g, col] = AGENT_GLYPH[a.agent_status || "unknown"];
  const hits = state.corr.agentDirs.get(a.pane_id) || [];
  const badge = pad(hits.length ? c.teal(`◆${hits.length}`) : "", BADGEW);
  const me = pad(a.pane_id === ME ? c.lavender("◂lead") : "", 6);
  const title = a.terminal_title_stripped || String(a.agent || "");
  const room = Math.max(8, width - 17 - BADGEW - 6 - 1);
  const body = link ? c.teal(pad(title, room)) : selected ? c.text(pad(title, room)) : c.subtext(pad(title, room));
  return line(selected, [
    ` ${selected ? c.lavender("▸") : " "}   `,
    `${c[col](g)} `,
    c.overlay(pad(a.pane_id, 9)),
    body,
    ` ${badge}${me}`,
  ]);
}

function renderEditor(row: EditorRow, width: number, selected: boolean, link: boolean): string {
  const e = row.e;
  const badge = pad(e.dir ? c.yellow("◈1") : "", BADGEW);
  const room = Math.max(8, width - 17 - BADGEW - 6 - 1);
  const wt = link || selected ? c.teal(e.wt) : c.subtext(e.wt);
  const body = pad(`${wt}  ${c.overlay(e.file || e.name)}`, room);
  return line(selected, [
    ` ${selected ? c.lavender("▸") : " "}   `,
    `${c.yellow("◈")} `,
    c.overlay(pad(e.pane_id, 9)),
    body,
    ` ${badge}${" ".repeat(6)}`,
  ]);
}

const VCS: Record<string, readonly [ColorName, string]> = {
  main: ["green", ""],
  branch: ["blue", "⇡"],
  dirty: ["peach", "✎"],
  new: ["mauve", "+"],
  nobase: ["overlay", "?"],
  none: ["overlay", ""],
};

function renderLibrary(row: LibraryRow, width: number, selected: boolean): string {
  const e = row.e;
  const v = e.vcs || VCS_NONE;
  const [vcol, mark] = VCS[v.state] || VCS.none!;
  const glyph = e.doc ? "▤" : "▪";
  const tag = e.links.length
    ? c.teal(e.links.join(" "))
    : e.aliases.length ? c.overlay(`←${e.aliases.length}`) : "";
  const where =
    v.state === "main" || v.state === "none" ? "" :
    v.state === "new" ? "+ untracked" :
    `${mark} ${v.branch}`;
  const base = path.basename(e.file);
  const suffix = e.doc || base === "SKILL.md" ? "" : c.overlay(` ${base}`);
  const room = Math.max(8, width - 5 - VCSW - LINKW - SIZEW - AGEW);
  const nameCol = v.onMain ? (selected ? c.text : c.subtext) : color(vcol);
  const name = pad(`${nameCol(e.name)}${suffix}`, room);
  return line(selected, [
    ` ${selected ? c.lavender("▸") : " "} `,
    `${color(vcol)(glyph)} `,
    name,
    pad(where ? color(vcol)(truncateToWidth(where, VCSW - 1)) : "", VCSW),
    pad(tag, LINKW),
    pad(c.overlay(kb(e.size)), SIZEW),
    pad(c.overlay(ago(e.mtime)), AGEW),
  ]);
}

const DOC_KIND: Record<string, readonly [string, ColorName, string]> = {
  ".tldraw": ["◨", "mauve", "tldraw"],
  ".tldr": ["◨", "mauve", "tldraw"],
  ".excalidraw": ["◨", "teal", "excalidraw"],
  ".md": ["▤", "blue", "md"],
  ".markdown": ["▤", "blue", "md"],
  ".mmd": ["◇", "teal", "mermaid"],
  ".mermaid": ["◇", "teal", "mermaid"],
  ".pdf": ["▢", "red", "pdf"],
  ".png": ["▣", "yellow", "png"],
  ".jpg": ["▣", "yellow", "jpg"],
  ".jpeg": ["▣", "yellow", "jpg"],
  ".gif": ["▣", "yellow", "gif"],
  ".webp": ["▣", "yellow", "webp"],
  ".svg": ["▣", "green", "svg"],
  ".html": ["▤", "peach", "html"],
};
const docKind = (ext: string): readonly [string, ColorName, string] => DOC_KIND[ext] || ["·", "overlay", ext.slice(1) || "file"];
const EXTW = 11;

function renderDoc(row: DocumentRow, width: number, selected: boolean): string {
  const e = row.e;
  const [glyph, col, tag] = docKind(e.ext);
  const room = Math.max(8, width - 5 - EXTW - SIZEW - AGEW);
  const name = pad((selected ? c.text : c.subtext)(e.name), room);
  return line(selected, [
    ` ${selected ? c.lavender("▸") : " "} `,
    `${c[col](glyph)} `,
    name,
    pad(c[col](tag), EXTW),
    pad(c.overlay(kb(e.size)), SIZEW),
    pad(c.overlay(ago(e.mtime)), AGEW),
  ]);
}

const SPARK = "▁▂▃▄▅▆▇█";

function spark(points: number[] | undefined, width: number): string {
  if (!points?.length || width < 4) return "";
  let pts = points;
  if (pts.length > width) {
    const size = pts.length / width;
    pts = Array.from({ length: width }, (_, i) =>
      Math.max(...pts.slice(Math.floor(i * size), Math.max(Math.floor((i + 1) * size), Math.floor(i * size) + 1))));
  }
  const max = Math.max(...pts);
  if (!(max > 0)) return SPARK[0]!.repeat(pts.length);
  return pts.map((v) => SPARK[Math.min(7, Math.round((v / max) * 7))]!).join("");
}

const num = (n: number): string => (n >= 10000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));

const DD_GLYPH: Record<string, Glyph> = {
  incident: ["⚑", "red"],
  Alert: ["●", "red"],
  Warn: ["▲", "peach"],
  "No Data": ["◌", "overlay"],
  OK: ["✓", "green"],
};
const ddGlyph = (s: string): Glyph => DD_GLYPH[s] || DD_GLYPH.OK!;

const DDNUMW = 22;

function renderDd(row: DatadogRow, width: number, selected: boolean): string {
  const e = row.e;
  if (e.type === "dashboard") {
    const labelW = Math.max(12, Math.min(30, Math.round(width * 0.28)));
    return line(selected, [
      ` ${selected ? c.lavender("▸") : " "} `,
      `${c.blue("▤")} `,
      pad((selected ? c.text : c.subtext)(e.label || ""), labelW),
      c.overlay(truncateToWidth((e.url || "").replace(/^https:\/\/app\.datadoghq\.com/, ""), Math.max(10, width - 7 - labelW))),
    ]);
  }
  if (e.type === "series") {
    const pts = e.points || [];
    const last = pts.length ? pts[pts.length - 1]! : 0;
    const peak = pts.length ? Math.max(...pts) : 0;
    const col = e.bad && last > 0 ? "red" : "teal";
    const labelW = Math.max(12, Math.min(30, Math.round(width * 0.28)));
    const barW = Math.max(8, Math.min(48, width - 5 - labelW - DDNUMW));
    return line(selected, [
      ` ${selected ? c.lavender("▸") : " "} `,
      `${c[col]("◇")} `,
      pad(c.subtext(e.label || ""), labelW),
      pad(c[col](spark(pts, barW)), barW + 2),
      pad(`${c.text(num(last))} ${c.overlay(`peak ${num(peak)}`)} ${c.overlay(e.window || "")}`, DDNUMW),
    ]);
  }
  const [g, col] = ddGlyph(e.status || "OK");
  const dim = e.status === "No Data";
  const name = e.name || e.title || "";
  const tag = e.severity || e.scope || "";
  const tagW = 18;
  const room = Math.max(10, width - 5 - tagW - AGEW);
  const body = pad(dim ? c.overlay(name) : (selected ? c.text : c.subtext)(name), room);
  return line(selected, [
    ` ${selected ? c.lavender("▸") : " "} `,
    `${c[col](g)} `,
    body,
    pad(c.overlay(truncateToWidth(tag, tagW - 1)), tagW),
    pad(c.overlay(e.since ? ago(Date.parse(e.since)) : ""), AGEW),
  ]);
}

function renderDdRoll(row: DatadogRollupRow, _width: number): string {
  const { counts, incidents, atMs } = row;
  const alert = counts.Alert || 0;
  const warn = counts.Warn || 0;
  const nodata = counts["No Data"] || 0;
  const ok = counts.OK || 0;
  const clear = !alert && !warn && !incidents;
  const age = atMs == null ? "unknown age" : `${ago(atMs)} old`;
  const stale = atMs != null && Date.now() - atMs > 30 * 60_000;
  return "   " +
    (clear ? c.green("✓ all clear") : c.red("▲ needs a look")) + c.overlay("  ·  ") +
    c.red(String(alert)) + c.subtext(" alert  ") +
    c.peach(String(warn)) + c.subtext(" warn  ") +
    c.overlay(String(nodata)) + c.subtext(" no-data  ") +
    c.green(String(ok)) + c.subtext(" ok  ") +
    c.mauve(String(incidents)) + c.subtext(" incidents") +
    (stale ? c.yellow(`   ${age}`) : c.overlay(`   ${age}`));
}

function renderGroup(row: GroupRow, width: number, selected: boolean): string {
  const collapsed = state.collapsed.has(row.tabId);
  const tally = tallyOf(row.rows);
  const caret = collapsed ? "▸" : "▾";
  const head = ` ${selected ? c.lavender("▸") : " "} ${c.overlay(caret)} ${c.bold(c.text(row.label))}`;
  const room = Math.max(2, width - visibleWidth(head) - visibleWidth(tally) - 3);
  return line(selected, [head, " ", c.surface("·".repeat(room)), " ", tally, " "]);
}

function overlayHelp(lines: string[], width: number): string[] {
  const w = Math.min(62, width - 4);
  const rows = HELP.map(([k, v]) => (k ? ` ${pad(c.mauve(k), 18)}${c.subtext(v)}` : ""));
  const top = 2;
  const box = [
    c.on.surface(pad(` ${c.bold(c.lavender("keys"))}`, w)),
    ...rows.map((r) => c.on.surface(pad(r, w))),
    c.on.surface(pad(` ${c.overlay("? or esc to close")}`, w)),
  ];
  const out = lines.slice();
  for (let i = 0; i < box.length && top + i < out.length; i++) out[top + i] = "  " + box[i];
  return out;
}

/** truncateToWidth keeps the head; this keeps the tail, for text being typed */
function tailToWidth(s: string, w: number): string {
  if (w <= 0) return "";
  let out = s;
  while (visibleWidth(out) > w) out = out.slice(1);
  return out;
}

function overlayMenu(lines: string[], width: number): string[] {
  const m = state.menu!;
  const w = Math.min(78, width - 6);
  const rows = m.items.map((it, i) => {
    const sel = i === m.cursor;
    const edit = sel && m.edit ? m.edit : null;
    const left = ` ${sel ? c.lavender("▸") : " "} ${c.overlay(String(i + 1))} ${sel ? c.text(it.label) : c.subtext(it.label)}`;
    const room = Math.max(0, w - visibleWidth(left) - 2);
    // typing runs off the right edge, so keep the tail — that is where the cursor is
    const right = edit
      ? c.text(tailToWidth(edit.value, Math.max(0, room - 1))) + c.lavender("█")
      : it.hint ? c.overlay(truncateToWidth(it.hint, room)) : "";
    const gap = Math.max(1, w - visibleWidth(left) - visibleWidth(right) - 1);
    const body = `${left}${" ".repeat(gap)}${right} `;
    return (sel ? c.on.overlay : c.on.surface)(pad(body, w));
  });
  const title = truncateToWidth(` ${m.title} `, w - 3);
  const box = [
    c.overlay("╭─") + c.bold(c.lavender(title)) + c.overlay("─".repeat(Math.max(0, w - 1 - visibleWidth(title))) + "╮"),
    ...[
      c.on.surface(pad("", w)),
      ...rows,
      c.on.surface(pad("", w)),
      c.on.surface(pad(` ${c.overlay(truncateToWidth(
        // keys first — a long field hint must never truncate away the way out
        m.edit ? `↵ save · esc discard · ${m.edit.hint}` : "↵ run · j/k move · 1-9 pick · esc cancel",
        w - 2,
      ))}`, w)),
    ].map((l) => c.overlay("│") + l + c.overlay("│")),
    c.overlay(`╰${"─".repeat(w)}╯`),
  ];
  const out = lines.slice();
  const top = Math.max(1, Math.floor((out.length - box.length) / 2));
  state.menuGeom = { firstLine: top + 2, count: m.items.length };
  const left = Math.max(0, Math.floor((width - w - 2) / 2));
  for (let i = 0; i < box.length && top + i < out.length; i++) {
    const line = out[top + i] || "";
    out[top + i] = pad(sliceByColumn(line, 0, left, true), left) + "\x1b[0m" + box[i]
      + "\x1b[0m" + sliceByColumn(line, left + w + 2, width);
  }
  return out;
}

function focusPane(id: string): void {
  rpc("pane.focus", { pane_id: id }).catch(() => {});
  state.note = `focused ${id}`;
}

function copyPath(dir: string): void {
  const p = execFile("pbcopy", [], () => {});
  p.stdin?.end(dir);
  state.note = `copied ${tilde(dir)}`;
}

function openUrl(url: string, what: string): void {
  execFile(process.platform === "darwin" ? "open" : "xdg-open", [url], () => {});
  state.note = `opened ${what}`;
}

function openMRRows(): Array<WorktreeRow & { mr: MergeRequest }> {
  return worktreeRows().filter((r): r is WorktreeRow & { mr: MergeRequest } => !!r.mr && r.mr.state === "opened" && !!r.mr.url);
}

function openAllMRs(): void {
  const rows = openMRRows();
  rows.forEach((r) => openUrl(r.mr.url, `!${r.mr.iid}`));
  state.note = rows.length ? `opened ${plural(rows.length, "MR")} in browser` : "no open MRs";
}

type TicketStage = "merged" | "review" | "draft" | "pushed" | "local";

const TIX_STAGE: Record<TicketStage, readonly [number, string, ColorName]> = {
  merged: [4, "shipped", "green"],
  review: [3, "in review", "mauve"],
  draft: [2, "draft MR", "blue"],
  pushed: [1, "pushed, no MR", "yellow"],
  local: [0, "local only", "overlay"],
};

function ticketStage(r: WorktreeRow): TicketStage {
  if (r.mr) {
    if (r.mr.state === "merged") return "merged";
    if (r.mr.state === "closed") return "merged";
    return r.mr.draft ? "draft" : "review";
  }
  return r.w.tracked ? "pushed" : "local";
}

interface TicketRow {
  t: Ticket;
  stage: TicketStage;
  r: WorktreeRow;
}

function ticketRows(): TicketRow[] {
  const by = new Map<string, TicketRow>();
  for (const r of worktreeRows()) {
    const t = ticketFor(r.w.branch);
    if (!t) continue;
    const stage = ticketStage(r);
    const prev = by.get(t.id);
    if (prev && TIX_STAGE[prev.stage][0] >= TIX_STAGE[stage][0]) continue;
    by.set(t.id, { t, stage, r });
  }
  return [...by.values()].sort((a, b) => TIX_STAGE[a.stage][0] - TIX_STAGE[b.stage][0]);
}

function activeTicketRows(): TicketRow[] {
  return ticketRows().filter((x) => x.stage !== "merged");
}

function unbranchedTickets() {
  const have = new Set(ticketRows().map((x) => x.t.id));
  return (state.linear?.issues || []).filter((i) => i.id && !have.has(i.id));
}

function openAllTickets(): void {
  const rows = activeTicketRows().filter((x) => x.t.url);
  const un = unbranchedTickets().filter((i) => i.url);
  rows.forEach((x) => openUrl(x.t.url, x.t.id));
  un.forEach((i) => openUrl(i.url, i.id));
  const n = rows.length + un.length;
  state.note = n ? `opened ${plural(n, "ticket")} in browser` : "no active tickets";
}

function dropWorktree(dir: string): void {
  state.worktrees = state.worktrees.filter((x) => x.dir !== dir);
  board.move(0);
  tui.requestRender();
}

function restoreWorktree(w: Worktree): void {
  if (state.worktrees.some((x) => x.dir === w.dir)) return;
  state.worktrees = [...state.worktrees, w].sort((a, b) => b.commitEpoch - a.commitEpoch);
  board.move(0);
}

async function doPrune(w: Worktree): Promise<void> {
  state.note = `removing ${w.name}…`;
  dropWorktree(w.dir);
  const r = await removeWorktree(w.dir);
  if (r.ok) {
    state.note = `removed ${w.name} · branch ${r.branch} kept`;
    await refreshWorktrees();
    board.move(0);
  } else {
    restoreWorktree(w);
    state.note = `kept ${w.name}: ${r.err}`;
    tui.requestRender();
  }
}

function confirmPrune(w: Worktree, st: WorktreeState): Menu {
  const restore = `git worktree add ${tilde(w.dir)} ${w.branch}`;
  return {
    title: `remove worktree ${w.name}?`,
    items: [
      { label: "cancel", hint: "", run: () => {} },
      {
        label: "yes, remove the checkout",
        hint: st === "prunable" ? `branch kept · undo: ${restore}` : `⚠ ${st} · branch kept · undo: ${restore}`,
        run: () => doPrune(w),
      },
    ],
    cursor: 0,
  };
}

async function doPruneAll(rows: WorktreeRow[]): Promise<void> {
  let ok = 0;
  const kept: string[] = [];
  rows.forEach((r) => dropWorktree(r.w.dir));
  for (const r of rows) {
    state.note = `removing ${r.w.name}… (${ok + kept.length + 1}/${rows.length})`;
    tui.requestRender();
    const res = await removeWorktree(r.w.dir);
    if (res.ok) {
      ok++;
    } else {
      kept.push(`${r.w.name}: ${res.err}`);
      restoreWorktree(r.w);
    }
  }
  board.move(0);
  await refreshWorktrees();
  board.move(0);
  state.note = `removed ${plural(ok, "worktree")}${kept.length ? ` · kept ${kept.length} — ${kept[0]}${kept.length > 1 ? " …" : ""}` : ""}`;
  tui.requestRender();
}

function confirmPruneAll(): Menu | null {
  const busy = busyDirs();
  const prunable = worktreeRows().filter((r) => r.st === "prunable");
  const rows = prunable.filter((r) => !busy.has(r.w.dir));
  const skipped = prunable.length - rows.length;
  if (!rows.length) {
    state.note = skipped ? `nothing to prune — ${plural(skipped, "prunable worktree")} busy with a working agent` : "nothing to prune";
    return null;
  }
  return {
    title: `remove ${plural(rows.length, "prunable worktree")}?`,
    items: [
      { label: "cancel", hint: "", run: () => {} },
      {
        label: `yes — remove all ${rows.length}`,
        hint: `branches kept · dirty ones refuse${skipped ? ` · skipping ${skipped} with a working agent` : ""}`,
        run: () => doPruneAll(rows),
      },
    ],
    cursor: 0,
  };
}

function busyDirs(): Set<string> {
  const out = new Set<string>();
  for (const [dir, panes] of state.corr.dirAgents) {
    const working = panes.some((id) =>
      state.agents.find((a) => a.pane_id === id)?.agent_status === "working");
    if (working) out.add(dir);
  }
  return out;
}

async function doSync(busy: Set<string>): Promise<void> {
  setLoading("fetching");
  tui.requestRender();
  const res = await syncWorktrees(state.worktrees, busy, (msg) => setLoading(msg));
  setLoading("");
  const bits = [`${res.updated.length} updated`, `${res.unchanged} already current`];
  if (res.failed.length) bits.push(`${res.failed.length} not fast-forwardable`);
  if (res.skipped.length) bits.push(`${res.skipped.length} skipped`);
  if (res.fetchFailed.length) bits.push(`${res.fetchFailed.length} fetch errors`);
  state.note = bits.join(" · ");
  state.lastSync = res;
  await refreshWorktrees();
  await refreshMRsNow(true);
}

async function refreshSelectedRepo(w: Worktree): Promise<void> {
  setLoading("fetching origin");
  const r = await fetchRepo(w);
  setLoading("");
  if (!r.ok) {
    state.note = `kept cached refs for ${w.repo}: ${r.err || "fetch failed"}`;
    return tui.requestRender();
  }
  await refreshWorktrees();
  await refreshMRsNow(true);
  state.note = `refreshed local refs for ${w.repo}${state.mrs.failed ? " · some MR data stayed cached" : ""}`;
  tui.requestRender();
}

function confirmSync(): Menu {
  const busy = busyDirs();
  const { go, skip } = pullCandidates(state.worktrees, busy);
  const roots = new Set(state.worktrees.map((w) => w.repoRoot || w.dir));
  const why: Record<string, number> = {};
  for (const s of skip) why[s.reason] = (why[s.reason] || 0) + 1;
  const reasons = Object.entries(why).map(([k, v]) => `${v} ${k}`).join(", ");
  return {
    title: `fetch ${roots.size} repos, fast-forward ${go.length} worktrees?`,
    items: [
      { label: "cancel", hint: "", run: () => {} },
      {
        label: "yes — fetch --all --prune, then merge --ff-only",
        hint: `never merges, rebases or resets${reasons ? ` · skipping ${reasons}` : ""}`,
        run: () => doSync(busy),
      },
    ],
    cursor: 0,
  };
}

async function launchInTab(dir: string, label: string, command: string): Promise<void> {
  state.note = `${command} → ${label}…`;
  tui.requestRender();
  try {
    const pane = await openTab({ cwd: dir, label, command, workspaceId: state.ws });
    state.note = `${command} in ${pane}`;
  } catch (e) {
    state.note = `failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  tui.requestRender();
  scheduleEditors(1500);
}

function editorOn(file: string): Editor | undefined {
  const real = realpath(file);
  return state.editors.find((e) => {
    if (!e.file) return false;
    return e.file.split(" ").some((f) => realpath(path.resolve(e.cwd, f)) === real);
  });
}

const shq = (s: string): string => `'${String(s).replace(/'/g, `'\\''`)}'`;

function openInEditor(file: string, label: string): void {
  const open = editorOn(file);
  if (open) return focusPane(open.pane_id);
  launchInTab(path.dirname(file), label, `nvim ${shq(path.basename(file))}`);
}

const MD_EXT = new Set([".md", ".markdown", ".mmd", ".mermaid"]);
const OPAQUE_EXT = new Set([".tldraw", ".tldr", ".excalidraw", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp"]);

function openWithDefault(file: string, what: string): void {
  execFile(process.platform === "darwin" ? "open" : "xdg-open", [file], () => {});
  state.note = `opened ${what}`;
}

function openInTode(dir: string, file: string, label: string): void {
  launchInTab(file ? path.dirname(file) : dir, label, file ? `tode ${shq(path.basename(file))}` : "tode");
}

function docMenu(sel: DocumentRow): Menu {
  const e = sel.e;
  const items: MenuItem[] = [];
  const app = ({ ".tldraw": "tldraw", ".tldr": "tldraw", ".excalidraw": "excalidraw" } as Record<string, string>)[e.ext];
  if (MD_EXT.has(e.ext)) {
    items.push({
      label: "preview in browser",
      hint: "md-preview in a new tab · mermaid pan/zoom",
      run: () => launchInTab(e.dir, e.name, `md-preview ${shq(path.basename(e.file))} --open`),
    });
  }
  items.push({
    label: app ? `open in ${app}` : "open in the default app",
    hint: tilde(e.file),
    run: () => openWithDefault(e.file, e.name),
  });
  if (!OPAQUE_EXT.has(e.ext)) {
    const open = editorOn(e.file);
    items.push({
      label: open ? `focus ${open.name}` : "edit in nvim",
      hint: open ? open.pane_id : tilde(e.dir),
      run: () => openInEditor(e.file, e.name),
    });
    items.push({ label: "open in tode", hint: tilde(e.file), run: () => openInTode(e.dir, e.file, e.name) });
  }
  if (process.platform === "darwin") {
    items.push({
      label: "reveal in Finder",
      hint: tilde(e.dir),
      run: () => {
        execFile("open", ["-R", e.file], () => {});
        state.note = `revealed ${e.name}`;
      },
    });
  }
  items.push({ label: "copy path", hint: tilde(e.file), run: () => copyPath(e.file) });
  return { title: `${e.name}${e.ext}`, items, cursor: 0 };
}

function worktreeMenu(sel: WorktreeRow): Menu {
  const { w } = sel;
  const dir = sel.id;
  const items: MenuItem[] = [];
  for (const pid of state.edCorr.byDir.get(dir) || []) {
    const e = state.editors.find((x) => x.pane_id === pid);
    items.push({
      label: `focus ${e?.name || "nvim"}`,
      hint: `${pid}${e?.file ? ` · ${e.file}` : ""}`,
      run: () => focusPane(pid),
    });
  }
  items.push({ label: "open nvim in new tab", hint: tilde(dir), run: () => launchInTab(dir, w.name, "nvim") });
  items.push({ label: "open tode in new tab", hint: tilde(dir), run: () => openInTode(dir, "", w.name) });
  for (const pid of state.corr.dirAgents.get(dir) || []) {
    const a = state.agents.find((x) => x.pane_id === pid);
    items.push({
      label: "focus agent",
      hint: `${pid}${a?.terminal_title_stripped ? ` · ${a.terminal_title_stripped}` : ""}`,
      run: () => focusPane(pid),
    });
  }
  for (const cmd of NEW_AGENTS) {
    items.push({ label: `new ${cmd} in new tab`, hint: tilde(dir), run: () => launchInTab(dir, w.name, cmd) });
  }
  const mr = sel.mr;
  if (mr?.url) {
    items.push({
      label: `open MR !${mr.iid} in browser`,
      hint: `${mr.state}${mr.draft ? " draft" : ""} · ${mr.title || ""}`,
      run: () => openUrl(mr.url, `!${mr.iid}`),
    });
  }
  const ticket = ticketFor(w.branch);
  if (ticket?.url) {
    items.push({
      label: `open ${ticket.id} in Linear`,
      hint: ticket.url,
      run: () => openUrl(ticket.url, ticket.id),
    });
  }
  items.push({
    label: "refresh this repo from origin",
    hint: "fetch origin --prune · local refs only, no merge or push",
    run: () => refreshSelectedRepo(w),
  });
  items.push({ label: "copy path", hint: tilde(dir), run: () => copyPath(dir) });
  if (w.linked) {
    items.push({
      label: "remove worktree",
      hint: sel.st === "prunable" ? "prunable · branch kept" : `⚠ ${sel.st} · branch kept`,
      run: () => { state.menu = confirmPrune(w, sel.st); tui.requestRender(); },
    });
  }
  return { title: `${w.name}  ${w.branch}`, items, cursor: 0 };
}

const DD_PROMPT = "Refresh the herd-lead Datadog cache: follow the "
  + '"Datadog view" section of the herdr-lead skill, which gives the MCP calls and the exact JSON contract.';

function datadogMenu(sel: DatadogRow): Menu {
  const e = sel.e;
  const items: MenuItem[] = [];
  const url = e.url;
  const query = e.query;
  if (url) items.push({ label: "open in Datadog", hint: url, run: () => openUrl(url, e.name || e.title || "datadog") });
  if (query) items.push({ label: "copy the query", hint: truncateToWidth(query, 60), run: () => copyPath(query) });
  items.push({
    label: "investigate in a new agent tab",
    hint: `${NEW_AGENTS[0] || "claude"} in ${tilde(ROOT)}`,
    run: () => launchInTab(ROOT, "datadog", NEW_AGENTS[0] || "claude"),
  });
  items.push({
    label: "refresh this cache in a new agent tab",
    hint: tilde(DATADOG_CACHE),
    run: () => launchInTab(ROOT, "dd refresh", `${NEW_AGENTS[0] || "claude"} ${shq(DD_PROMPT)}`),
  });
  return { title: e.name || e.title || e.label || "datadog", items, cursor: 0 };
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

const ST_TEXT: Record<WorktreeState, (worktree: Worktree) => string> = {
  dirty: (w) => `${plural(w.dirty, "file")} with uncommitted changes`,
  prunable: () => "its MR is merged or closed — checkout is safe to remove",
  ahead: (w) => `${plural(w.ahead, "commit")} ahead of its cached upstream`,
  unpushed: () => "no cached upstream ref — origin state is unknown",
  behind: (w) => `${plural(w.behind, "commit")} behind its cached upstream`,
  clean: () => "no local changes, and level with its cached upstream",
};

function worktreeDetail(row: WorktreeRow): Detail {
  const { w, mr, st } = row;
  const stCol = (WT_GLYPH[st] || WT_GLYPH.clean)[1];
  const rows: Array<[string, string, ColorName]> = [["branch", w.branch || "(detached)", TRUNK.has(w.branch) ? "green" : "lavender"]];
  rows.push(["state", `${st} — ${ST_TEXT[st](w)}`, stCol]);
  if (w.dirty) rows.push([`✎ ${w.dirty}`, `${plural(w.dirty, "file")} changed but not committed`, "peach"]);
  if (w.ahead) rows.push([`↑ ${w.ahead}`, `${plural(w.ahead, "commit")} here that the cached upstream does not have`, "blue"]);
  if (w.behind) rows.push([`↓ ${w.behind}`, `${plural(w.behind, "commit")} on the cached upstream that you do not have`, "yellow"]);
  const fetched = w.fetchEpoch ? `${ago(w.fetchEpoch * 1000)} ago` : "time unknown";
  rows.push(["upstream", w.tracked ? `cached ref · ${plural(w.unique, "unlanded commit")} vs cached main · fetched ${fetched}` : `no cached ref · fetched ${fetched}`, w.tracked ? "subtext" : "mauve"]);
  if (mr) rows.push(["MR", `!${mr.iid} ${mr.state}${mr.draft ? " (draft)" : ""} — ${mr.title || ""}`, MR_COLOR[mr.state] || "subtext"]);
  const t = ticketFor(w.branch);
  if (t) rows.push(["branch ticket", t.id, "teal"]);
  const ags = state.corr.dirAgents.get(w.dir) || [];
  if (ags.length) rows.push(["◆ agents", ags.join("  "), "teal"]);
  const eds = state.edCorr.byDir.get(w.dir) || [];
  if (eds.length) rows.push(["◈ nvim", eds.join("  "), "yellow"]);
  if (w.commitEpoch) rows.push(["HEAD commit", `${ago(w.commitEpoch * 1000)} ago — ${w.subject}`, "subtext"]);
  rows.push(["path", tilde(w.dir), "overlay"]);
  if (!w.linked) rows.push(["note", "main checkout — cannot be removed from here", "overlay"]);
  return { title: w.name, rows };
}

const VCS_TEXT: Record<string, (v: LibraryVcs) => string> = {
  main: (v) => `in sync with ${v.base || "origin/main"}`,
  branch: (v) => `committed on ${v.branch}, not yet on main`,
  dirty: (v) => `uncommitted edits on ${v.branch}`,
  new: () => "untracked — never committed",
  nobase: () => "no origin/main to compare against",
  none: () => "not inside a git repo",
};

const recapInflight = new Set<string>();

function requestRecap(paneId: string): void {
  if (state.recaps[paneId] || recapInflight.has(paneId)) return;
  recapInflight.add(paneId);
  void shOut("herdr", ["agent", "read", paneId, "--source", "recent-unwrapped", "--lines", "60"]).then((result) => {
    state.recaps[paneId] = result.ok ? parseAgentRecap(result.out) : { recap: null, pending: null };
    recapInflight.delete(paneId);
    tui.requestRender();
  }).catch(() => {
    state.recaps[paneId] = { recap: null, pending: null };
    recapInflight.delete(paneId);
  });
}

function pushSummaryRows(rows: Array<[string, string, ColorName]>, paneId: string): void {
  const written = state.summaries?.agents[paneId];
  if (written) {
    rows.push(["summary", written.summary, "text"]);
    if (written.next) rows.push(["next", written.next, "subtext"]);
    const when = written.at || state.summaries?.at;
    const atMs = when ? Date.parse(when) : state.summaries?.atMs;
    rows.push(["lead", Number.isFinite(atMs) ? `wrote ${ago(atMs!)} ago` : "wrote at an unknown time", "overlay"]);
  } else {
    rows.push(["summary", `no summary yet — the herdr-lead agent writes ${tilde(SUMMARIES_CACHE)}`, "red"]);
  }
  const mined = state.recaps[paneId];
  if (mined?.pending) rows.push(["unsent", mined.pending, "peach"]);
  if (mined?.recap && mined.recap !== written?.summary) rows.push(["recap", mined.recap, "subtext"]);
}

function detailFor(row: Row | HeaderActionRow | undefined): Detail | null {
  if (!row) return null;
  if (row.kind === "mrs") {
    const mrs = openMRRows();
    if (!mrs.length) return null;
    return {
      title: `${plural(mrs.length, "open MR")} · click to open all in browser`,
      rows: mrs.map((r): [string, string, ColorName] => [
        `!${r.mr.iid}`,
        `${r.w.name}${r.mr.draft ? " · draft" : ""} — ${r.mr.title || ""}`,
        MR_COLOR[r.mr.state] || "mauve",
      ]),
    };
  }
  if (row.kind === "tickets") {
    const tix = ticketRows();
    const un = unbranchedTickets();
    if (!tix.length && !un.length) return null;
    const active = tix.filter((x) => x.stage !== "merged");
    const rows: Array<[string, string, ColorName]> = active.map(({ t, stage, r }) => {
      const [, label, color] = TIX_STAGE[stage];
      return [t.id, `${label} · ${r.w.name}${r.mr ? ` · !${r.mr.iid}` : ""}`, color];
    });
    for (const i of un) rows.push([i.id, `no branch · ${i.state || "?"}${i.title ? ` — ${i.title}` : ""}`, "peach"]);
    const shipped = tix.length - active.length;
    if (shipped) rows.push(["shipped", `${shipped} more with a merged or closed MR — not counted`, "green"]);
    rows.push(["linear", state.linear
      ? state.linear.atMs == null ? "cache written at an unknown time" : `cache written ${ago(state.linear.atMs)} ago`
      : `no cache yet — an agent writes ${tilde(LINEAR_CACHE)}`, state.linear ? "overlay" : "red"]);
    return {
      title: `${plural(active.length + un.length, "active ticket")} · click to open all in browser`,
      rows,
    };
  }
  if (row.kind === "wt") return worktreeDetail(row);
  if (row.kind === "agent") {
    const a = row.a;
    const status = a.agent_status || "unknown";
    requestRecap(a.pane_id);
    const rows: Array<[string, string, ColorName]> = [
      ["status", status, AGENT_GLYPH[status][1]],
      ["task", a.terminal_title_stripped || "(none)", "lavender"],
    ];
    pushSummaryRows(rows, a.pane_id);
    if (a.label) rows.push(["label", a.label, "mauve"]);
    rows.push(["tab", a.tab_id, "overlay"]);
    const hits = state.corr.agentDirs.get(a.pane_id) || [];
    if (hits.length) rows.push(["◆ worktrees", hits.map((h) => h.name).join("  "), "teal"]);
    return { title: a.pane_id, rows };
  }
  if (row.kind === "ed") {
    const e = row.e;
    return {
      title: `${e.pane_id} — ${e.name}`,
      rows: [
        ["file", e.file || "(none)", "lavender"],
        ["◈ worktree", e.wt || "(outside the scan root)", e.dir ? "yellow" : "overlay"],
        ["cwd", tilde(e.cwd), "overlay"],
        ["tab", e.tab_id, "overlay"],
      ],
    };
  }
  if (row.kind === "lib") {
    const e = row.e;
    const v = e.vcs || VCS_NONE;
    const rows: Array<[string, string, ColorName]> = [
      ["group", e.group, "mauve"],
      ["git", `${v.state} — ${(VCS_TEXT[v.state] || (() => v.state))(v)}`, (VCS[v.state] || VCS.none!)[0]],
    ];
    rows.push(["linked from", e.links.length ? e.links.map((l) => ({ c: "~/.claude", a: "~/.agents", x: "~/.codex" }[l] || l)).join("  ") : e.aliases.length ? e.aliases.join("  ") : "nothing", e.links.length ? "teal" : "overlay"]);
    rows.push(["file", tilde(e.file), "overlay"]);
    rows.push(["size", `${kb(e.size)} · edited ${ago(e.mtime)} ago`, "subtext"]);
    return { title: e.name, rows };
  }
  if (row.kind === "doc") {
    const e = row.e;
    const [, dcol, tag] = docKind(e.ext);
    return {
      title: `${e.name}${e.ext}`,
      rows: [
        ["kind", tag, dcol],
        ["folder", e.group, "mauve"],
        ["size", `${kb(e.size)} · edited ${ago(e.mtime)} ago`, "subtext"],
        ["path", tilde(e.file), "overlay"],
      ],
    };
  }
  if (row.kind === "dd") {
    const e = row.e;
    if (e.type === "series") {
      const pts = e.points || [];
      return {
        title: e.label || "series",
        rows: [
          ["window", e.window || "?", "subtext"],
          ["now / peak", `${num(pts[pts.length - 1] ?? 0)} / ${num(Math.max(0, ...pts))}`, "text"],
          ["buckets", `${pts.length} points`, "overlay"],
          ["query", e.query || "(none)", "overlay"],
        ],
      };
    }
    if (e.type === "dashboard") {
      return { title: `${e.label} dashboard`, rows: [["opens", e.url, "overlay"]] };
    }
    const col = ddGlyph(e.status)[1];
    const rows: Array<[string, string, ColorName]> = [["status", e.status, col]];
    if (e.note) rows.push(["why", e.note, "subtext"]);
    if (e.severity) rows.push(["severity", e.severity, "red"]);
    if (e.scope) rows.push(["scope", e.scope, "mauve"]);
    if (e.since) rows.push(["since", `${ago(Date.parse(e.since))} ago`, "subtext"]);
    if (e.query) rows.push(["query", e.query, "overlay"]);
    if (e.message) {
      rows.push(["message", e.message.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 3).join(" ").slice(0, 280), "subtext"]);
    }
    if (e.url) rows.push(["url", e.url, "overlay"]);
    return { title: e.name || e.title || "", rows };
  }
  if (row.kind === "group") {
    return {
      title: row.label,
      rows: [
        ["workspace", row.wsLabel || row.wsId, "mauve"],
        ["panes", String(row.rows.length), "subtext"],
      ],
    };
  }
  return null;
}

function mapDetail(id: string, data: SwarmData | null): Detail | null {
  const n = data?.nodes.find((x) => x.id === id);
  if (!data || !n) return null;
  if (n.kind === "agent") {
    const status = (n.status || "unknown") as AgentStatus;
    const rows: Array<[string, string, ColorName]> = [
      ["status", status, AGENT_GLYPH[status][1]],
      ["task", n.title || "(none)", "lavender"],
    ];
    requestRecap(id);
    pushSummaryRows(rows, id);
    if (n.tab) rows.push(["tab", n.tab, "overlay"]);
    const on = data.links.filter((l) => l.kind === "on" && l.s === id)
      .map((l) => data.nodes.find((x) => x.id === l.t)?.label || path.basename(l.t));
    if (on.length) rows.push(["◆ worktrees", on.join("  "), "teal"]);
    const talk = data.links
      .filter((l) => (l.s === id || l.t === id) && l.kind !== "on" && l.kind !== "ask")
      .sort((a, b) => b.at - a.at)
      .slice(0, 6);
    for (const l of talk) {
      const out = l.s === id;
      const other = out ? l.t : l.s;
      if (l.kind === "couple") {
        rows.push(["⚭", `shares a checkout with ${other}${l.hot ? " — both working NOW" : ""}`, l.hot ? "red" : "overlay"]);
        continue;
      }
      const word = ({ dispatch: "prompted", handoff: "handed off to", watch: "watched" } as Record<string, string>)[l.kind] || l.kind;
      const text = out ? `${word} ${other}` : `${other} ${word} this pane`;
      rows.push([out ? "→" : "⇠", `${text}${l.n > 1 ? ` ×${l.n}` : ""} · ${ago(l.at)} ago`, "subtext"]);
    }
    if ((n.status || "") === "blocked") rows.push(["▲", "waiting on a human", "red"]);
    rows.push(["↵", "focus this pane", "overlay"]);
    return { title: id, rows };
  }
  if (n.kind === "hub") {
    const here = data.links.filter((l) => l.kind === "on" && l.t === id).map((l) => l.s);
    const rows: Array<[string, string, ColorName]> = [];
    if (n.branch) rows.push(["branch", n.branch, "overlay"]);
    rows.push(["◆ agents", here.join("  ") || "(none)", "teal"]);
    return { title: n.label, rows };
  }
  const asks = data.links.filter((l) => l.kind === "ask").map((l) => l.s);
  return {
    title: "you",
    rows: [["blocked on you", asks.length ? asks.join("  ") : "nobody", asks.length ? "red" : "green"]],
  };
}

function wrapTo(text: string, w: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (let word of String(text).split(/\s+/).filter(Boolean)) {
    while (visibleWidth(word) > w) {
      if (cur) { out.push(cur); cur = ""; }
      let take = Math.min(word.length, w);
      while (take > 1 && visibleWidth(word.slice(0, take)) > w) take--;
      out.push(word.slice(0, take));
      word = word.slice(take);
    }
    if (!cur) cur = word;
    else if (visibleWidth(cur) + 1 + visibleWidth(word) <= w) cur += ` ${word}`;
    else { out.push(cur); cur = word; }
  }
  if (cur) out.push(cur);
  return out.length ? out : [""];
}

const TIPLABEL = 13;

function overlayTip(lines: string[], width: number, detail: Detail, anchorLine: number): string[] {
  const w = Math.min(78, width - 4);
  const valW = Math.max(10, w - TIPLABEL - 2);
  const body: string[] = [];
  for (const [label, value, col] of detail.rows) {
    const paint = color(col);
    const wrapped = wrapTo(value, valW);
    wrapped.forEach((piece, i) => {
      const shownLabel = i === 0 ? truncateToWidth(label, TIPLABEL) : "";
      body.push(` ${pad(shownLabel ? paint(shownLabel) : "", TIPLABEL)}${c.text(piece)}`);
    });
  }
  const box = [
    c.on.surface(pad(` ${c.bold(c.lavender(detail.title))}`, w)),
    ...body.map((b) => c.on.surface(pad(b, w))),
  ];
  const out = lines.slice();
  const room = Math.max(0, out.length - 2);
  let top = anchorLine + 1;
  if (top + box.length > room && anchorLine >= box.length) top = anchorLine - box.length;
  const drawn = Math.min(box.length, Math.max(0, room - top));
  state.tipGeom = { top, height: drawn };
  for (let i = 0; i < drawn; i++) out[top + i] = "  " + box[i];
  return out;
}

function renderWorktree(row: WorktreeRow, width: number, selected: boolean, link: boolean): string {
  const { w, mr, st } = row;
  const [g, col] = WT_GLYPH[st] || WT_GLYPH.clean;
  const agents = state.corr.dirAgents.get(w.dir) || [];
  const eds = state.edCorr.byDir.get(w.dir) || [];
  const badge = pad(agents.length ? c.teal(`◆${agents.length}`) : "", BADGEW);
  const edBadge = pad(eds.length ? c.yellow(`◈${eds.length}`) : "", EDW);
  let flags = "";
  if (w.dirty) flags += c.peach(`✎${w.dirty} `);
  if (w.ahead) flags += c.blue(`↑${w.ahead} `);
  if (w.behind) flags += c.yellow(`↓${w.behind} `);
  if (st === "prunable") flags += c.overlay("prune ");
  if (st === "unpushed") flags += c.mauve("local ");
  const mrTag = mr ? c[MR_COLOR[mr.state] || "subtext"](`!${mr.iid}${mr.draft ? "d" : ""}`) : "";
  const rest = Math.max(8, width - 5 - FLAGW - MRW - BADGEW - EDW);
  const showBranch = rest >= BRANCH_MIN;
  const nameW = showBranch ? Math.max(18, Math.round(rest * 0.5)) : rest;
  const branchW = rest - nameW;
  const dim = st === "prunable";
  const name = pad(w.name, nameW);
  const body = link ? c.teal(name) : dim ? c.overlay(name) : selected ? c.text(name) : c.subtext(name);
  const bcol = TRUNK.has(w.branch) ? "green" : w.branch === "detached" ? "red" : "overlay";
  const branch = showBranch
    ? pad(c[bcol](truncateToWidth(w.branch || "", Math.max(1, branchW - 1))), branchW)
    : "";
  return line(selected, [
    ` ${selected ? c.lavender("▸") : " "} `,
    `${c[col](g)} `,
    body,
    branch,
    pad(flags, FLAGW),
    pad(mrTag, MRW),
    badge,
    edBadge,
  ]);
}

const MR_ROW: MrHeaderRow = { kind: "mrs", id: "@openmrs" };
const TIX_ROW: TicketHeaderRow = { kind: "tickets", id: "@tickets" };
const HEAD_ROWS: Record<string, HeaderActionRow> = { [MR_ROW.id]: MR_ROW, [TIX_ROW.id]: TIX_ROW };
const HEAD_HIT = { i: -1, row: null } as const;
const TAB_ROWS: TabRow[] = FILTERS.map((name, i) => ({ kind: "tab", id: `@tab${i}`, filter: i, name }));
let segGeom: Array<{ row: HeaderActionRow | TabRow; line: number; from: number; to: number }> = [];

class Board implements Component {
  tui: TuiAltScreen;
  hit: Array<HitRef | typeof HEAD_HIT | null>;
  selecting: boolean;
  mapFrame: SwarmFrame | null;
  mapData: SwarmData | null;
  mapTop: number;

  constructor(tui: TuiAltScreen) {
    this.tui = tui;
    this.hit = [];
    this.selecting = false;
    this.mapFrame = null;
    this.mapData = null;
    this.mapTop = 0;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const rows = visibleRows();
    const sel = rows[state.cursor];
    const selDirs = sel ? dirsOf(sel) : [];
    const selId = sel && "id" in sel ? sel.id : "";
    const linked = (row: Row) => {
      const id = "id" in row ? row.id : "";
      return selDirs.length > 0 && id !== selId && dirsOf(row).some((d) => selDirs.includes(d));
    };
    const height = this.tui.terminal.rows;
    const lines: string[] = [];
    const hit: Array<HitRef | typeof HEAD_HIT | null> = [];
    const push = (text: string, ref?: HitRef | typeof HEAD_HIT | null) => {
      lines.push(truncateToWidth(text, width));
      hit.push(ref || null);
    };

    const ags = state.agents.filter((a) => a.agent);
    const counts = ags.reduce<Record<string, number>>((m, a) => {
      const status = a.agent_status || "unknown";
      m[status] = (m[status] || 0) + 1;
      return m;
    }, {});
    const wts = worktreeRows();
    const nDirty = wts.filter((r) => r.st === "dirty").length;
    const nPrune = wts.filter((r) => r.st === "prunable").length;
    const nMR = wts.filter((r) => r.mr && r.mr.state === "opened").length;

    push(c.on.surface(pad(` ${c.bold(c.lavender("herd lead"))}  ${c.overlay(ROOTS.map(tilde).join("  "))}`, width)));
    const nNoBranch = unbranchedTickets().length;
    segGeom = [];
    let segCol = 0;
    const segRow = () => { segCol = 0; };
    const seg = (text: string, row?: HeaderActionRow | TabRow) => {
      const w = visibleWidth(text);
      if (row) segGeom.push({ row, line: lines.length, from: segCol, to: segCol + w });
      segCol += w;
      return text;
    };
    push(FILTERS.map((name, i) => {
      const label = ` ${i + 1} ${name} `;
      return seg(i === state.filter ? c.on.surface(c.bold(c.lavender(label))) : c.overlay(label), TAB_ROWS[i]);
    }).join(""), HEAD_HIT);
    segRow();
    push(
      ` ${c.text(String(ags.length))} ${c.subtext("agents")}  ` +
      `${c.blue(String(counts.working || 0))} ${c.subtext("working")}  ` +
      `${c.red(String(counts.blocked || 0))} ${c.subtext("blocked")}  ` +
      `${c.green(String(counts.done || 0))} ${c.subtext("done")}  ` +
      `${c.overlay(String(counts.idle || 0))} ${c.subtext("idle")}`
    );
    push(
      seg(` ${c.text(String(wts.length))} ${c.subtext("worktrees")}  `) +
      seg(`${c.peach(String(nDirty))} ${c.subtext("dirty")}  `) +
      seg(`${c.overlay(String(nPrune))} ${c.subtext("prunable")}  `) +
      seg(`${c.mauve(String(nMR))} ${c.subtext("open MRs")}`, MR_ROW) +
      seg(`  ${c.yellow(String(activeTicketRows().length))} ${c.subtext("active tickets")}` +
        (nNoBranch ? ` ${c.peach(`+${nNoBranch}`)} ${c.subtext("no branch")}` : ""), TIX_ROW) +
      (state.loading ? c.teal(`   ${SPIN[state.tick % SPIN.length]} `) + c.overlay(state.loading) : "") +
      (state.cachedAt ? c.overlay(`  cached ${ago(state.cachedAt)} ago`) : ""),
      HEAD_HIT
    );

    const chrome = lines.length + 2;
    const body = Math.max(3, height - chrome);

    if (state.cursor < state.scroll) state.scroll = state.cursor;
    if (state.cursor >= state.scroll + body) state.scroll = state.cursor - body + 1;
    state.scroll = Math.max(0, Math.min(state.scroll, Math.max(0, rows.length - body)));

    let selLine = -1;
    if (FILTERS[state.filter] === "swarm") {
      this.mapTop = lines.length;
      this.mapData = buildSwarmData();
      this.mapFrame = renderSwarmFrame({
        data: this.mapData,
        width,
        rows: body,
        now: Date.now(),
        sel: state.mapSel,
        me: MY_PANE,
      });
      for (const l of this.mapFrame.lines) push(l);
    } else {
      this.mapFrame = null;
    }
    for (let i = state.scroll; i < Math.min(rows.length, state.scroll + body); i++) {
      const row = rows[i];
      if (!row) continue;
      const selected = i === state.cursor;
      if (selected) selLine = lines.length;
      if (row.kind === "head") {
        const bar = "─".repeat(Math.max(0, width - visibleWidth(row.label) - 3));
        push(` ${c.bold(c.overlay(row.label))} ${c.surface(bar)}`, null);
      } else if (row.kind === "empty") {
        push(`   ${c.overlay(row.label)}`, null);
      } else if (row.kind === "perm") {
        push(line(selected, [
          ` ${selected ? c.lavender("▸") : " "} `,
          `${c.red("⚠")} `,
          pad(selected ? c.text(row.label) : c.peach(row.label), Math.max(8, width - 5)),
        ]), { i, row });
      } else if (row.kind === "spin") {
        push(`   ${c.teal(SPIN[state.tick % SPIN.length]!)} ${c.overlay(row.label)}`, null);
      } else if (row.kind === "wshead") {
        push(` ${c.bold(c.mauve(row.label))}`, null);
      } else if (row.kind === "repohead") {
        const head = `   ${c.bold(c.mauve(row.label))} ${c.overlay(String(row.count))}`;
        const room = Math.max(1, width - visibleWidth(head) - visibleWidth(row.tally) - 3);
        push(`${head} ${c.surface("·".repeat(room))} ${row.tally} `, null);
      } else if (row.kind === "group") {
        push(renderGroup(row, width, selected), { i, row });
      } else if (row.kind === "agent") {
        push(renderAgent(row, width, selected, linked(row)), { i, row });
      } else if (row.kind === "ed") {
        push(renderEditor(row, width, selected, linked(row)), { i, row });
      } else if (row.kind === "lib") {
        push(renderLibrary(row, width, selected), { i, row });
      } else if (row.kind === "doc") {
        push(renderDoc(row, width, selected), { i, row });
      } else if (row.kind === "ddroll") {
        push(renderDdRoll(row, width), null);
      } else if (row.kind === "dd") {
        push(renderDd(row, width, selected), { i, row });
      } else {
        push(renderWorktree(row, width, selected, linked(row)), { i, row });
      }
    }
    while (lines.length < height - 2) push("");

    const f = FILTERS[state.filter];
    push(c.surface("─".repeat(width)));
    if (state.mode === "search") {
      push(` ${c.mauve("/")}${c.text(state.search)}${c.lavender("█")}${c.overlay("   enter keep · esc clear")}`);
    } else if (state.mode === "prompt") {
      const prompt = state.prompt!;
      push(` ${c.mauve(prompt.label)} ${c.text(prompt.value)}${c.lavender("█")}` +
        c.overlay(`   ${prompt.hint || "enter save · esc cancel"}`));
    } else if (f === "swarm") {
      push(
        c.overlay(" ") + c.subtext("jk") + c.overlay("/click node · ") + c.subtext("↵") + c.overlay(" focus pane · ") +
        (state.inspect ? c.subtext("i") + c.overlay(" hide info · ") : c.mauve("i") + c.overlay(" more info · ")) +
        c.subtext("o") + c.overlay(" browser map · ") +
        c.subtext("tab") + c.overlay(" views · ") +
        c.subtext("?") + c.overlay(" keys · ") + c.subtext("q") + c.overlay(" quit") +
        (state.note ? c.yellow(`  ${state.note}`) : "")
      );
    } else {
      push(
        c.overlay(" ") + c.subtext("jk") + c.overlay(" move · ") + c.subtext("tab") + c.overlay(`:${f} · `) +
        c.subtext("/") + c.overlay(" find · ") + c.subtext("↵") + c.overlay(" focus · ") +
        (state.inspect ? c.subtext("i") + c.overlay(" hide info · ") : c.mauve("i") + c.overlay(" more info · ")) +
        c.subtext("y") + c.overlay("/") + c.subtext("e") + c.overlay("/") + c.subtext("t") + c.overlay("/") + c.subtext("a") +
        c.overlay(" copy/nvim/tode/agent · ") +
        c.subtext("r") + c.overlay("/") + c.subtext("p") + c.overlay("/") + c.subtext("R") +
        c.overlay(" scan/origin/agent · ") +
        c.subtext("?") + c.overlay(" keys · ") + c.subtext("q") + c.overlay(" quit") +
        (state.search ? c.mauve(`  /${state.search}`) : "") +
        (state.note ? c.yellow(`  ${state.note}`) : "")
      );
    }

    this.hit = hit;
    const out = lines.slice(0, height);
    state.tipGeom = null;
    if (state.menu) return overlayMenu(out, width);
    state.menuGeom = null;
    if (state.help) return overlayHelp(out, width);
    if (state.headSel) {
      const detail = detailFor(HEAD_ROWS[state.headSel]);
      const at = segGeom.find((g) => g.row.id === state.headSel);
      if (detail && at) return overlayTip(out, width, detail, at.line);
    }
    if (state.inspect && this.mapFrame && state.mapSel) {
      const detail = mapDetail(state.mapSel, this.mapData);
      const anchor = this.mapFrame.rowOf(state.mapSel);
      if (detail && anchor != null) return overlayTip(out, width, detail, this.mapTop + anchor);
    }
    if (state.inspect && selLine >= 0) {
      const detail = detailFor(rows[state.cursor]);
      if (detail) return overlayTip(out, width, detail, selLine);
    }
    return out;
  }

  move(d: number): void {
    const rows = visibleRows();
    let n = state.cursor;
    for (let k = 0; k < rows.length; k++) {
      n = Math.max(0, Math.min(rows.length - 1, n + d));
      const row = rows[n];
      if (row && ["agent", "ed", "wt", "group", "lib", "doc", "dd", "perm"].includes(row.kind)) break;
      if (n === 0 || n === rows.length - 1) break;
    }
    state.cursor = n;
    this.tui.requestRender();
  }

  sectionStops(rows: Row[]): number[] {
    const nav = (r: Row | undefined) => r && ["agent", "ed", "wt", "group", "lib", "doc", "dd", "perm"].includes(r.kind);
    const boundary = (r: Row | undefined) => r && ["head", "wshead", "repohead", "group"].includes(r.kind);
    const stops: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (!boundary(rows[i])) continue;
      let land = -1;
      for (let n = i; n < rows.length; n++) if (nav(rows[n])) { land = n; break; }
      if (land >= 0) stops.push(land);
    }
    return [...new Set(stops)].sort((a, b) => a - b);
  }

  jump(dir: number): void {
    const rows = visibleRows();
    const stops = this.sectionStops(rows);
    if (stops.length < 2) return this.move(dir > 0 ? 5 : -5);
    const next = dir > 0
      ? stops.find((s) => s > state.cursor)
      : [...stops].reverse().find((s) => s < state.cursor);
    if (next === undefined) return this.move(dir > 0 ? 5 : -5);
    state.cursor = next;
    this.tui.requestRender();
  }

  selected(): Row | undefined { return visibleRows()[state.cursor]; }

  activate(): void {
    const sel = this.selected();
    if (!sel) return;
    if (sel.kind === "group") {
      if (state.collapsed.has(sel.tabId)) state.collapsed.delete(sel.tabId);
      else state.collapsed.add(sel.tabId);
    } else if (sel.kind === "agent" || sel.kind === "ed") {
      focusPane(sel.id);
    } else if (sel.kind === "wt") {
      state.menu = worktreeMenu(sel);
    } else if (sel.kind === "lib") {
      openInEditor(sel.e.file, sel.e.name);
    } else if (sel.kind === "doc") {
      state.menu = docMenu(sel);
    } else if (sel.kind === "dd") {
      if (sel.e.type === "dashboard") openUrl(sel.e.url, `${sel.e.label} dashboard`);
      else state.menu = datadogMenu(sel);
    } else if (sel.kind === "perm") {
      state.menu = permissionMenu(sel.issue);
    }
    this.tui.requestRender();
  }

  menuClick(row: number): void {
    const g = state.menuGeom;
    const menu = state.menu;
    if (!g || !menu) return;
    const i = row - 1 - g.firstLine;
    const item = i >= 0 && i < g.count ? menu.items[i] : null;
    if (item?.keepOpen) menu.cursor = i; else state.menu = null;
    runMenuItem(item || undefined);
    this.tui.requestRender();
  }

  refAt(screenRow: number, col: number): HitRef | null {
    if (state.menu || state.help) return null;
    const ref = this.hit[screenRow - 1] || null;
    if (!ref) return null;
    if (ref !== HEAD_HIT) return ref as HitRef;
    const s = segGeom.find((g) => g.line === screenRow - 1 && col - 1 >= g.from && col - 1 < g.to);
    return s ? { i: -1, row: s.row } : null;
  }

  overTip(screenRow: number): boolean {
    const g = state.tipGeom;
    const line = screenRow - 1;
    return !!g && line >= g.top && line < g.top + g.height;
  }

  dismissTip(): void {
    state.inspect = false;
    state.headSel = null;
    this.tui.requestRender();
  }

  clearHeadSel(): void {
    if (!state.headSel) return;
    state.headSel = null;
    this.tui.requestRender();
  }

  handleMouse(data: string): string {
    const pass: string[] = [];
    for (const m of data.matchAll(MOUSE_SEQ)) {
      const btn = +m[1]!;
      const col = +m[2]!;
      const row = +m[3]!;
      const kind = m[4];
      if (this.selecting) {
        pass.push(m[0]);
        if (kind === "m") this.selecting = false;
        continue;
      }
      if (btn === 0 && kind === "M" && !state.menu && this.overTip(row)) {
        this.selecting = true;
        pass.push(m[0]);
        continue;
      }
      if (btn === 64) { this.move(-1); continue; }
      if (btn === 65) { this.move(1); continue; }
      if (btn !== 0 || kind !== "M") continue;
      if (state.menu) { this.menuClick(row); continue; }
      if (FILTERS[state.filter] === "swarm" && this.mapFrame && row - 1 >= this.mapTop) {
        this.clearHeadSel();
        const id = this.mapFrame.hitAt(col - 1, row - 1 - this.mapTop);
        if (!id) {
          if (state.mapSel) { state.mapSel = null; this.tui.requestRender(); }
          continue;
        }
        if (state.mapSel === id) {
          const n = this.mapData?.nodes.find((x) => x.id === id);
          if (n?.kind === "agent") focusPane(id);
        } else {
          state.mapSel = id;
        }
        this.tui.requestRender();
        continue;
      }
      const ref = this.refAt(row, col);
      if (!ref) { this.clearHeadSel(); continue; }
      if (ref.i < 0) {
        if (ref.row.kind === "tab") {
          state.headSel = null;
          this.setFilter(ref.row.filter);
          continue;
        }
        const id = ref.row.id;
        if (state.headSel !== id) { state.headSel = id; this.tui.requestRender(); continue; }
        state.headSel = null;
        if (ref.row === MR_ROW) openAllMRs();
        if (ref.row === TIX_ROW) openAllTickets();
        this.tui.requestRender();
        continue;
      }
      this.clearHeadSel();
      if (state.cursor === ref.i) { this.activate(); continue; }
      state.cursor = ref.i;
      this.tui.requestRender();
    }
    return pass.join("");
  }

  setFilter(i: number): void {
    state.filter = i;
    state.cursor = 0;
    state.scroll = 0;
    syncMapTimer();
    this.move(1);
  }

  handleInput(data: string): void {
    const key = (id: Parameters<typeof matchesKey>[1]) => matchesKey(data, id);
    const ch = decodeKittyPrintable(data) ?? (data.length === 1 && data >= " " ? data : "");
    this.clearHeadSel();

    if (state.menu) {
      const m = state.menu;
      // an editing row owns every key, or q/j/k/digits would never reach the input
      if (m.edit) {
        const e = m.edit;
        if (key(Key.esc) || key("ctrl+c")) { m.edit = null; return this.tui.requestRender(); }
        if (key(Key.enter)) { m.edit = null; e.save(e.value); return this.tui.requestRender(); }
        if (key(Key.backspace) || key(Key.delete)) { e.value = e.value.slice(0, -1); return this.tui.requestRender(); }
        if (ch) { e.value += ch; return this.tui.requestRender(); }
        return;
      }
      if (key(Key.esc) || key("ctrl+c") || ch === "q") { state.menu = null; return this.tui.requestRender(); }
      if (key(Key.up) || ch === "k") { m.cursor = (m.cursor - 1 + m.items.length) % m.items.length; return this.tui.requestRender(); }
      if (key(Key.down) || ch === "j") { m.cursor = (m.cursor + 1) % m.items.length; return this.tui.requestRender(); }
      if (ch >= "1" && ch <= "9" && +ch <= m.items.length) {
        const it = m.items[+ch - 1];
        if (it?.keepOpen) m.cursor = +ch - 1; else state.menu = null;
        runMenuItem(it);
        return this.tui.requestRender();
      }
      if (key(Key.enter) || ch === "l" || ch === " ") {
        const it = m.items[m.cursor];
        if (!it?.keepOpen) state.menu = null;
        runMenuItem(it);
        return this.tui.requestRender();
      }
      return;
    }

    if (state.mode === "prompt") {
      const p = state.prompt!;
      const close = () => { state.mode = "normal"; state.prompt = null; this.tui.requestRender(); };
      if (key(Key.esc) || key("ctrl+c")) return close();
      if (key(Key.enter)) { const v = p.value; close(); return p.run(v), this.tui.requestRender(); }
      if (key(Key.backspace) || key(Key.delete)) { p.value = p.value.slice(0, -1); return this.tui.requestRender(); }
      if (ch) { p.value += ch; return this.tui.requestRender(); }
      return;
    }

    if (state.mode === "search") {
      if (key(Key.esc) || key("ctrl+c")) { state.mode = "normal"; state.search = ""; return this.setFilter(state.filter); }
      if (key(Key.enter)) { state.mode = "normal"; this.tui.requestRender(); return; }
      if (key(Key.backspace) || key(Key.delete)) { state.search = state.search.slice(0, -1); return this.setFilter(state.filter); }
      if (ch) { state.search += ch; return this.setFilter(state.filter); }
      return;
    }

    if (key(Key.esc)) {
      if (state.inspect) { state.inspect = false; return this.tui.requestRender(); }
      if (state.help) { state.help = false; return this.tui.requestRender(); }
      if (FILTERS[state.filter] === "swarm" && state.mapSel) { state.mapSel = null; return this.tui.requestRender(); }
      if (state.search) { state.search = ""; return this.setFilter(state.filter); }
      return;
    }
    if (ch === "i") { state.inspect = !state.inspect; return this.tui.requestRender(); }
    if (ch === "q" || key("ctrl+c")) { shutdown(); return; }
    if (ch === "?") { state.help = !state.help; return this.tui.requestRender(); }
    if (ch === "/") { state.mode = "search"; return this.tui.requestRender(); }
    if (ch === "c" || ch === "C") { state.menu = settingsMenu(); return this.tui.requestRender(); }
    if (FILTERS[state.filter] === "swarm") {
      const order = this.mapFrame?.order || [];
      if (key(Key.up) || key(Key.down) || ch === "j" || ch === "k") {
        if (!order.length) return;
        const d = key(Key.up) || ch === "k" ? -1 : 1;
        const i = state.mapSel ? order.indexOf(state.mapSel) : d > 0 ? -1 : 0;
        state.mapSel = order[(i + d + order.length) % order.length] || null;
        return this.tui.requestRender();
      }
      if (key(Key.enter) || ch === "l" || ch === " " || ch === "f") {
        const n = this.mapData?.nodes.find((x) => x.id === state.mapSel);
        if (n?.kind === "agent") focusPane(n.id);
        else state.note = "jk or click picks an agent first";
        return this.tui.requestRender();
      }
      if (ch === "o") {
        if (state.mapUrl) openUrl(state.mapUrl, "the swarm map in the browser");
        else state.note = "map server still starting";
        return this.tui.requestRender();
      }
    }
    if (key(Key.up) || ch === "k") return this.move(-1);
    if (key(Key.down) || ch === "j") return this.move(1);
    if (ch === "}") return this.jump(1);
    if (ch === "{") return this.jump(-1);
    if (key("ctrl+d") || key(Key.pageDown)) return this.move(12);
    if (key("ctrl+u") || key(Key.pageUp)) return this.move(-12);
    if (ch === "g" || key(Key.home)) { state.cursor = 0; return this.move(1); }
    if (ch === "G" || key(Key.end)) { state.cursor = visibleRows().length - 1; return this.move(-1); }
    if (key(Key.tab)) return this.setFilter((state.filter + 1) % FILTERS.length);
    if (ch >= "1" && ch <= String(FILTERS.length)) return this.setFilter(+ch - 1);
    if (ch === "r") { background("rescan", refreshAll()); return; }
    if (ch === "R") { state.menu = agentDataMenu(); return this.tui.requestRender(); }
    if (ch === "m") { background("MR refresh", refreshMRsNow()); return; }
    if (ch === "p") { state.menu = confirmSync(); return this.tui.requestRender(); }
    if (ch === "P") { state.menu = confirmPruneAll(); return this.tui.requestRender(); }
    if (ch === "z") {
      const groups = visibleRows().filter((r): r is GroupRow => r.kind === "group");
      const anyOpen = groups.some((g) => !state.collapsed.has(g.tabId));
      state.collapsed = anyOpen ? new Set(groups.map((g) => g.tabId)) : new Set();
      return this.setFilter(state.filter);
    }
    if (key(Key.enter) || ch === "l" || ch === " " || ch === "f") return this.activate();
    if (ch === "y" || ch === "e" || ch === "t" || ch === "a" || ch === "A") {
      const t = targetOf(this.selected());
      if (!t) { state.note = "nothing to open here"; return this.tui.requestRender(); }
      if (ch === "y") copyPath(t.file || t.dir);
      else if (ch === "t") openInTode(t.dir, t.file, t.label);
      else if (ch === "e") {
        if (t.file) openInEditor(t.file, t.label);
        else {
          const open = (state.edCorr.byDir.get(t.dir) || [])[0];
          if (open) focusPane(open);
          else launchInTab(t.dir, t.label, "nvim");
        }
      } else {
        const cmd = ch === "a" ? NEW_AGENTS[0] : NEW_AGENTS[1];
        if (cmd) launchInTab(t.dir, t.label, cmd);
      }
      return this.tui.requestRender();
    }
  }
}

const MOUSE_ON = "\x1b[?1000h\x1b[?1004h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1006l\x1b[?1004l\x1b[?1000l";
const MOUSE_SEQ = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
const FOCUS_OUT = "\x1b[O";

const tui = new TuiAltScreen(new ProcessTerminal(), undefined, undefined, { mouse: false });
const board = new Board(tui);
tui.addChild(board);
tui.setFocus(board);

function routeInput(data: string): TuiInputListenerResult {
  if (data.includes(FOCUS_OUT)) board.clearHeadSel();
  const rest = data.replace(MOUSE_SEQ, "");
  if (rest === data) return;
  const forward = board.handleMouse(data);
  return { data: forward + rest };
}

const terminalInput = tui as unknown as { handleTerminalInput(data: string): void };
const baseInput = terminalInput.handleTerminalInput.bind(tui);
terminalInput.handleTerminalInput = (data: string): void => {
  const routed = routeInput(data);
  if (routed?.consume) return;
  const next = routed?.data ?? data;
  if (next) baseInput(next);
};

function dispatchInput(data: string): void {
  const routed = routeInput(data);
  if (routed?.consume) return;
  const next = routed?.data ?? data;
  if (next) board.handleInput(next);
}

function writeSnapshot(): void {
  const snapshot = buildSnapshot({
    agents: state.agents,
    tabs: state.tabs,
    worktrees: state.worktrees,
    editors: state.editors,
    library: state.library,
    mrs: state.mrs,
    corr: state.corr,
    edCorr: state.edCorr,
    live: true,
  });
  if (!saveSnapshot(snapshot)) throw new Error("could not write snapshot cache");
}

let mapTimer: NodeJS.Timeout | null = null;
function syncMapTimer(): void {
  const on = FILTERS[state.filter] === "swarm" && process.env.HERD_LEAD_HEADLESS !== "1";
  if (on && !mapTimer) {
    mapTimer = setInterval(() => tui.requestRender(), 150);
    mapTimer.unref();
  } else if (!on && mapTimer) {
    clearInterval(mapTimer);
    mapTimer = null;
  }
}

let spinTimer: NodeJS.Timeout | null = null;
function setLoading(what: string): void {
  state.loading = what;
  if (what && !spinTimer) {
    spinTimer = setInterval(() => { state.tick++; tui.requestRender(); }, 110);
    spinTimer.unref();
  } else if (!what && spinTimer) {
    clearInterval(spinTimer);
    spinTimer = null;
  }
  tui.requestRender();
}

async function refreshAgentsOnce(): Promise<void> {
  const response = await rpc<{ snapshot?: HerdrSnapshot }>("session.snapshot", {});
  if (response.error) throw new Error(response.error.message || "session.snapshot failed");
  const snap = response.result?.snapshot;
  if (!snap) throw new Error("session.snapshot returned no snapshot");
  state.agents = snap.panes || [];
  state.tabs = snap.tabs || [];
  state.workspaces = snap.workspaces || [];
  state.ws = state.agents.find((p) => p.pane_id === MY_PANE)?.workspace_id || state.ws;
  tui.requestRender();
}

const refreshAgents = coalesceAsync(refreshAgentsOnce);

let edTimer: NodeJS.Timeout | null = null;
function scheduleEditors(delay = 400): void {
  if (edTimer) return;
  edTimer = setTimeout(() => {
    edTimer = null;
    background("editor refresh", refreshEditors());
  }, delay);
  edTimer.unref();
}

async function refreshEditorsOnce(): Promise<void> {
  state.editors = await probeEditors(state.agents);
  state.edCorr = correlateEditors(state.editors, state.worktrees);
  if (!state.library.length) await refreshFiles();
  writeSnapshot();
  tui.requestRender();
}

const refreshEditors = coalesceAsync(refreshEditorsOnce);

async function refreshFilesOnce(): Promise<void> {
  state.library = scanLibrary();
  state.docs = scanDocs();
  tui.requestRender();
  await annotateLibraryVcs(state.library);
  tui.requestRender();
}

const refreshFiles = coalesceAsync(refreshFilesOnce);

async function refreshAll(): Promise<void> {
  state.note = "rescanning…";
  tui.requestRender();
  await refreshAgents();
  await refreshEditors();
  await refreshWorktrees();
  state.datadog = readDatadog();
  state.linear = readLinear();
  state.summaries = readSummaries();
  state.note = "rescanned locally — the worktree menu refreshes one repo, p updates all";
  tui.requestRender();
}

function agentCacheAges(): string {
  const one = (cache: { atMs: number | null } | null, name: string): string =>
    !cache ? `${name} missing` : cache.atMs == null ? `${name} age unknown` : `${name} ${ago(cache.atMs)} old`;
  return [one(state.datadog, "datadog"), one(state.linear, "linear"), one(state.summaries, "summaries")].join(" · ");
}

function reloadAgentCaches(): void {
  state.datadog = readDatadog();
  state.linear = readLinear();
  state.summaries = readSummaries();
  state.note = agentCacheAges();
}

const REFRESH_PROMPT =
  "Refresh the herd-lead agent caches: load the herdr-lead skill and follow its "
  + "'Who refreshes what' section to rewrite datadog.json, linear.json, and "
  + "summaries.json. Write the files, then stop.";

function agentDataMenu(): Menu {
  return {
    title: `agent-owned data — ${agentCacheAges()}`,
    items: [
      { label: "reread both caches from disk", hint: "no network, no agent", run: () => reloadAgentCaches() },
      {
        label: "spawn an agent to refresh them",
        hint: "opens a tab running claude with the refresh prompt",
        run: () => launchInTab(ROOT, "cache refresh", `claude ${JSON.stringify(REFRESH_PROMPT)}`),
      },
      { label: "copy the refresh prompt", hint: "paste into any agent", run: () => copyPath(REFRESH_PROMPT) },
    ],
    cursor: 0,
  };
}

function hydrateFromCache(): boolean {
  const cached = readScanCache();
  if (!cached) return false;
  state.worktrees = cached.worktrees || [];
  state.library = cached.library || [];
  state.docs = cached.docs || [];
  state.cachedAt = cached.at || 0;
  tui.requestRender();
  return cached.fresh === true;
}

let scanMs = 0;

async function refreshWorktreesOnce(): Promise<void> {
  const startedAt = Date.now();
  setLoading("scanning");
  try {
    state.worktrees = await scanWorktrees();
    scanMs = Date.now() - startedAt;
    state.sessions = sessionIndex();
    state.corr = correlate(state.agents.filter((a) => a.agent), state.worktrees, state.sessions);
    state.edCorr = correlateEditors(state.editors, state.worktrees);
    await refreshFiles();
    state.cachedAt = 0;
    if (!writeScanCache({ worktrees: state.worktrees, library: state.library, docs: state.docs })) {
      throw new Error("could not write scan cache");
    }
    writeSnapshot();
  } finally {
    setLoading("");
  }
}

const refreshWorktrees = coalesceAsync(refreshWorktreesOnce);

async function refreshMRsOnce(force = true): Promise<void> {
  setLoading("merge requests");
  try {
    state.mrs = await refreshMRs(state.worktrees, force);
    if (state.mrs.failed) state.note = `MR fetch failed for ${plural(state.mrs.failed, "project")} — kept last known data`;
    state.datadog = readDatadog();
    state.linear = readLinear();
    writeSnapshot();
  } finally {
    setLoading("");
  }
}

let refreshMRsForce = false;
const refreshMRsCoalesced = coalesceAsync(async () => {
  const force = refreshMRsForce;
  refreshMRsForce = false;
  await refreshMRsOnce(force);
});

function refreshMRsNow(force = true): Promise<void> {
  refreshMRsForce ||= force;
  return refreshMRsCoalesced();
}

let stopSub: (() => void) | undefined;
function shutdown(): void {
  try { stopSub?.(); } catch {}
  try { if (mapTimer) clearInterval(mapTimer); } catch {}
  try { if (spinTimer) clearInterval(spinTimer); } catch {}
  try { tui.terminal?.write?.(MOUSE_OFF); } catch {}
  tui.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

export { tui, board, state, refreshAgents, refreshWorktrees, refreshMRsNow, refreshEditors, agentCmds, dispatchInput, doPrune, FILTERS };

if (process.env.HERD_LEAD_HEADLESS === "1") {
  await refreshAgents().catch(() => {});
  await refreshWorktrees();
  await refreshEditors();
  await refreshMRsNow(false);
  state.corr = correlate(state.agents.filter((a) => a.agent), state.worktrees, state.sessions);
} else {

try {
  const dir = process.env.HERDR_PLUGIN_STATE_DIR;
  if (dir) fs.writeFileSync(`${dir}/board.json`, JSON.stringify({ peer: ME, pane: process.env.HERDR_PANE_ID || "" }));
} catch {}

tui.start();
tui.terminal.write(MOUSE_ON);
background("swarm map", startMap(buildSwarmData).then(({ url }) => {
  state.mapUrl = url;
  tui.requestRender();
}));
const cacheFresh = hydrateFromCache();
await refreshAgents();
board.move(1);
scheduleEditors(0);
(cacheFresh
  ? Promise.resolve(setLoading(""))
  : refreshWorktrees())
  .then(() => refreshMRsNow(false))
  .then(() => {
    if (!Object.keys(state.sessions).length) state.sessions = sessionIndex();
    state.corr = correlate(state.agents.filter((a) => a.agent), state.worktrees, state.sessions);
    tui.requestRender();
  })
  .catch((error) => reportFailure("startup refresh", error));

let scanTimer: NodeJS.Timeout | null = null;
let lastScan = Date.now();
function scheduleScan(delay = 4000): void {
  if (scanTimer) return;
  const floor = Math.max(10000, scanMs * 4);
  const wait = Math.max(delay, floor - (Date.now() - lastScan));
  scanTimer = setTimeout(() => {
    scanTimer = null;
    background("scheduled scan", refreshWorktrees()
      .then(() => refreshMRsNow(false))
      .then(() => { lastScan = Date.now(); }));
  }, wait);
  scanTimer.unref();
}

stopSub = subscribe(
  ["pane.agent_status_changed", "pane.created", "pane.closed", "pane.updated", "tab.focused"],
  (message) => {
    const msg = message as { data?: { agent_status?: AgentStatus } };
    background("agent refresh", refreshAgents());
    scheduleEditors();
    const st = msg?.data?.agent_status;
    if (st === "idle" || st === "done" || st === "blocked") scheduleScan();
  }
);

const pollTimer = setInterval(() => scheduleScan(0), 120000);
pollTimer.unref();

}
