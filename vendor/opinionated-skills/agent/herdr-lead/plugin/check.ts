import "./check-env.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { Terminal } from "@earendil-works/pi-tui";
import { renderRoster } from "./roster.ts";
import type { Editor, Pane, Worktree } from "./types.ts";

const lib = await import("./lib.ts");
const { classify, coalesceAsync, tilde, ticketFor, loadTheme, correlate, correlateEditors, mineCmds, refreshMRs, DATADOG_CACHE, SETTINGS } = lib;
const { buildSwarm } = await import("./swarm.ts");

process.env.HERD_LEAD_HEADLESS = "1";
const m = await import("./dash.ts");
const terminal: Terminal = {
  start() {},
  stop() {},
  async drainInput() {},
  write() {},
  columns: 200,
  rows: 60,
  kittyProtocolActive: false,
  moveBy() {},
  hideCursor() {},
  showCursor() {},
  clearLine() {},
  clearFromCursor() {},
  clearScreen() {},
  setTitle() {},
  setProgress() {},
};
m.board.tui.terminal = terminal;
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const makeWorktree = (branch = "feat", extra: Partial<Worktree> = {}): Worktree => ({
  name: `wt-${branch}`,
  dir: `/tmp/${branch}`,
  parent: "tmp",
  repoRoot: `/tmp/${branch}`,
  repo: `wt-${branch}`,
  branch,
  project: "proj",
  dirty: 0,
  ahead: 0,
  behind: 0,
  unique: 1,
  tracked: true,
  linked: true,
  fetchEpoch: 0,
  commitEpoch: 0,
  subject: "",
  ...extra,
});
const makePane = (pane_id: string, extra: Partial<Pane> = {}): Pane => ({
  pane_id,
  tab_id: "t1",
  workspace_id: "w1",
  ...extra,
});
const selectedId = (): string | undefined => {
  const row = m.board.selected();
  return row && "id" in row ? row.id : undefined;
};

const roster = renderRoster({
  focused_pane_id: "p2",
  workspaces: [{ workspace_id: "w1", label: "test", tab_count: 1, pane_count: 2 }],
  tabs: [{ tab_id: "t1", workspace_id: "w1", label: "tab" }],
  panes: [
    { pane_id: "p1", tab_id: "t1", agent: "codex", agent_status: "working", cwd: "/tmp/repo", terminal_title_stripped: "build" },
    { pane_id: "p2", tab_id: "t1", agent: "claude", agent_status: "working", cwd: "/tmp/repo", terminal_title_stripped: "review" },
  ],
}, {
  agentsOnly: true,
  recaps: false,
  statuses: new Set(),
  me: "p1",
  enrich: () => ({ recap: null, pending: null }),
  resolveWorktree: () => "/tmp/repo",
});
assert.match(roster, /working=2/);
assert.match(roster, /SHARED WORKTREE/);
assert.match(roster, /YOU=p1  FOCUS=p2/);
const settledRoster = renderRoster({
  workspaces: [{ workspace_id: "w1" }],
  tabs: [{ tab_id: "t1", workspace_id: "w1" }],
  panes: [
    { pane_id: "done", tab_id: "t1", agent: "codex", agent_status: "done" },
    { pane_id: "blocked", tab_id: "t1", agent: "claude", agent_status: "blocked" },
  ],
}, {
  observedAt: "2026-09-07T10:00:00.000Z", agentsOnly: true, recaps: false,
  statuses: new Set(), me: "", enrich: () => ({ recap: null, pending: null }),
  resolveWorktree: () => "?",
});
assert.match(settledRoster, /SNAPSHOT @ 2026-09-07T10:00:00.000Z/);
assert.match(settledRoster, /not delivery or ownership proof/);
assert.match(settledRoster, /inspect relevant output and delivery/);
assert.match(settledRoster, /keep independent work moving/);
assert.doesNotMatch(settledRoster, /nobody has read|Harvest these first|waiting on a human/);


