import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type {
  AgentSummariesCache, BoardSnapshot, Correlations, DatadogCache, DocumentEntry, DocumentScanIssue,
  Editor, EditorCorrelations, HerdrSnapshot, LibraryEntry, LinearCache,
  LibraryVcsState, MergeRequest, MergeRequestCache, Pane, SessionCmd, SessionIndex,
  SessionRecord, ShellResult, Tab, Ticket, Worktree, WorktreeState,
} from "./types.ts";
import { envInt, readJson, rpc, shOut, writeJson } from "./runtime.ts";
export { coalesceAsync, loadTheme, rpc, shOut, subscribe } from "./runtime.ts";

const STATE = process.env.HERDR_PLUGIN_STATE_DIR
  || path.join(os.homedir(), ".local/state/herdr/plugins/herd-lead");
const PROJECTS = path.join(os.homedir(), ".claude/projects");
const HOME = os.homedir();

export const SETTINGS = path.join(STATE, "settings.json");

interface Settings {
  roots?: string | string[];
  depth?: string | number;
  linearUrl?: string;
  linearTeams?: string;
  libRoots?: string | string[];
  libDocs?: string | string[];
  docRoots?: string | string[];
  ddDashboards?: string;
  agents?: string | string[];
}

export function readSettings(): Settings {
  return readJson<Settings>(SETTINGS, {});
}

export function writeSettings(next: Settings): boolean {
  return writeJson(SETTINGS, next, 2);
}

const untilde = (p: string): string => (p === "~" ? HOME : p.startsWith("~/") ? path.join(HOME, p.slice(2)) : p);
const split = (v: unknown): string[] => String(v || "").split(":").map((s) => s.trim()).filter(Boolean);
const splitPaths = (v: unknown): string[] => split(v).map(untilde);

const CFG_ENV: Record<keyof Omit<Settings, "agents">, string> = {
  roots: "HERD_LEAD_ROOT",
  depth: "HERD_LEAD_DEPTH",
  linearUrl: "HERD_LEAD_LINEAR_URL",
  linearTeams: "HERD_LEAD_LINEAR_TEAMS",
  libRoots: "HERD_LEAD_LIB_ROOTS",
  libDocs: "HERD_LEAD_LIB_DOCS",
  docRoots: "HERD_LEAD_DOC_ROOTS",
  ddDashboards: "HERD_LEAD_DD_DASHBOARDS",
};

export function cfgRaw(key: keyof Omit<Settings, "agents">): string {
  const s = readSettings()[key];
  if (typeof s === "string" && s.trim()) return s.trim();
  if (typeof s === "number") return String(s);
  if (Array.isArray(s) && s.length) return s.join(":");
  return (process.env[CFG_ENV[key]] || "").trim();
}

const DEFAULT_LIB_DOCS = [
  `${HOME}/.claude/CLAUDE.md`,
  `${HOME}/CLAUDE.md`,
  `${HOME}/AGENTS.md`,
  `${HOME}/.codex/AGENTS.md`,
  `${HOME}/.agents/AGENTS.md`,
].join(":");

const DEFAULT_LIB_ROOTS = [`${HOME}/dev/skills`, `${HOME}/.agents/skills`].join(":");

export let ROOTS: string[];
export let ROOT: string;
export let DEPTH: number;
export let LIB_ROOTS: string[];
export let DD_DASHBOARDS: Array<{ label: string; url: string }>;
let LINEAR_URL: string;
let TEAM_KEYS: string[];
let LIB_DOCS: string[];
let DOC_ROOTS: string[];

export function reloadCfg() {
  ROOTS = splitPaths(cfgRaw("roots"));
  ROOT = ROOTS[0] || HOME;
  DEPTH = envInt(cfgRaw("depth"), 2, 0);
  LINEAR_URL = cfgRaw("linearUrl").replace(/\/$/, "");
  TEAM_KEYS = cfgRaw("linearTeams").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  LIB_ROOTS = splitPaths(cfgRaw("libRoots") || DEFAULT_LIB_ROOTS);
  LIB_DOCS = splitPaths(cfgRaw("libDocs") || DEFAULT_LIB_DOCS);
  DOC_ROOTS = splitPaths(cfgRaw("docRoots") || `${HOME}/Documents`);
  DD_DASHBOARDS = cfgRaw("ddDashboards").split(/\s+/).filter(Boolean).map((s) => {
    const i = s.indexOf("=");
    return i < 0 ? null : { label: s.slice(0, i), url: s.slice(i + 1) };
  }).filter((entry): entry is { label: string; url: string } => entry !== null);
}
reloadCfg();

export const ME = process.env.HERD_LEAD_PEER || "";

try { fs.mkdirSync(STATE, { recursive: true }); } catch {}

const sh = (cmd: string, args: string[], cwd?: string): Promise<string> => shOut(cmd, args, cwd).then((r) => (r.ok ? r.out : ""));

