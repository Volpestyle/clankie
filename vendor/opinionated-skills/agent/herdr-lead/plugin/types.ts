export type AgentStatus = "working" | "blocked" | "done" | "idle" | "unknown";

export interface Pane {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  label?: string | null;
  agent?: unknown;
  agent_status?: AgentStatus;
  cwd?: string;
  foreground_cwd?: string;
  terminal_title_stripped?: string;
}

export interface Tab {
  tab_id: string;
  workspace_id?: string;
  label?: string | null;
  number?: number;
}

export interface Workspace {
  workspace_id: string;
  label?: string | null;
}

export interface HerdrSnapshot {
  focused_pane_id?: string;
  panes: Pane[];
  tabs: Tab[];
  workspaces: Workspace[];
}

export interface Worktree {
  dir: string;
  name: string;
  parent: string;
  repoRoot: string;
  repo: string;
  linked: boolean;
  branch: string;
  dirty: number;
  ahead: number;
  behind: number;
  unique: number;
  tracked: boolean;
  fetchEpoch: number;
  commitEpoch: number;
  subject: string;
  project: string;
}

export type WorktreeState = "dirty" | "prunable" | "ahead" | "unpushed" | "behind" | "clean";

export interface MergeRequest {
  iid: number;
  state: string;
  draft: boolean;
  title: string;
  url: string;
}

export interface MergeRequestCache {
  at: number;
  byBranch: Record<string, MergeRequest>;
  failed?: number;
}

export interface SessionCmd {
  t: number;
  verb: "prompt" | "run" | "start" | "read" | "wait";
  target: string;
  handoff: boolean;
}

export interface SessionRecord {
  mtime: number;
  title: string | null;
  cwds: Record<string, number>;
  cmds?: SessionCmd[];
}

export type SessionIndex = Record<string, SessionRecord>;

export type LibraryVcsState = "none" | "new" | "dirty" | "nobase" | "branch" | "main";

export interface LibraryVcs {
  state: LibraryVcsState;
  branch: string;
  onMain: boolean;
  base?: string;
  repo?: string;
}

export interface LibraryEntry {
  rootIdx: number;
  name: string;
  group: string;
  file: string;
  dir: string;
  real: string;
  links: string[];
  aliases: string[];
  mtime: number;
  size: number;
  doc: boolean;
  vcs: LibraryVcs | null;
}

export interface DocumentEntry {
  name: string;
  ext: string;
  group: string;
  file: string;
  dir: string;
  mtime: number;
  size: number;
}

export interface DocumentScanIssue {
  dir: string;
  code: string;
}

export interface Editor {
  pane_id: string;
  name: string;
  cwd: string;
  file: string;
  tab_id: string;
  workspace_id: string;
  dir: string;
  wt: string;
}

export interface AgentWorktreeHit {
  name: string;
  dir: string;
  weight: number;
  live: boolean;
}

export interface Correlations {
  agentDirs: Map<string, AgentWorktreeHit[]>;
  dirAgents: Map<string, string[]>;
}

export interface EditorCorrelations {
  byDir: Map<string, string[]>;
}

export interface Ticket {
  id: string;
  url: string;
}

export interface DatadogSeries {
  label: string;
  window?: string;
  bad?: boolean;
  points?: number[];
  query?: string;
  url?: string;
}

export interface DatadogMonitor {
  id: string | number;
  name: string;
  status: "OK" | "Alert" | "Warn" | "No Data" | string;
  scope?: string;
  query?: string;
  url?: string;
  note?: string;
}

export interface DatadogIncident {
  id: string | number;
  title: string;
  severity?: string;
  since?: string;
  url?: string;
}

export interface DatadogCache {
  at: string;
  atMs: number | null;
  env?: string;
  series?: DatadogSeries[];
  monitors?: DatadogMonitor[];
  incidents?: DatadogIncident[];
  dashboards?: Array<{ label: string; url: string }>;
}

export interface LinearIssue {
  id: string;
  title: string;
  state: string;
  url: string;
}

export interface LinearCache {
  at: string;
  atMs: number | null;
  issues: LinearIssue[];
}

/** Clankie-authored one-liners for the agent `i` panel. */
export interface AgentSummary {
  summary: string;
  next?: string;
  at?: string;
}

export interface AgentSummariesCache {
  at: string;
  atMs: number | null;
  agents: Record<string, AgentSummary>;
}

export type ColorName = "base" | "surface" | "overlay" | "text" | "subtext" |
  "red" | "peach" | "yellow" | "green" | "teal" | "blue" | "mauve" | "lavender";

export type Paint = (value: string) => string;

export type Theme = Record<ColorName, Paint> & {
  on: Record<ColorName, Paint>;
  bold: Paint;
  dim: Paint;
  themeName: string;
};

export interface ShellResult {
  ok: boolean;
  out: string;
  err: string;
}

export interface RpcError {
  message?: string;
  [key: string]: unknown;
}

export interface RpcResponse<T> {
  result?: T;
  error?: RpcError;
}

export type SwarmLinkKind = "dispatch" | "handoff" | "watch" | "couple" | "ask" | "on";

export interface SwarmNode {
  id: string;
  kind: "agent" | "hub" | "you";
  label: string;
  cluster: string;
  title?: string;
  status?: AgentStatus;
  tab?: string;
  branch?: string;
}

export interface SwarmLink {
  s: string;
  t: string;
  kind: SwarmLinkKind;
  at: number;
  n: number;
  hot?: boolean;
  live?: boolean;
}

export interface SwarmData {
  at: number;
  me: string;
  theme: { name: string; colors: Record<ColorName, string> };
  nodes: SwarmNode[];
  links: SwarmLink[];
}

export interface BoardSnapshot {
  at: string;
  live: boolean;
  root: string;
  roots: string[];
  totals: {
    agents: number;
    agentsByStatus: Record<string, number>;
    editors: number;
    worktrees: number;
    worktreesByState: Record<string, number>;
    openMRs: number;
    library: number;
  };
  agents: Array<{
    pane: string;
    tab: string;
    tabLabel: string;
    workspace: string;
    status: AgentStatus | undefined;
    title: string;
    label: string;
    worktrees: string[];
  }>;
  editors: Array<{
    pane: string;
    tab: string;
    editor: string;
    file: string;
    cwd: string;
    worktree: string;
  }>;
  worktrees: Array<{
    name: string;
    dir: string;
    branch: string;
    linked: boolean;
    ticket: Ticket | null;
    state: WorktreeState;
    dirty: number;
    ahead: number;
    behind: number;
    unique: number;
    tracked: boolean;
    lastFetch: string | null;
    lastCommit: string | null;
    subject: string;
    project: string;
    mr: MergeRequest | null;
    agents: string[];
    editors: Array<{ pane: string; file: string }>;
  }>;
  library: Array<{
    name: string;
    group: string;
    file: string;
    links: string[];
    aliases: string[];
    size: number;
    modified: string;
    vcs: LibraryVcs | null;
  }>;
}