const wt = { dirty: 0, branch: "feat", unique: 1, tracked: true, ahead: 0, behind: 0 };
assert.equal(classify({ ...wt, dirty: 3 }, null), "dirty");
assert.equal(classify(wt, { state: "merged" }), "prunable");
assert.equal(classify(wt, { state: "closed" }), "prunable");
assert.equal(classify({ ...wt, ahead: 2 }, { state: "opened" }), "ahead");
assert.equal(classify({ ...wt, unique: 0 }, null), "prunable");
assert.equal(classify({ ...wt, unique: 0, tracked: false }, null), "unpushed");
assert.equal(classify({ ...wt, branch: "main", behind: 4 }, null), "behind");
assert.equal(tilde(`${process.env.HOME}/x`), "~/x");
assert.equal(ticketFor("abc-1127-thing")?.id, "ABC-1127");
assert.equal(ticketFor("abc-1127-thing")?.url, "https://linear.app/test/issue/ABC-1127");
assert.equal(ticketFor("a+b-9")?.id, "A+B-9");
assert.equal(ticketFor("ab-9"), null);
assert.equal(ticketFor("no-ticket-here"), null);
assert.ok(lib.ROOTS.length >= 1 && lib.ROOTS.every((r) => path.isAbsolute(r)), "ROOTS must be absolute paths");

let activeTasks = 0;
let maxActiveTasks = 0;
let taskRuns = 0;
const coalesced = coalesceAsync(async () => {
  taskRuns++;
  activeTasks++;
  maxActiveTasks = Math.max(maxActiveTasks, activeTasks);
  await new Promise<void>((resolve) => setImmediate(resolve));
  activeTasks--;
});
await Promise.all([coalesced(), coalesced(), coalesced()]);
assert.equal(taskRuns, 2, "concurrent refresh requests must collapse into one rerun");
assert.equal(maxActiveTasks, 1, "coalesced refreshes must never overlap");

const fakeWts: Worktree[] = [
  makeWorktree("repo", { name: "repo", dir: "/tmp/hl-check/repo", repoRoot: "/tmp/hl-check/repo" }),
  makeWorktree("nested", { name: "nested", dir: "/tmp/hl-check/repo/nested", repoRoot: "/tmp/hl-check/repo/nested" }),
];
const deep = makePane("pX", { foreground_cwd: "/tmp/hl-check/repo/src/deep", terminal_title_stripped: "t" });
const c1 = correlate([deep], fakeWts, {});
assert.deepEqual(c1.agentDirs.get("pX")?.map((h) => h.name), ["repo"],
  "agent in a SUBDIRECTORY of a worktree must correlate (prefix match)");
assert.deepEqual(c1.dirAgents.get("/tmp/hl-check/repo"), ["pX"], "reverse worktree->agent link missing");

const inNested = makePane("pY", { cwd: "/tmp/hl-check/repo/nested/x", terminal_title_stripped: "t" });
assert.equal(correlate([inNested], fakeWts, {}).agentDirs.get("pY")?.[0]?.name, "nested",
  "longest-prefix must win so a nested worktree beats its parent");

const outside = makePane("pZ", { cwd: "/tmp/hl-check/elsewhere", terminal_title_stripped: "t" });
assert.equal(correlate([outside], fakeWts, {}).agentDirs.get("pZ"), undefined,
  "an agent outside every worktree must not correlate");

const sessionOnly = makePane("pS", { cwd: "/nowhere", terminal_title_stripped: "known" });
const c2 = correlate([sessionOnly], fakeWts, { known: { mtime: 1, title: "known", cwds: { "/tmp/hl-check/repo/src": 9 } } });
assert.equal(c2.agentDirs.get("pS")?.[0]?.name, "repo", "session-history cwds must still correlate");

const eds: Editor[] = [{
  pane_id: "e1",
  name: "nvim",
  cwd: "/tmp/hl-check/repo/nested/deep",
  file: "a.ts",
  tab_id: "t1",
  workspace_id: "w1",
  dir: "",
  wt: "",
}];
assert.deepEqual(correlateEditors(eds, fakeWts).byDir.get("/tmp/hl-check/repo/nested"), ["e1"],
  "editor prefix match regressed");
assert.equal(eds[0]!.wt, "nested");

const promptLine = '{"timestamp":"2026-08-08T12:00:00.000Z","message":{"content":[{"type":"tool_use","input":{"command":"herdr agent prompt w3:p2J \'do the thing\' --wait"}}]}}';
const mined = mineCmds(promptLine, 111);
assert.equal(mined.length, 1, "one prompt command must mine one edge");
assert.deepEqual(mined[0], { t: Date.parse("2026-08-08T12:00:00.000Z"), verb: "prompt", target: "w3:p2J", handoff: false });
assert.equal(mineCmds('{"x":"herdr agent read w3:p9X --source recent"}', 5)[0]?.verb, "read");
assert.equal(mineCmds('{"x":"herdr agent prompt <pane> \'placeholder from a doc\'"}', 5).length, 0,
  "placeholder pane ids must not become edges");