export async function removeWorktree(dir: string) {
  const status = await shOut("git", ["-C", dir, "status", "--porcelain"]);
  if (!status.ok) return { ok: false, err: "not a git worktree" };
  if (status.out) {
    const n = status.out.split("\n").length;
    return { ok: false, err: `${n} uncommitted change${n === 1 ? "" : "s"}` };
  }
  const branch = (await shOut("git", ["-C", dir, "symbolic-ref", "--short", "-q", "HEAD"])).out;
  const listed = await shOut("git", ["-C", dir, "worktree", "list", "--porcelain"]);
  const main = (listed.out.match(/^worktree (.+)$/m) || [])[1] || "";
  if (!main) return { ok: false, err: "cannot locate main checkout" };
  if (safeReal(main) === safeReal(dir)) return { ok: false, err: "this is the main checkout" };
  const rm = await shOut("git", ["-C", main, "worktree", "remove", dir]);
  if (!rm.ok) return { ok: false, err: (rm.err.split("\n")[0] || "remove failed").replace(/^fatal: /, "") };
  return { ok: true, branch, main };
}

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function ticketFor(branch: string): Ticket | null {
  if (!branch || !TEAM_KEYS.length) return null;
  const re = new RegExp(`(?:^|[^a-z0-9])(${TEAM_KEYS.map(escapeRegex).join("|")})-(\\d{1,6})(?![0-9])`, "i");
  const m = branch.match(re);
  if (!m) return null;
  const id = `${m[1]!.toUpperCase()}-${m[2]}`;
  return { id, url: LINEAR_URL ? `${LINEAR_URL}/issue/${id}` : "" };
}

function findRepos(root: string, depth = DEPTH): string[] {
  const out: string[] = [];
  const walk = (dir: string, d: number) => {
    if (d > depth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.name === ".git")) { out.push(dir); return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === "node_modules" || e.name.startsWith(".")) continue;
      walk(path.join(dir, e.name), d + 1);
    }
  };
  walk(root, 0);
  return out;
}

const GIT_PROBE = `
b=$(git symbolic-ref --short -q HEAD || echo "detached")
base=""
for r in origin/main origin/master main master; do
  git rev-parse --verify --quiet "$r" >/dev/null 2>&1 && { base="$r"; break; }
done
dirty=$(git status --porcelain 2>/dev/null | grep -c . || true)
ahead=0; behind=0; tracked=0
if git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' >/dev/null 2>&1; then
  tracked=1
  set -- $(git rev-list --left-right --count '@{upstream}...HEAD' 2>/dev/null)
  behind="\${1:-0}"; ahead="\${2:-0}"
fi
unique=0
[ -n "$base" ] && unique=$(git cherry "$base" HEAD 2>/dev/null | grep -c '^+' || true)
fetch_epoch=0
git_dir=$(git rev-parse --git-common-dir 2>/dev/null)
[ -n "$git_dir" ] && fetch_epoch=$(stat -f %m "$git_dir/FETCH_HEAD" 2>/dev/null || stat -c %Y "$git_dir/FETCH_HEAD" 2>/dev/null || echo 0)
printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' \
  "$b" "$dirty" "$ahead" "$behind" "$unique" "$tracked" \
  "$fetch_epoch" \
  "$(git log -1 --format=%ct 2>/dev/null)" \
  "$(git log -1 --format=%s 2>/dev/null | tr '\t' ' ')" \
  "$(git remote get-url origin 2>/dev/null)" \
  "$(git worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')"
`;

function gitlabPath(remote: string): string {
  const m = remote.match(/gitlab\.com[:/](.+?)(?:\.git)?$/);
  return m?.[1] || "";
}

const SCAN_LIMIT = envInt(
  process.env.HERD_LEAD_SCAN_CONCURRENCY,
  Math.max(8, os.cpus().length * 2),
);

async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

async function probeWorktree(dir: string): Promise<Worktree | null> {
  const raw = await sh("bash", ["-c", GIT_PROBE], dir);
  if (!raw) return null;
  const [branch = "detached", dirty = "0", ahead = "0", behind = "0", unique = "0", tracked = "0",
    fetchEpoch = "0", ct = "0", subject = "", remote = "", mainRoot = ""] = raw.split("\t");
  let linked = false;
  try { linked = fs.statSync(path.join(dir, ".git")).isFile(); } catch {}
  return {
    dir,
    name: path.basename(dir),
    parent: path.basename(path.dirname(dir)),
    repoRoot: mainRoot || dir,
    repo: path.basename(mainRoot || dir),
    linked,
    branch,
    dirty: +dirty || 0,
    ahead: +ahead || 0,
    behind: +behind || 0,
    unique: +unique || 0,
    tracked: tracked === "1",
    fetchEpoch: +fetchEpoch || 0,
    commitEpoch: +ct || 0,
    subject: subject || "",
    project: gitlabPath(remote || ""),
  };
}

export async function scanWorktrees(roots: string | string[] = ROOTS): Promise<Worktree[]> {
  const dirs = [...new Set([roots].flat().flatMap((r) => findRepos(r)))];
  const rows = await pool(dirs, SCAN_LIMIT, probeWorktree);
  return rows.filter((row): row is Worktree => row !== null).sort((a, b) => b.commitEpoch - a.commitEpoch);
}

const FETCH_LIMIT = envInt(process.env.HERD_LEAD_FETCH_CONCURRENCY, 8);

export async function fetchRepo(w: Pick<Worktree, "repoRoot" | "dir">): Promise<Pick<ShellResult, "ok" | "err">> {
  const r = await shOut("git", ["-C", w.repoRoot || w.dir, "fetch", "origin", "--prune"]);
  return { ok: r.ok, err: (r.err.split("\n")[0] || "").replace(/^fatal: /, "") };
}

export interface SkippedWorktree {
  w: Worktree;
  why: string;
  reason: string;
}

