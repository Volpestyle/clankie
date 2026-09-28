import { collectSnapshot, readSnapshot, tilde } from "./lib.ts";
import type { BoardSnapshot } from "./types.ts";

const args = process.argv.slice(2);
const has = (flag: string): boolean => args.includes(flag);
const MAX_AGE = 5 * 60_000;

const snap = has("--fresh") ? await collectSnapshot() : (readSnapshot(MAX_AGE) || await collectSnapshot());
const ageSec = Math.max(0, Math.round((Date.now() - Date.parse(snap.at)) / 1000));

if (has("--json")) {
  await new Promise((done) => process.stdout.write(JSON.stringify(snap, null, 1) + "\n", done));
  process.exit(0);
}

const out: string[] = [];
const t = snap.totals;
const byStatus = Object.entries(t.agentsByStatus).map(([k, v]) => `${v} ${k}`).join(", ") || "none";
const byState = Object.entries(t.worktreesByState).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join(", ");

out.push(`herd-lead state @ ${snap.at} (${ageSec}s ago, ${snap.live ? "from the live board" : "computed here"}) — rerun with --fresh to rescan`);
out.push(`roots ${(snap.roots || [snap.root]).map(tilde).join("  ")}`);
out.push("");
out.push(`AGENTS (${t.agents}) — ${byStatus}`);
for (const a of snap.agents) {
  const wt = a.worktrees.length ? `  → ${a.worktrees.join(", ")}` : "";
  out.push(`  ${a.pane}  [${a.status}] ${a.label ? `(${a.label}) ` : ""}${a.title}${wt}`);
}

out.push("");
out.push(`EDITORS (${t.editors})`);
for (const e of snap.editors) {
  out.push(`  ${e.pane}  ${e.editor} ${e.file || "(no file)"}  in ${e.worktree || tilde(e.cwd)}`);
}
if (!snap.editors.length) out.push("  none");

const active = (w: BoardSnapshot["worktrees"][number]): boolean => !!(w.dirty || w.ahead || w.behind || w.mr || w.agents.length || w.editors.length);
const shownWts = has("--all") ? snap.worktrees : snap.worktrees.filter(active);
const hiddenWts = snap.worktrees.length - shownWts.length;

out.push("");
out.push(`WORKTREES (${t.worktrees}) — ${byState}; ${t.openMRs} open MRs`);
for (const w of shownWts) {
  const bits: string[] = [];
  if (w.dirty) bits.push(`${w.dirty} dirty`);
  if (w.ahead) bits.push(`+${w.ahead}`);
  if (w.behind) bits.push(`-${w.behind}`);
  if (w.mr) bits.push(`!${w.mr.iid} ${w.mr.state}${w.mr.draft ? " draft" : ""}`);
  if (w.agents.length) bits.push(`agents ${w.agents.join(" ")}`);
  if (w.editors.length) bits.push(`nvim ${w.editors.map((e) => e.pane).join(" ")}`);
  out.push(`  ${w.name}  [${w.state}] ${w.branch}${bits.length ? `  · ${bits.join(" · ")}` : ""}`);
}
if (hiddenWts) out.push(`  … ${hiddenWts} clean/idle worktrees not listed — rerun with --all`);

out.push("");
out.push(`LIBRARY (${t.library})`);
let group: string | null = null;
for (const l of snap.library) {
  if (l.group !== group) {
    group = l.group;
    out.push(`  ${group}`);
  }
  const tags = l.links.length ? ` [${l.links.join("")}]` : l.aliases.length ? ` [←${l.aliases.length}]` : "";
  const v = l.vcs;
  const git =
    !v || v.state === "none" ? " (no repo)" :
    v.state === "main" ? "" :
    v.state === "new" ? " UNTRACKED" :
    ` OFF-MAIN ${v.state}@${v.branch}`;
  out.push(`    ${l.name}${tags}${git}  ${tilde(l.file)}`);
}

console.log(out.join("\n"));