assert.equal(mineCmds('{"x":"herdr pane run w3:p4A \'Read ~/.herdr-handoffs/x.md in full\'"}', 5)[0]?.handoff, true,
  "a handoff pointer must be tagged");
assert.equal(mineCmds('{"x":"no herdr commands here"}', 5).length, 0);
assert.equal(mineCmds('{"x":"herdr agent wait w1:pB --timeout 3000"}', 5)[0]?.t, 5, "missing timestamp must fall back");

const swarmDir = "/tmp/hl-check/repo";
const swarm = buildSwarm({
  agents: [
    makePane("w1:pL", { agent: "claude", agent_status: "working", terminal_title_stripped: "lead" }),
    makePane("w1:pW", { agent: "claude", agent_status: "blocked", terminal_title_stripped: "worker" }),
    makePane("w1:pX", { agent: "codex", agent_status: "working", terminal_title_stripped: "helper" }),
    makePane("w1:pSh", {}),
  ],
  tabs: [{ tab_id: "t1", label: "tab one" }],
  worktrees: fakeWts,
  corr: {
    agentDirs: new Map([
      ["w1:pL", [{ name: "repo", dir: swarmDir, weight: 3, live: true }]],
      ["w1:pX", [{ name: "repo", dir: swarmDir, weight: 1, live: true }]],
    ]),
    dirAgents: new Map([[swarmDir, ["w1:pL", "w1:pX"]]]),
  },
  sessions: {
    lead: { mtime: 1, title: "lead", cwds: {}, cmds: [
      { t: Date.now() - 60_000, verb: "prompt", target: "w1:pW", handoff: false },
      { t: Date.now() - 30_000, verb: "prompt", target: "w1:pW", handoff: false },
      { t: Date.now() - 999, verb: "read", target: "w1:pGONE", handoff: false },
      { t: Date.now() - 999, verb: "prompt", target: "w1:pL", handoff: false },
    ] },
  },
  me: "w1:pL",
});
const ids = new Set(swarm.nodes.map((n) => n.id));
assert.ok(ids.has("you") && ids.has(swarmDir), "swarm must include the you node and the shared-checkout hub");
assert.ok(!ids.has("w1:pSh"), "plain shells must stay off the map");
const dispatch = swarm.links.find((l) => l.kind === "dispatch");
assert.deepEqual([dispatch?.s, dispatch?.t, dispatch?.n], ["w1:pL", "w1:pW", 2], "repeat prompts must merge into one counted edge");
assert.ok(!swarm.links.some((l) => l.t === "w1:pGONE" || (l.s === "w1:pL" && l.t === "w1:pL")),
  "edges to dead panes and self-edges must be dropped");
assert.ok(swarm.links.some((l) => l.kind === "ask" && l.s === "w1:pW" && l.t === "you"), "blocked agents must point at you");
const couple = swarm.links.find((l) => l.kind === "couple");
assert.ok(couple && couple.hot, "two live working agents in one checkout must be a hot couple edge");
assert.equal(swarm.nodes.find((n) => n.id === "w1:pL")?.tab, "tab one");

const { renderSwarmFrame } = await import("./swarm-tui.ts");
const frame = renderSwarmFrame({ data: swarm, width: 120, rows: 36, now: 1e12, sel: null, me: "w1:pL" });
assert.equal(frame.lines.length, 36, "map frame must fill exactly the body rows");
const flat = frame.lines.map(strip).join("\n");
assert.ok(flat.includes("w1:pW") && flat.includes("you"), "map must label agent and you nodes");
assert.deepEqual([...frame.order].sort(), ["w1:pL", "w1:pW", "w1:pX"], "jk order must cover every agent");
const pos = frame.posOf("w1:pX");
assert.ok(pos && frame.hitAt(pos.col, pos.row) === "w1:pX", "clicking a node's cell must hit it");
assert.equal(frame.hitAt(0, 0), null, "empty corner must not hit a node");
const empty = renderSwarmFrame({
  data: { ...swarm, nodes: swarm.nodes.filter((n) => n.kind === "you"), links: [] },
  width: 80, rows: 20, now: 1e12, sel: null, me: "",
});
assert.ok(empty.lines.map(strip).join("").includes("no agents"), "empty swarm must say so");