export function pullCandidates(worktrees: Worktree[], busy: Set<string> = new Set()) {
  const go: Worktree[] = [];
  const skip: SkippedWorktree[] = [];
  for (const w of worktrees) {
    const [reason, why] =
      busy.has(w.dir) ? ["agent working here", "agent working here"] :
      w.dirty ? ["uncommitted changes", `${w.dirty} uncommitted`] :
      !w.branch || w.branch === "detached" ? ["detached HEAD", "detached HEAD"] :
      !w.tracked ? ["no upstream", "no upstream"] :
      ["", ""];
    if (reason) skip.push({ w, why, reason });
    else go.push(w);
  }
  return { go, skip };
}

export async function syncWorktrees(
  worktrees: Worktree[],
  busy: Set<string> = new Set(),
  onProgress: (message: string) => void = () => {},
) {
  const { go, skip } = pullCandidates(worktrees, busy);
  const roots = [...new Set(worktrees.map((w) => w.repoRoot || w.dir))];

  let n = 0;
  const fetched = await pool(roots, FETCH_LIMIT, async (root) => {
    const r = await shOut("git", ["-C", root, "fetch", "--all", "--prune"]);
    onProgress(`fetching ${++n}/${roots.length}`);
    return { root, ok: r.ok, err: (r.err.split("\n")[0] || "").replace(/^fatal: /, "") };
  });

  const byRepo = new Map<string, Worktree[]>();
  for (const worktree of go) {
    const root = worktree.repoRoot || worktree.dir;
    const group = byRepo.get(root) || [];
    if (!byRepo.has(root)) byRepo.set(root, group);
    group.push(worktree);
  }

  n = 0;
  const merged = (await pool([...byRepo.values()], FETCH_LIMIT, async (group) => {
    const results = [];
    for (const w of group) {
      const r = await shOut("git", ["-C", w.dir, "merge", "--ff-only", "@{upstream}"]);
      onProgress(`updating ${++n}/${go.length}`);
      results.push({
        w,
        ok: r.ok,
        already: /already up[- ]to[- ]date/i.test(`${r.out}\n${r.err}`),
        err: r.ok ? "" : (r.err.split("\n")[0] || "not fast-forwardable").replace(/^fatal: /, ""),
      });
    }
    return results;
  })).flat();

  return {
    roots: roots.length,
    fetchFailed: fetched.filter((f) => !f.ok),
    updated: merged.filter((x) => x.ok && !x.already),
    unchanged: merged.filter((x) => x.ok && x.already).length,
    failed: merged.filter((x) => !x.ok),
    skipped: skip,
  };
}

const MR_CACHE = path.join(STATE, "mrs.json");
const MR_TTL = 5 * 60 * 1000;

export function readMRCache(): MergeRequestCache {
  return readJson<MergeRequestCache>(MR_CACHE, { at: 0, byBranch: {} });
}

interface GitLabMergeRequest {
  iid: number;
  state: string;
  draft?: boolean;
  work_in_progress?: boolean;
  title: string;
  web_url: string;
  source_branch: string;
}

const MR_PAGE_SIZE = 100;

function isGitLabMergeRequest(value: unknown): value is GitLabMergeRequest {
  if (!value || typeof value !== "object") return false;
  const mr = value as Record<string, unknown>;
  return Number.isInteger(mr.iid)
    && typeof mr.state === "string"
    && typeof mr.title === "string"
    && typeof mr.web_url === "string"
    && typeof mr.source_branch === "string";
}

async function listMergeRequests(project: string, branch: string): Promise<GitLabMergeRequest[] | null> {
  const endpoint = `projects/${encodeURIComponent(project)}/merge_requests?scope=all&state=all&source_branch=${encodeURIComponent(branch)}&per_page=${MR_PAGE_SIZE}`;
  const result = await shOut("glab", ["api", endpoint, "--paginate", "--output", "ndjson"]);
  if (!result.ok) return null;
  const mergeRequests: GitLabMergeRequest[] = [];
  for (const line of result.out.split("\n").filter(Boolean)) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return null; }
    if (!isGitLabMergeRequest(parsed)) return null;
    mergeRequests.push(parsed);
  }
  return mergeRequests;
}

export async function refreshMRs(worktrees: Worktree[], force = false): Promise<MergeRequestCache> {
  const cached = readMRCache();
  if (!force && Date.now() - cached.at < MR_TTL) return cached;
  const byProject = new Map<string, Set<string>>();
  for (const worktree of worktrees) {
    if (!worktree.project || ["main", "master"].includes(worktree.branch)) continue;
    const branches = byProject.get(worktree.project) || new Set<string>();
    if (!byProject.has(worktree.project)) byProject.set(worktree.project, branches);
    branches.add(worktree.branch);
  }
  if (!byProject.size) return cached;
  const byBranch: Record<string, MergeRequest> = {};
  const failedBranches = new Set<string>();
  const failedProjects = new Set<string>();
  const targets = [...byProject].flatMap(([project, branches]) =>
    [...branches].map((branch) => ({ project, branch })));
  await pool(targets, FETCH_LIMIT, async ({ project, branch }) => {
    const key = `${project}#${branch}`;
    const list = await listMergeRequests(project, branch);
    if (!list) {
      failedBranches.add(key);
      failedProjects.add(project);
      return;
    }
    for (const mr of list) {
      if (mr.source_branch !== branch) continue;
      const prev = byBranch[key];
      if (prev && prev.iid > mr.iid) continue;
      byBranch[key] = {
        iid: mr.iid,
        state: mr.state,
        draft: !!(mr.draft || mr.work_in_progress),
        title: mr.title,
        url: mr.web_url,
      };
    }
  });
  for (const [key, mr] of Object.entries(cached.byBranch || {})) {
    if (failedBranches.has(key) && !byBranch[key]) byBranch[key] = mr;
  }
  const next = { at: Date.now(), byBranch, failed: failedProjects.size };
  writeJson(MR_CACHE, next);
  return next;
}

