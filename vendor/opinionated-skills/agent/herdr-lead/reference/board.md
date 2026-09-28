# herdr-lead: the board

Six views on keys `1`–`6`: **overview** (agents grouped by tab, their open
`nvim` panes, and every worktree by repo with branch and state), **swarm**
(below), **worktrees**, **library** (every skill and agent-instruction file),
**docs** (`~/Documents` via `HERD_LEAD_DOC_ROOTS` — tldraw canvases, session
markdown, mermaid, images), **datadog** (below). Rows cross-link: `◆n` ties an
agent to the worktrees its session touched, `◈n` ties a worktree to editors open
in it.

### Swarm map

View `2` draws the swarm as a live pixel map right in the pane — half-block
pixels in the herdr theme. Worktrees are gravity wells with their agents
orbiting, solo agents sit apart, and the user is a node at the bottom — every
`blocked` agent points a red edge at them. Edges are mined from Claude session
transcripts (`herdr agent prompt/start/read/wait`, `pane run`, handoff-file
pointers) plus shared-checkout correlation; two agents live-working in one
checkout get a hot red tie. Recent dispatches carry a moving particle, working
agents orbit a satellite pixel, blocked ones blink. `j/k` or a click selects a
node, `↵` focuses that pane, `i` shows its status, task, lead summary, and
recent traffic,
`esc` clears. The board also serves the same map to the browser at
`http://127.0.0.1:7433` (`HERD_LEAD_MAP_PORT`; random port if taken) — `o`
opens it there for hover tooltips, zoom, and smooth animation.

Two caveats worth repeating to the user: outbound edges exist only for Claude
agents (codex/gemini transcripts are not mined, so their nodes show inbound
edges only), and edges older than 24h (`HERD_LEAD_MAP_EDGE_AGE_MIN`) are dropped
because pane ids get reused.

Enter on a doc opens a menu: markdown/mermaid gets `md-preview` in a new tab
(browser, mermaid pan/zoom), `.tldraw` opens in tldraw offline, anything else
goes to its default app, plus nvim / tode / Finder / copy-path. The docs view is empty
unless the terminal has macOS Documents-folder access.

It scans every repo under its configured roots, two levels deep by default (so
`<group>/<repo>`). Library roots default to `~/dev/skills:~/.agents/skills`
when unset — that is the source tree plus every skill any harness has linked.
`c` on the board opens settings — agent commands, scan roots and depth, linear
team keys and workspace url, library roots, instruction docs, docs-view roots,
datadog quick links. Rows edit in
place: `↵` on a row types into it, `↵` again saves, `esc` discards, empty
clears. Saves land in the plugin's `settings.json` and apply live, rescanning
when the value affects a scan.

Each value falls back to an env var (`HERD_LEAD_ROOT`, `HERD_LEAD_DEPTH`,
`HERD_LEAD_LINEAR_TEAMS`, `HERD_LEAD_LINEAR_URL`, `HERD_LEAD_LIB_ROOTS`,
`HERD_LEAD_LIB_DOCS`, `HERD_LEAD_DOC_ROOTS`, `HERD_LEAD_DD_DASHBOARDS`) when
unset; settings.json wins, so an env var you set is invisible the moment the
same key is saved in the UI. Editing `settings.json` by hand works but does not
invalidate the 5-minute scan cache the way saving in the UI does — delete
`scan.json` and `snapshot.json` in the state dir, or just use `c`.

Depth is measured from each root, so widening the root shortens the reach:
`~/dev` at depth 2 and `~` at depth 2 are not the same scan. A root set of a few
hundred repos costs ~12s a scan, so the board re-scans no more often than four
times its own measured scan time.

The board is the *user's* view, driven by keys and the mouse — `?` inside it
prints the full keymap and glyph legend, so you never need to recite either.
It creates tabs, opens URLs, can remove a worktree, can fetch/prune only the
selected repo's local remote-tracking refs from its worktree menu, and on `p` will
`fetch --all --prune` every repo then `merge --ff-only` each worktree that is
clean, tracking, and has no agent working in it — all behind a confirm that
defaults to cancel. `P` removes every prunable worktree (merged/closed MR,
clean, no working agent) in one pass, branches kept, behind the same
cancel-first confirm. It never merges, rebases, or resets, and it never prompts an
existing agent: dispatch stays yours, and still needs approval.

### Who refreshes what

Three tiers, split by what a refresh actually costs:

| | key | what it does |
|---|---|---|
| local scan | `r` | panes, worktrees, library, docs, plus a disk reread of `datadog.json` and `linear.json` — no network at all. Caches expire after 5 min (`HERD_LEAD_CACHE_TTL_MS`) |
| selected origin | worktree menu | `fetch origin --prune` for that repo, then reread local state and MRs — no merge or push |
| reach origin | `p` | `fetch --all --prune`, fast-forward what is safe, then reread MRs. Confirms first, defaults to cancel |
| agent-owned | `R` | `datadog.json`, `linear.json`, and `summaries.json` — reread from disk, or spawn an agent to refresh them |

A cold start reuses `scan.json` when it is under 5 minutes old and skips the
worktree scan entirely; otherwise it paints from cache instantly and rescans in
the background, with `cached Nm ago` in the header until real data lands.