for (let f = 0; f < m.FILTERS.length; f++) {
  m.state.filter = f;
  m.state.cursor = 0;
  m.board.move(1);
  const out = m.board.render(200);
  assert.ok(out.length && out.every((l) => typeof l === "string"), `filter ${f} render broken`);
}

m.state.filter = 0;
m.state.cursor = 0;
m.board.move(1);
m.state.help = true;
assert.ok(strip(m.board.render(200).join("\n")).includes("toggle this help"), "help overlay missing");
m.state.help = false;

if (m.state.worktrees.length && m.state.agents.some((a) => a.agent)) {
  const w = m.state.worktrees[0]!;
  const agent = m.state.agents.find((a) => a.agent);
  assert.ok(agent);
  m.state.corr = {
    agentDirs: new Map([[agent.pane_id, [{ name: w.name, dir: w.dir, weight: 1, live: true }]]]),
    dirAgents: new Map([[w.dir, [agent.pane_id]]]),
  };
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tealOpen = loadTheme().teal("").split("\x1b[39m")[0]!;
  const teal = new RegExp(esc(tealOpen) + esc(w.name));
  m.state.inspect = false;
  const rowLine = (id: string): string | null => {
    const lines = m.board.render(200);
    const i = m.board.hit.findIndex((h) => h?.row && h.row.id === id);
    return i < 0 ? null : lines[i] || null;
  };
  m.state.filter = 0;
  m.state.cursor = 0;
  m.board.move(1);
  let guard = 0;
  while (selectedId() !== agent.pane_id && guard++ < 500) m.board.move(1);
  assert.equal(selectedId(), agent.pane_id, "could not select the correlated agent");
  const on = rowLine(w.dir);
  assert.ok(on && teal.test(on), `cross-link highlight missing on ${w.name}`);

  m.state.cursor = 0;
  m.board.move(1);
  guard = 0;
  while (selectedId() === agent.pane_id && guard++ < 5) m.board.move(1);
  const off = rowLine(w.dir);
  assert.ok(off && !teal.test(off), `cross-link highlight stuck on ${w.name}`);
}

let sawMouse = false;
const realMouse = m.board.handleMouse.bind(m.board);
m.board.handleMouse = (d) => { sawMouse = true; return realMouse(d); };
const liveInput = m.tui as unknown as { handleTerminalInput(data: string): void };
liveInput.handleTerminalInput("\x1b[<0;10;5M");
assert.ok(sawMouse, "mouse sequence not routed");
sawMouse = false;
liveInput.handleTerminalInput("j");
assert.equal(sawMouse, false, "plain key treated as mouse");
sawMouse = false;
liveInput.handleTerminalInput("\x1b[<0;10;5Mj");
assert.ok(sawMouse, "mixed mouse+key not routed");
m.state.worktrees = Array.from({ length: 5 }, (_, i) => makeWorktree(`wheel-${i}`));
m.state.filter = m.FILTERS.indexOf("worktrees");
m.state.cursor = 0;
m.board.move(1);
const beforeWheel = m.state.cursor;
liveInput.handleTerminalInput("\x1b[<65;10;5M");
assert.ok(m.state.cursor > beforeWheel, "mouse wheel did not move the selection");

m.state.worktrees = [makeWorktree("feat-1", { name: "wt-mr", dir: "/tmp/wt-mr", repoRoot: "/tmp/wt-mr" })];
m.state.mrs = { at: Date.now(), byBranch: { "proj#feat-1": { iid: 42, state: "opened", draft: false, title: "Fix the thing", url: "https://example.invalid/42" } } };
m.state.filter = 0;
const statusLine = strip(m.board.render(200)[3]!);
const mrCol = statusLine.indexOf("open MRs") + 1;
assert.ok(mrCol > 1, "open MRs segment missing from status bar");
assert.equal(m.board.refAt(4, mrCol)?.row.kind, "mrs", "open MRs segment not clickable");
assert.equal(m.board.refAt(4, 2), null, "hit box leaks past the open MRs segment");
const clickAt = (col: number, row = 4): void => m.dispatchInput(`\x1b[<0;${col};${row}M`);
clickAt(mrCol);
assert.equal(m.state.headSel, "@openmrs", "first click on the header count should select it, not act");
assert.ok(strip(m.board.render(200).join("\n")).includes("Fix the thing"), "open MRs panel missing on selection");
clickAt(2);
assert.equal(m.state.headSel, null, "clicking off the segment should clear it");