export function mrFor(w: Worktree, mrs: MergeRequestCache): MergeRequest | null {
  return mrs.byBranch?.[`${w.project}#${w.branch}`] || null;
}

export function classify(
  w: Pick<Worktree, "dirty" | "branch" | "behind" | "unique" | "tracked" | "ahead">,
  mr: Pick<MergeRequest, "state"> | null,
): WorktreeState {
  if (w.dirty > 0) return "dirty";
  if (mr && (mr.state === "merged" || mr.state === "closed")) return "prunable";
  if (["main", "master"].includes(w.branch)) return w.behind > 0 ? "behind" : "clean";
  if (w.unique === 0 && w.tracked) return "prunable";
  if (w.ahead > 0) return "ahead";
  if (!w.tracked) return "unpushed";
  if (w.behind > 0) return "behind";
  return "clean";
}

const SESS_CACHE = path.join(STATE, "sessions.json");

const CMD_RE = /herdr\s+(?:agent\s+(prompt|read|wait|start)|pane\s+(run))\b/g;
const PANE_ID_RE = /w\d+:p[A-Za-z0-9]+/;
const TS_RE = /"timestamp"\s*:\s*"([^"]+)"/;

export function mineCmds(line: string, fallbackT: number): SessionCmd[] {
  const out: SessionCmd[] = [];
  const ts = TS_RE.exec(line);
  const t = (ts && Date.parse(ts[1]!)) || fallbackT;
  for (const m of line.matchAll(CMD_RE)) {
    const from = (m.index ?? 0) + m[0].length;
    const window = line.slice(from, from + 400);
    const target = PANE_ID_RE.exec(window)?.[0];
    if (!target) continue;
    out.push({
      t,
      verb: (m[1] || m[2]) as SessionCmd["verb"],
      target,
      handoff: window.includes(".herdr-handoffs"),
    });
  }
  return out;
}

export function sessionIndex(): SessionIndex {
  const cache = readJson<Record<string, SessionRecord>>(SESS_CACHE, {});
  const next: Record<string, SessionRecord> = {};
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(PROJECTS).map((d) => path.join(PROJECTS, d)); } catch {}
  for (const d of dirs) {
    let files: string[] = [];
    try { files = fs.readdirSync(d).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) {
      const full = path.join(d, f);
      let st: fs.Stats;
      try { st = fs.statSync(full); } catch { continue; }
      const key = full;
      const prev = cache[key];
      if (prev && prev.mtime === st.mtimeMs && prev.cmds) { next[key] = prev; continue; }
      let title = null;
      const cwds: Record<string, number> = {};
      const cmds: SessionCmd[] = [];
      try {
        const raw = fs.readFileSync(full, "utf8");
        for (const line of raw.split("\n")) {
          if (!line) continue;
          const hasTitle = line.includes('"aiTitle"');
          const hasCwd = line.includes('"cwd"');
          if (line.includes("herdr")) cmds.push(...mineCmds(line, st.mtimeMs));
          if (!hasTitle && !hasCwd) continue;
          let e: { aiTitle?: string; cwd?: string };
          try { e = JSON.parse(line) as { aiTitle?: string; cwd?: string }; } catch { continue; }
          if (e.aiTitle) title = e.aiTitle;
          if (e.cwd) cwds[e.cwd] = (cwds[e.cwd] || 0) + 1;
        }
      } catch { continue; }
      if (cmds.length > 500) cmds.splice(0, cmds.length - 500);
      next[key] = { mtime: st.mtimeMs, title, cwds, cmds };
    }
  }
  writeJson(SESS_CACHE, next);
  const byTitle: SessionIndex = {};
  for (const v of Object.values(next)) {
    if (!v.title) continue;
    const prev = byTitle[v.title];
    if (prev && prev.mtime > v.mtime) continue;
    byTitle[v.title] = v;
  }
  return byTitle;
}

const LIB_LINK_ROOTS: Array<[string, string]> = [
  [`${HOME}/.claude/skills`, "c"],
  [`${HOME}/.agents/skills`, "a"],
  [`${HOME}/.codex/skills`, "x"],
  [`${HOME}/.grok/skills`, "g"],
];

const SKILL_FILES = ["SKILL.md", "AGENT.md", "AGENTS.md", "README.md"];

export const realpath = safeReal;
export const tilde = (p: string): string => (p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p);

function statSafe(p: string): fs.Stats | null {
  try { return fs.statSync(p); } catch { return null; }
}

const LIB_DEPTH = envInt(process.env.HERD_LEAD_LIB_DEPTH, 2, 0);

interface SkillDirectory {
  dir: string;
  file: string;
  rel: string[];
}

function findSkillDirs(root: string, maxDepth = LIB_DEPTH): SkillDirectory[] {
  const out: SkillDirectory[] = [];
  const walk = (dir: string, depth: number, rel: string[]) => {
    const file = SKILL_FILES.map((f) => path.join(dir, f)).find((f) => statSafe(f)?.isFile());
    if (file && rel.length) {
      out.push({ dir, file, rel });
      return;
    }
    if (depth >= maxDepth) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = path.join(dir, e.name);
      if (!statSafe(p)?.isDirectory()) continue;
      walk(p, depth + 1, [...rel, e.name]);
    }
  };
  walk(root, 0, []);
  return out;
}

const VCS_PROBE = `
b=$(git symbolic-ref --short -q HEAD || echo detached)
base=""
for r in origin/main origin/master main master; do
  git rev-parse --verify --quiet "$r" >/dev/null 2>&1 && { base="$r"; break; }
done
printf 'B\\t%s\\n' "$b"
printf 'R\\t%s\\n' "$base"
git diff --name-only 2>/dev/null | sed 's|^|D\\t|'
git diff --cached --name-only 2>/dev/null | sed 's|^|D\\t|'
git ls-files --others --exclude-standard 2>/dev/null | sed 's|^|U\\t|'
[ -n "$base" ] && git diff --name-only "$base" -- 2>/dev/null | sed 's|^|X\\t|'
`;

interface RepoState {
  top: string;
  branch: string;
  base: string;
  dirty: Set<string>;
  untracked: Set<string>;
  off: Set<string>;
}

async function repoState(top: string): Promise<RepoState | null> {
  if (!top) return null;
  const raw = await sh("bash", ["-c", VCS_PROBE], top);
  const st: RepoState = {
    top,
    branch: "",
    base: "",
    dirty: new Set<string>(),
    untracked: new Set<string>(),
    off: new Set<string>(),
  };
  for (const line of raw.split("\n")) {
    const i = line.indexOf("\t");
    if (i < 0) continue;
    const tag = line.slice(0, i);
    const val = line.slice(i + 1);
    if (tag === "B") st.branch = val;
    else if (tag === "R") st.base = val;
    else if (tag === "D") st.dirty.add(val);
    else if (tag === "U") st.untracked.add(val);
    else if (tag === "X") st.off.add(val);
  }
  return st;
}

function covers(set: Set<string>, rel: string): boolean {
  if (set.has(rel)) return true;
  const prefix = `${rel}/`;
  for (const p of set) if (p.startsWith(prefix)) return true;
  return false;
}

function findRepoTops(dirs: string[]): Map<string, string> {
  const cache = new Map<string, string>();
  const out = new Map<string, string>();
  for (const original of dirs) {
    let current = safeReal(original);
    const visited: string[] = [];
    let top = "";
    while (true) {
      const cached = cache.get(current);
      if (cached !== undefined) { top = cached; break; }
      visited.push(current);
      if (statSafe(path.join(current, ".git"))) { top = current; break; }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    for (const dir of visited) cache.set(dir, top);
    out.set(original, top);
  }
  return out;
}

export async function annotateLibraryVcs(entries: LibraryEntry[]): Promise<LibraryEntry[]> {
  const homeOf = (e: LibraryEntry) => (e.doc ? path.dirname(e.file) : e.dir);
  const probeDirs = [...new Set(entries.map(homeOf))];
  const dirTop = findRepoTops(probeDirs);
  const uniqueTops = [...new Set([...dirTop.values()].filter(Boolean))];
  const states = new Map(await Promise.all(
    uniqueTops.map(async (t): Promise<[string, RepoState | null]> => [t, await repoState(t)])));

  for (const e of entries) {
    const dir = homeOf(e);
    const st = states.get(dirTop.get(dir) || "");
    if (!st) { e.vcs = { state: "none", branch: "", onMain: false }; continue; }
    const relFile = path.relative(st.top, safeReal(e.file));
    const relDir = e.doc ? relFile : path.relative(st.top, safeReal(e.dir));
    let state: LibraryVcsState;
    if (st.untracked.has(relFile)) state = "new";
    else if (covers(st.dirty, relDir) || covers(st.untracked, relDir)) state = "dirty";
    else if (!st.base) state = "nobase";
    else if (covers(st.off, relDir)) state = "branch";
    else state = "main";
    e.vcs = { state, branch: st.branch, base: st.base, onMain: state === "main", repo: path.basename(st.top) };
  }
  return entries;
}

export function scanLibrary(): LibraryEntry[] {
  const links = new Map<string, string[]>();
  for (const [root, tag] of LIB_LINK_ROOTS) {
    let names: string[] = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const n of names) {
      if (n.startsWith(".")) continue;
      const real = safeReal(path.join(root, n));
      const tags = links.get(real) || [];
      if (!links.has(real)) links.set(real, tags);
      if (!tags.includes(tag)) tags.push(tag);
    }
  }

  const out: LibraryEntry[] = [];
  const seen = new Set<string>();
  for (const [rootIdx, root] of LIB_ROOTS.entries()) {
    for (const hit of findSkillDirs(root)) {
      const st = statSafe(hit.file);
      if (!st) continue;
      const real = safeReal(hit.dir);
      if (seen.has(real)) continue;
      seen.add(real);
      const parent = path.dirname(real);
      const grouped = hit.rel.length > 1
        ? path.join(root, ...hit.rel.slice(0, -1))
        : parent !== safeReal(root) && parent !== root
          ? parent
          : root;
      out.push({
        rootIdx,
        name: hit.rel.at(-1)!,
        group: tilde(grouped),
        file: hit.file,
        dir: hit.dir,
        real,
        links: links.get(real) || [],
        aliases: [],
        mtime: st.mtimeMs,
        size: st.size,
        doc: false,
        vcs: null,
      });
    }
  }

  const docs = new Map<string, LibraryEntry>();
  for (const p of LIB_DOCS) {
    if (!statSafe(p)?.isFile()) continue;
    const real = safeReal(p);
    if (!docs.has(real)) {
      const st = statSafe(real);
      if (!st) continue;
      docs.set(real, {
        rootIdx: 90,
        name: tilde(real),
        group: "instructions",
        file: real,
        dir: path.dirname(real),
        real,
        links: [],
        aliases: [],
        mtime: st.mtimeMs,
        size: st.size,
        doc: true,
        vcs: null,
      });
    }
    if (real !== p) docs.get(real)?.aliases.push(tilde(p));
  }
  out.push(...docs.values());

  return out.sort((a, b) =>
    (a.rootIdx ?? 90) - (b.rootIdx ?? 90) ||
    a.group.localeCompare(b.group) ||
    b.mtime - a.mtime);
}