const tabBar = strip(m.board.render(200)[1]!);
assert.match(tabBar, /1 overview .* 6 datadog/, `tab bar missing: ${tabBar}`);
const wasFilter = m.state.filter;
clickAt(tabBar.indexOf("library") + 1, 2);
assert.equal(m.state.filter, m.FILTERS.indexOf("library"), "clicking the library tab did not switch views");
clickAt(tabBar.indexOf("docs") + 1, 2);
assert.equal(m.state.filter, m.FILTERS.indexOf("docs"), "clicking the docs tab did not switch views");
assert.equal(m.board.refAt(2, mrCol)?.row.kind, "tab", "the counts row leaked its hit boxes onto the tab bar");
m.board.setFilter(wasFilter);

const wtFor = (branch: string, extra: Partial<Worktree> = {}): Worktree => makeWorktree(branch, extra);
m.state.worktrees = [
  wtFor("abc-1-review"),
  wtFor("abc-2-shipped"),
  wtFor("abc-3-local", { tracked: false }),
  wtFor("no-ticket-branch"),
];
m.state.mrs = { at: Date.now(), byBranch: {
  "proj#abc-1-review": { iid: 1, state: "opened", draft: false, title: "in review", url: "https://example.invalid/1" },
  "proj#abc-2-shipped": { iid: 2, state: "merged", draft: false, title: "shipped", url: "https://example.invalid/2" },
} };
m.state.linear = { at: new Date().toISOString(), atMs: Date.now(), issues: [
  { id: "ABC-1", title: "already branched", state: "In Progress", url: "https://example.invalid/i1" },
  { id: "ABC-9", title: "not started yet", state: "Todo", url: "https://example.invalid/i9" },
] };
const tixLine = strip(m.board.render(200)[3]!);
assert.match(tixLine, /2 active tickets/, `merged ticket or non-ticket branch leaked into the count: ${tixLine}`);
assert.match(tixLine, /\+1 no branch/, `linear issue with no worktree not flagged: ${tixLine}`);
const tixCol = tixLine.indexOf("active tickets") + 1;
assert.equal(m.board.refAt(4, tixCol)?.row.kind, "tickets", "active tickets segment not clickable");
assert.equal(m.board.refAt(4, tixLine.indexOf("open MRs") + 1)?.row.kind, "mrs", "MR segment lost its hit box");
m.state.headSel = "@tickets";
const tip = strip(m.board.render(200).join("\n"));
m.dispatchInput("j");
assert.equal(m.state.headSel, null, "any key should drop the header panel");
for (const want of ["ABC-1", "in review", "ABC-3", "local only", "ABC-9", "no branch"]) {
  assert.ok(tip.includes(want), `active tickets tooltip missing ${want}`);
}
assert.ok(!tip.includes("ABC-2"), "shipped ticket should collapse into the summary row, not be listed");
assert.match(tip, /1 more with a merged/, "shipped roll-up row missing");
assert.ok(!tip.includes("no cache yet"), "linear cache age line wrong when the cache is present");
m.state.linear = null;
m.state.headSel = "@tickets";
assert.ok(strip(m.board.render(200).join("\n")).includes("no cache yet"), "missing linear cache not surfaced");
m.state.headSel = null;

m.state.agents = [makePane("p-sum", { agent: "grok", agent_status: "working", terminal_title_stripped: "inspect json" })];
m.state.tabs = [{ tab_id: "t1", workspace_id: "w1", label: "tab", number: 1 }];
m.state.workspaces = [{ workspace_id: "w1", label: "test" }];
m.state.summaries = {
  at: new Date().toISOString(),
  atMs: Date.now(),
  agents: { "p-sum": { summary: "Wiring i to Clankie summaries.", next: "Show recap as fallback." } },
};
m.state.inspect = true;
m.state.filter = 0;
m.board.render(200);
const agentHit = m.board.hit.find((h) => h?.row?.kind === "agent");
assert.ok(agentHit, "need an agent row to check the i panel");
m.state.cursor = agentHit.i;
const agentTip = strip(m.board.render(200).join("\n"));
assert.ok(agentTip.includes("Wiring i to Clankie summaries."), "agent i panel missing Clankie summary");
assert.ok(agentTip.includes("Show recap as fallback."), "agent i panel missing next step");
m.state.summaries = { at: new Date().toISOString(), atMs: Date.now(), agents: {} };
assert.ok(strip(m.board.render(200).join("\n")).includes("no summary yet"), "missing lead summary not surfaced");
m.state.inspect = false;

m.state.inspect = false;
const lines = m.board.render(200);
const anchor = m.board.hit.findIndex((h) => h?.row?.kind === "wt");
assert.ok(anchor > 0, "need a worktree row to check tip anchoring");
assert.equal(m.state.tipGeom, null, "i off must draw no panel");
m.state.inspect = true;
const anchorHit = m.board.hit[anchor];
assert.ok(anchorHit && anchorHit.row);
m.state.cursor = anchorHit.i;
m.board.render(200);
const g = m.state.tipGeom as { top: number; height: number } | null;
assert.ok(g);
assert.equal(g.top, anchor + 1, "tip no longer anchored directly under the selected row");
assert.ok(g.top + g.height <= lines.length - 2, "tip covers the footer");
m.dispatchInput("i");
m.board.render(200);
assert.equal(m.state.tipGeom, null, "i did not turn the panel off");
m.dispatchInput("i");
const detailLines = m.board.render(200);
assert.ok(m.state.tipGeom, "i did not turn the panel back on");
const detail = strip(detailLines.join("\n"));
assert.ok(detail.includes("cached ref"), "worktree detail must identify upstream data as cached");
const ticketDetail = detailLines.find((line) => strip(line).includes("ABC-1"));
assert.ok(ticketDetail, "worktree detail missing its branch ticket");
assert.ok(strip(ticketDetail).includes("branch ticket"), "branch ticket label was truncated");
assert.doesNotMatch(ticketDetail, /\x1b\[0m/, "truncated detail label reset the panel background");
m.board.activate();
assert.ok(m.state.menu?.items.some((x) => x.label === "refresh this repo from origin"),
  "worktree menu missing its fetch-only repo refresh");
m.state.menu = null;

const wasAgents = m.agentCmds();
const typeInto = (s: string): void => { for (const chr of s) m.dispatchInput(chr); };
// state.menu is assigned null above, so TS narrows it away — read it back through a cast
type OpenMenu = { items: Array<{ label: string; hint: string }>; cursor: number; edit: { value: string } | null };
const menu = (): OpenMenu | null => m.state.menu as OpenMenu | null;
const clearEdit = (): void => { while (menu()?.edit?.value) m.dispatchInput("\x7f"); };
const settingsRow = (needle: string): number => {
  const items = menu()?.items || [];
  const i = items.findIndex((it) => it.label.includes(needle));
  assert.ok(i >= 0, `settings menu missing the ${needle} row`);
  return i;
};
/** open settings, put the named row into edit mode, and hand back its index */
const editRow = (needle: string): number => {
  if (!m.state.menu) m.dispatchInput("c");
  const i = settingsRow(needle);
  m.dispatchInput(String(i + 1));
  assert.ok(menu(), `settings closed when opening the ${needle} row — keepOpen not honoured`);
  assert.ok(menu()?.edit, `${needle} row did not start editing in place`);
  return i;
};

m.dispatchInput("c");
assert.ok(menu(), "c did not open the settings modal");
assert.equal(m.state.mode, "normal", "settings must edit inside the modal, not the footer prompt");
const agentsIdx = editRow("agent commands");
assert.equal(menu()?.edit?.value, wasAgents.join(","), "edit not prefilled with the current commands");
assert.match(strip(m.board.render(200).join("\n")), /↵ save · esc discard/, "editing footer not shown in the modal");
clearEdit();
typeInto("clowd, codex");
m.dispatchInput("\r");
assert.ok(menu(), "saving must leave the settings modal open");
assert.equal(menu()?.edit, null, "edit did not close on enter");
assert.deepEqual(m.agentCmds(), ["clowd", "codex"], "agent commands not applied");
assert.deepEqual(JSON.parse(fs.readFileSync(SETTINGS, "utf8")).agents, ["clowd", "codex"], "agent commands not persisted");
assert.equal(menu()?.cursor, agentsIdx, "cursor did not stay on the saved row");
assert.match(menu()?.items[agentsIdx]?.hint || "", /clowd/, "row hint did not pick up the saved value");

editRow("agent commands");
clearEdit();
m.dispatchInput("\r");
assert.deepEqual(m.agentCmds(), ["clowd", "codex"], "an empty edit must keep the previous commands");

editRow("agent commands");
clearEdit();
typeInto(wasAgents.join(","));
m.dispatchInput("\x1b");
assert.ok(menu(), "esc on an edit must close the edit, not the modal");
assert.deepEqual(m.agentCmds(), ["clowd", "codex"], "esc must discard the edit");
editRow("agent commands");
clearEdit();
typeInto(wasAgents.join(","));
m.dispatchInput("\r");
assert.deepEqual(m.agentCmds(), wasAgents, "could not restore the original agent commands");

// q and j are ordinary characters while a row is being typed into
editRow("agent commands");
clearEdit();
typeInto("q");
assert.ok(menu(), "q closed the modal mid-edit");
assert.equal(menu()?.edit?.value, "q", "q was swallowed as a key instead of typed");
m.dispatchInput("\x1b");

editRow("scan roots");
assert.equal(menu()?.edit?.value, process.env.HERD_LEAD_ROOT, "roots edit not prefilled from the env fallback");
clearEdit();
typeInto("/tmp/hl-check-roots");
m.dispatchInput("\r");
assert.deepEqual(lib.ROOTS, ["/tmp/hl-check-roots"], "saved roots did not apply live");
assert.equal(JSON.parse(fs.readFileSync(SETTINGS, "utf8")).roots, "/tmp/hl-check-roots", "roots not persisted to settings.json");
editRow("scan roots");
clearEdit();
m.dispatchInput("\r");
assert.deepEqual(lib.ROOTS, [process.env.HERD_LEAD_ROOT], "clearing roots must fall back to the env var");
assert.equal(JSON.parse(fs.readFileSync(SETTINGS, "utf8")).roots, undefined, "cleared roots must leave settings.json");

editRow("scan depth");
clearEdit();
typeInto("3");
m.dispatchInput("\r");
assert.equal(lib.DEPTH, 3, "saved scan depth did not apply live");
editRow("scan depth");
clearEdit();
m.dispatchInput("\r");
assert.equal(lib.DEPTH, 2, "clearing scan depth must fall back to the default");
m.dispatchInput("\x1b");
assert.equal(m.state.menu, null, "esc did not close the settings modal");

m.state.worktrees = [wtFor("abc-2-shipped"), wtFor("keep-me")];
m.state.mrs = { at: Date.now(), byBranch: { "proj#abc-2-shipped": { iid: 2, state: "merged", draft: false, title: "shipped", url: "" } } };
m.state.corr = { agentDirs: new Map(), dirAgents: new Map() };
m.dispatchInput("P");
const pruneMenu = m.state.menu as { title: string } | null;
assert.ok(pruneMenu, "P did not open the prune-all confirm");
assert.match(pruneMenu.title, /remove 1 prunable worktree\?/, `wrong prune-all count: ${pruneMenu.title}`);
m.dispatchInput("\x1b");
assert.equal(m.state.menu, null, "esc did not close the prune-all confirm");
m.state.mrs = { at: Date.now(), byBranch: {} };
m.dispatchInput("P");
assert.equal(m.state.menu, null, "P with nothing prunable must not open a menu");
assert.match(m.state.note, /nothing to prune/, "missing note when nothing prunable");

const doomed = wtFor("abc-2-shipped");
m.state.worktrees = [doomed, wtFor("keep-me")];
const pruning = m.doPrune(doomed);
assert.ok(!m.state.worktrees.some((w) => w.dir === doomed.dir),
  "the row must leave the list before git worktree remove returns");
await pruning;
assert.ok(m.state.worktrees.some((w) => w.dir === doomed.dir), "a failed remove must put the row back");
assert.match(m.state.note, /kept wt-abc-2-shipped/, `failed remove did not explain itself: ${m.state.note}`);

m.state.worktrees = [wtFor("a-very-long-branch-name-that-will-definitely-get-truncated-at-narrow-widths-for-sure")];
m.state.mrs = { at: Date.now(), byBranch: {} };
m.state.filter = 0;
m.state.cursor = 0;
m.board.move(1);
let selGuard = 0;
while (m.board.selected()?.kind !== "wt" && selGuard++ < 50) m.board.move(1);
const wtIdx = m.board.hit.findIndex((h) => h?.row?.kind === "wt");
const selLine = m.board.render(120)[wtIdx];
assert.ok(selLine, "selected worktree row was not rendered");
assert.ok(selLine.includes("\x1b[0m"), "expected the truncated branch to carry a full reset");
const surfaceOpen = loadTheme().on.surface("").split("\x1b[49m")[0]!;
for (let at = selLine.indexOf("\x1b[0m"); at >= 0; at = selLine.indexOf("\x1b[0m", at + 1)) {
  assert.ok(selLine.startsWith(surfaceOpen, at + 4),
    "selection highlight must re-open its background after a full reset (truncated content)");
}

const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
assert.ok(stateDir);
const bin = path.join(stateDir, "bin");
const calls = path.join(stateDir, "glab-calls");
const mergeRequests = path.join(stateDir, "glab-merge-requests.ndjson");
fs.mkdirSync(bin, { recursive: true });
const gitLabMr = (iid: number, source_branch: string) => ({
  iid,
  state: "opened",
  title: source_branch,
  web_url: `https://example.invalid/${iid}`,
  source_branch,
});
fs.writeFileSync(mergeRequests, [
  ...Array.from({ length: 100 }, (_, index) => gitLabMr(index + 1, `old-${index}`)),
  gitLabMr(101, "feat"),
].map((mergeRequest) => JSON.stringify(mergeRequest)).join("\n"));
fs.writeFileSync(path.join(bin, "glab"), `#!/bin/sh
printf '%s\n' "$*" >> ${JSON.stringify(calls)}
cat ${JSON.stringify(mergeRequests)}
`);
fs.chmodSync(path.join(bin, "glab"), 0o755);
const oldPath = process.env.PATH;
process.env.PATH = `${bin}:${oldPath}`;
const refreshed = await refreshMRs([
  makeWorktree("feat", { project: "active/project" }),
  makeWorktree("main", { project: "inactive/project" }),
], true);
process.env.PATH = oldPath;
const glabCalls = fs.readFileSync(calls, "utf8");
assert.match(glabCalls, /api projects\/active%2Fproject\/merge_requests/);
assert.match(glabCalls, /source_branch=feat/, "MR refresh did not use the indexed source branch filter");
assert.match(glabCalls, /--paginate/, "MR refresh did not request every page");
assert.match(glabCalls, /--output ndjson/, "MR refresh did not request stream-safe output");
assert.equal(refreshed.byBranch["active/project#feat"]?.iid, 101, "MR from the second page was not cached");
assert.deepEqual(Object.keys(refreshed.byBranch), ["active/project#feat"], "unrelated MR branches polluted the cache");
assert.doesNotMatch(glabCalls, /inactive(?:\/|%2F)project/,
  "MR refresh queried a project with no active worktree branch");

m.state.datadog = {
  at: new Date().toISOString(),
  atMs: Date.now() - 45 * 60_000,
  env: "prod",
  series: [{ label: "lambda errors", window: "4h/10m", bad: true, points: [0, 0, 3], query: "q", url: "https://example.invalid/s" }],
  monitors: [
    { id: 1, name: "api error rate", status: "Alert", scope: "service:api", url: "https://example.invalid/m1" },
    { id: 2, name: "retry webhook p95", status: "No Data", note: "only fires when the main webhook fails" },
    { id: 3, name: "queue depth", status: "OK" },
  ],
  incidents: [{ id: "i1", title: "elevated 5xx", severity: "SEV-2", since: new Date().toISOString(), url: "https://example.invalid/i" }],
};
m.state.inspect = false;
m.board.setFilter(m.FILTERS.indexOf("datadog"));
const dd = strip(m.board.render(200).join("\n"));
for (const want of ["DATADOG — prod", "needs a look", "1 alert", "1 incidents", "45m old",
  "lambda errors", "api error rate", "elevated 5xx", "NO DATA", "retry webhook p95"]) {
  assert.ok(dd.includes(want), `datadog view missing: ${want}`);
}
assert.ok(!dd.includes("queue depth"), "OK monitors must not be listed");

m.state.datadog = null;
m.state.worktrees = [];
fs.writeFileSync(DATADOG_CACHE, JSON.stringify({ at: new Date().toISOString(), monitors: [] }));
await m.refreshMRsNow(false);
assert.ok(m.state.datadog, "the scheduled-scan path must pick up a freshly written datadog.json");

const { BOARD_LABEL, boardPane } = await import("./runtime.ts");
const boardPanes = [makePane("p1"), makePane("p2", { label: BOARD_LABEL }), makePane("p3", { label: BOARD_LABEL })];
assert.equal(boardPane(boardPanes), "p2", "an open board must be found by label");
assert.equal(boardPane(boardPanes, "p2"), "p3", "excluding one board must still find another");
assert.equal(boardPane([makePane("p1")]), "", "no board means no pane id");
assert.equal(boardPane([makePane("p1", { label: BOARD_LABEL })], "p1"), "",
  "a stale label on your own pane must not block a restart in place");

console.log("herd-lead checks passed");
process.exit(0);