const DOC_DEPTH = envInt(process.env.HERD_LEAD_DOC_DEPTH, 1, 0);
const DOC_EXTS = new Set(split(process.env.HERD_LEAD_DOC_EXTS ||
  ".tldraw:.tldr:.excalidraw:.md:.markdown:.mmd:.mermaid:.pdf:.png:.jpg:.jpeg:.gif:.webp:.svg:.html:.csv:.txt"));

let docIssues: DocumentScanIssue[] = [];
export function docScanIssues(): DocumentScanIssue[] { return docIssues; }

export function scanDocs(): DocumentEntry[] {
  const out: DocumentEntry[] = [];
  docIssues = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) {
      if (depth === 0) docIssues.push({ dir: tilde(dir), code: e instanceof Error && "code" in e ? String(e.code) : "ERROR" });
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      const st = statSafe(p);
      if (!st) continue;
      if (st.isDirectory()) {
        if (depth < DOC_DEPTH && e.name !== "node_modules") walk(p, depth + 1);
        continue;
      }
      const ext = path.extname(e.name).toLowerCase();
      if (!DOC_EXTS.has(ext)) continue;
      out.push({
        name: e.name.slice(0, e.name.length - ext.length) || e.name,
        ext,
        group: tilde(dir),
        file: p,
        dir,
        mtime: st.mtimeMs,
        size: st.size,
      });
    }
  };
  for (const root of DOC_ROOTS) walk(root, 0);

  const newest = new Map<string, number>();
  for (const d of out) newest.set(d.group, Math.max(newest.get(d.group) || 0, d.mtime));
  return out.sort((a, b) =>
    (newest.get(b.group) || 0) - (newest.get(a.group) || 0) ||
    a.group.localeCompare(b.group) ||
    b.mtime - a.mtime);
}

export const DATADOG_CACHE = process.env.HERD_LEAD_DD_CACHE || path.join(STATE, "datadog.json");
export const LINEAR_CACHE = process.env.HERD_LEAD_LINEAR_CACHE || path.join(STATE, "linear.json");
export const SUMMARIES_CACHE = process.env.HERD_LEAD_SUMMARIES_CACHE || path.join(STATE, "summaries.json");

function readAgedCache<T extends { at: string }>(file: string): (T & { atMs: number | null }) | null {
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8")) as T;
    const at = Date.parse(d.at);
    return { ...d, atMs: Number.isFinite(at) ? at : null };
  } catch { return null; }
}

export function readDatadog(): DatadogCache | null { return readAgedCache<Omit<DatadogCache, "atMs">>(DATADOG_CACHE); }

export function readLinear(): LinearCache | null {
  const d = readAgedCache<Omit<LinearCache, "atMs">>(LINEAR_CACHE);
  return d ? { ...d, issues: Array.isArray(d.issues) ? d.issues : [] } : null;
}

export function readSummaries(): AgentSummariesCache | null {
  const d = readAgedCache<Omit<AgentSummariesCache, "atMs" | "agents"> & { agents?: unknown }>(SUMMARIES_CACHE);
  if (!d) return null;
  const agents: AgentSummariesCache["agents"] = {};
  if (d.agents && typeof d.agents === "object" && !Array.isArray(d.agents)) {
    for (const [pane, value] of Object.entries(d.agents as Record<string, unknown>)) {
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
  return { at: d.at, atMs: d.atMs, agents };
}

export function parseAgentRecap(screen: string): { recap: string | null; pending: string | null } {
  const lines = screen.split("\n");
  const recapAt = lines.map((line, index) => line.includes("※ recap:") ? index : -1).filter((index) => index >= 0).at(-1);
  let recap: string | null = null;
  if (recapAt !== undefined) {
    const parts = [lines[recapAt]!.split("※ recap:", 2)[1]!.trim()];
    for (const line of lines.slice(recapAt + 1)) {
      const value = line.trim();
      if (!value || value.startsWith("─") || value.startsWith("❯") || value.includes("new task?")) break;
      parts.push(value);
    }
    recap = parts.join(" ");
  }
  let pending: string | null = null;
  for (const line of lines.slice(-6).filter((value) => value.trim()).reverse()) {
    const match = line.match(/^\s*❯\s+(\S.*?)\s*$/);
    if (!match) continue;
    pending = match[1]!;
    break;
  }
  return { recap, pending };
}

const EDITOR_NAMES = new Set(["nvim", "vim"]);

interface ProcessInfoResult {
  process_info?: {
    foreground_processes?: Array<{ name: string; argv?: string[]; cwd?: string }>;
  };
}

export async function probeEditors(panes: Pane[]): Promise<Editor[]> {
  const rows = await pool(
    panes.filter((p) => !p.agent),
    SCAN_LIMIT,
    async (p) => {
      const r = await rpc<ProcessInfoResult>("pane.process_info", { pane_id: p.pane_id }).catch(() => null);
      const procs = r?.result?.process_info?.foreground_processes || [];
      const ed = procs.find((q) => EDITOR_NAMES.has(q.name));
      if (!ed) return null;
      const files = (ed.argv || []).slice(1).filter((a) => !a.startsWith("-"));
      return {
        pane_id: p.pane_id,
        name: ed.name,
        cwd: ed.cwd || p.foreground_cwd || p.cwd || "",
        file: files.join(" "),
        tab_id: p.tab_id,
        workspace_id: p.workspace_id,
        dir: "",
        wt: "",
      };
    },
  );
  return rows.filter((row): row is Editor => row !== null).sort((a, b) => a.pane_id.localeCompare(b.pane_id));
}

function worktreeResolver(worktrees: Worktree[]): (candidate: string | undefined) => Worktree | null {
  const dirs = worktrees
    .map((w) => ({ w, real: safeReal(w.dir) }))
    .sort((a, b) => b.real.length - a.real.length);
  const cache = new Map<string, Worktree | null>();
  return (p) => {
    if (!p) return null;
    const cached = cache.get(p);
    if (cached !== undefined) return cached;
    const real = safeReal(p);
    const match = dirs.find((d) => real === d.real || real.startsWith(d.real + path.sep))?.w || null;
    cache.set(p, match);
    return match;
  };
}

export function correlateEditors(editors: Editor[], worktrees: Worktree[]): EditorCorrelations {
  const find = worktreeResolver(worktrees);
  const byDir = new Map<string, string[]>();
  for (const e of editors) {
    const hit = find(e.cwd);
    e.dir = hit ? hit.dir : "";
    e.wt = hit ? hit.name : path.basename(e.cwd || "");
    if (!hit) continue;
    const panes = byDir.get(hit.dir) || [];
    if (!byDir.has(hit.dir)) byDir.set(hit.dir, panes);
    panes.push(e.pane_id);
  }
  return { byDir };
}

export async function openTab({ cwd, label, command, workspaceId }: {
  cwd: string;
  label: string;
  command?: string;
  workspaceId?: string;
}): Promise<string> {
  const r = await rpc<{ root_pane?: { pane_id?: string } }>("tab.create", {
    ...(workspaceId ? { workspace_id: workspaceId } : {}),
    cwd,
    label,
    focus: true,
  });
  if (r?.error) throw new Error(r.error.message || "tab.create failed");
  const pane = r?.result?.root_pane?.pane_id;
  if (!pane) throw new Error("no root pane");
  if (command) await rpc("pane.send_input", { pane_id: pane, text: command, keys: ["Enter"] });
  return pane;
}

export function correlate(agents: Pane[], worktrees: Worktree[], byTitle: SessionIndex): Correlations {
  const find = worktreeResolver(worktrees);
  const agentDirs = new Map<string, Array<{ name: string; dir: string; weight: number; live: boolean }>>();
  const dirAgents = new Map<string, string[]>();
  for (const a of agents) {
    const hits = new Map<string, { name: string; dir: string; weight: number; live: boolean }>();
    const add = (dir: string | undefined, weight: number, live: boolean) => {
      const w = find(dir);
      if (!w) return;
      const prev = hits.get(w.dir);
      hits.set(w.dir, {
        name: w.name,
        dir: w.dir,
        weight: (prev?.weight || 0) + weight,
        live: !!(prev?.live || live),
      });
    };
    add(a.foreground_cwd || a.cwd, 0, true);
    const s = byTitle[a.terminal_title_stripped || ""];
    if (s) for (const [cwd, n] of Object.entries(s.cwds)) add(cwd, n, false);
    const list = [...hits.values()].sort((x, y) => (Number(y.live) - Number(x.live)) || (y.weight - x.weight));
    if (!list.length) continue;
    agentDirs.set(a.pane_id, list);
    for (const h of list) {
      const panes = dirAgents.get(h.dir) || [];
      if (!dirAgents.has(h.dir)) dirAgents.set(h.dir, panes);
      panes.push(a.pane_id);
    }
  }
  return { agentDirs, dirAgents };
}

function safeReal(p: string): string {
  try { return fs.realpathSync(p); } catch { return p; }
}

export const SNAPSHOT = path.join(STATE, "snapshot.json");

const SCAN_CACHE = path.join(STATE, "scan.json");
export const SCAN_TTL = +(process.env.HERD_LEAD_CACHE_TTL_MS || 5 * 60 * 1000);

interface ScanCache {
  at: number;
  fresh: boolean;
  worktrees: Worktree[];
  library: LibraryEntry[];
  docs: DocumentEntry[];
}

export function readScanCache(): ScanCache | null {
  try {
    const raw = JSON.parse(fs.readFileSync(SCAN_CACHE, "utf8")) as Omit<ScanCache, "fresh">;
    if (!Array.isArray(raw?.worktrees)) return null;
    return { ...raw, fresh: Date.now() - (raw.at || 0) < SCAN_TTL };
  } catch { return null; }
}

export function writeScanCache({ worktrees, library, docs }: {
  worktrees: Worktree[];
  library: LibraryEntry[];
  docs: DocumentEntry[];
}): boolean {
  return writeJson(SCAN_CACHE, { at: Date.now(), worktrees, library, docs });
}

export function buildSnapshot({ agents, tabs, worktrees, editors, library, mrs, corr, edCorr, live }: {
  agents: Pane[];
  tabs: Tab[];
  worktrees: Worktree[];
  editors: Editor[];
  library: LibraryEntry[];
  mrs: MergeRequestCache;
  corr: Correlations;
  edCorr: EditorCorrelations;
  live: boolean;
}): BoardSnapshot {
  const tabLabel = new Map((tabs || []).map((t) => [t.tab_id, t.label || t.tab_id]));
  const edByPane = new Map(editors.map((e) => [e.pane_id, e]));

  const agentRows = agents.filter((a) => a.agent).map((a) => ({
    pane: a.pane_id,
    tab: a.tab_id,
    tabLabel: tabLabel.get(a.tab_id) || "",
    workspace: a.workspace_id,
    status: a.agent_status,
    title: a.terminal_title_stripped || "",
    label: a.label || "",
    worktrees: (corr.agentDirs.get(a.pane_id) || []).map((h) => h.name),
  }));

  const editorRows = editors.map((e) => ({
    pane: e.pane_id,
    tab: e.tab_id,
    editor: e.name,
    file: e.file,
    cwd: e.cwd,
    worktree: e.wt,
  }));

  const wtRows = worktrees.map((w) => {
    const mr = mrFor(w, mrs);
    return {
      name: w.name,
      dir: w.dir,
      branch: w.branch,
      linked: w.linked,
      ticket: ticketFor(w.branch),
      state: classify(w, mr),
      dirty: w.dirty,
      ahead: w.ahead,
      behind: w.behind,
      unique: w.unique,
      tracked: w.tracked,
      lastFetch: w.fetchEpoch ? new Date(w.fetchEpoch * 1000).toISOString() : null,
      lastCommit: w.commitEpoch ? new Date(w.commitEpoch * 1000).toISOString() : null,
      subject: w.subject,
      project: w.project,
      mr: mr ? { iid: mr.iid, state: mr.state, draft: mr.draft, title: mr.title, url: mr.url } : null,
      agents: corr.dirAgents.get(w.dir) || [],
      editors: (edCorr.byDir.get(w.dir) || []).map((p) => ({
        pane: p,
        file: edByPane.get(p)?.file || "",
      })),
    };
  });

  const libRows = library.map((e) => ({
    name: e.name,
    group: e.group,
    file: e.file,
    links: e.links,
    aliases: e.aliases,
    size: e.size,
    modified: new Date(e.mtime).toISOString(),
    vcs: e.vcs || null,
  }));

  const count = <T>(rows: T[], key: keyof T): Record<string, number> =>
    rows.reduce<Record<string, number>>((m, r) => {
      const value = String(r[key]);
      m[value] = (m[value] || 0) + 1;
      return m;
    }, {});

  return {
    at: new Date().toISOString(),
    live: !!live,
    root: ROOT,
    roots: ROOTS,
    totals: {
      agents: agentRows.length,
      agentsByStatus: count(agentRows, "status"),
      editors: editorRows.length,
      worktrees: wtRows.length,
      worktreesByState: count(wtRows, "state"),
      openMRs: wtRows.filter((w) => w.mr?.state === "opened").length,
      library: libRows.length,
    },
    agents: agentRows,
    editors: editorRows,
    worktrees: wtRows,
    library: libRows,
  };
}

export async function collectSnapshot(): Promise<BoardSnapshot> {
  const snap = (await rpc<{ snapshot?: HerdrSnapshot }>("session.snapshot", {}).catch(() => null))?.result?.snapshot
    || { panes: [], tabs: [], workspaces: [] };
  const panes = snap.panes || [];
  const worktrees = await scanWorktrees();
  const editors = await probeEditors(panes);
  const edCorr = correlateEditors(editors, worktrees);
  const corr = correlate(panes.filter((p) => p.agent), worktrees, sessionIndex());
  const mrs = await refreshMRs(worktrees, false);
  return buildSnapshot({
    agents: panes,
    tabs: snap.tabs || [],
    worktrees,
    editors,
    library: await annotateLibraryVcs(scanLibrary()).catch(() => scanLibrary()),
    mrs,
    corr,
    edCorr,
    live: false,
  });
}

export function saveSnapshot(snapshot: BoardSnapshot): boolean {
  return writeJson(SNAPSHOT, snapshot, 1);
}

export function readSnapshot(maxAgeMs = 0): BoardSnapshot | null {
  try {
    const raw = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8")) as BoardSnapshot;
    if (!maxAgeMs) return raw;
    return Date.now() - Date.parse(raw.at) <= maxAgeMs ? raw : null;
  } catch { return null; }
}
