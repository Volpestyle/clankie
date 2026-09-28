#!/usr/bin/env -S node

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import os from "node:os";

interface RosterPane {
  pane_id: string;
  tab_id: string;
  agent?: string;
  agent_status?: string;
  foreground_cwd?: string;
  cwd?: string;
  terminal_title_stripped?: string;
}

interface RosterTab {
  tab_id: string;
  workspace_id: string;
  number?: number;
  label?: string;
  agent_status?: string;
}

interface RosterWorkspace {
  workspace_id: string;
  number?: number;
  label?: string;
  agent_status?: string;
  tab_count?: number;
  pane_count?: number;
  focused?: boolean;
}

interface RosterSnapshot {
  focused_pane_id?: string;
  panes?: RosterPane[];
  tabs?: RosterTab[];
  workspaces?: RosterWorkspace[];
}

interface RosterOptions {
  observedAt?: string;
  agentsOnly: boolean;
  recaps: boolean;
  statuses: Set<string>;
  me: string;
  enrich: (paneId: string) => { recap: string | null; pending: string | null };
  resolveWorktree: (cwd: string) => string;
}

const short = (value: string): string => value.startsWith(os.homedir())
  ? `~${value.slice(os.homedir().length)}`
  : value || "-";

const trunc = (value: string | undefined, width: number): string => {
  const text = (value || "").trim();
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
};

const statusArgs = (args: string[]): Set<string> => new Set(args.flatMap((arg, index) =>
  arg === "--status" && args[index + 1] ? [args[index + 1]!] : []));

function readAgent(paneId: string): { recap: string | null; pending: string | null } {
  const result = spawnSync("herdr", ["agent", "read", paneId, "--source", "recent-unwrapped", "--lines", "60"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.status !== 0) return { recap: null, pending: null };
  const lines = result.stdout.split("\n");
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

function createWorktreeResolver(): (cwd: string) => string {
  const cache = new Map<string, string>();
  return (cwd: string) => {
    if (!cwd) return "?";
    const cached = cache.get(cwd);
    if (cached) return cached;
    const result = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: 3_000,
    });
    const root = result.status === 0 && result.stdout.trim() ? result.stdout.trim() : cwd;
    cache.set(cwd, root);
    return root;
  };
}

export function renderRoster(snapshot: RosterSnapshot, options: RosterOptions): string {
  const panes = snapshot.panes || [];
  const tabs = snapshot.tabs || [];
  const focus = snapshot.focused_pane_id || "";
  const counts: Record<string, number> = {};
  const output: string[] = [`SNAPSHOT @ ${options.observedAt || "unknown"} — pane statuses, not delivery or ownership proof`, ""];

  for (const workspace of [...(snapshot.workspaces || [])].sort((a, b) => (a.number || 0) - (b.number || 0))) {
    const workspaceTabs = tabs.filter((tab) => tab.workspace_id === workspace.workspace_id);
    const body: string[] = [];
    for (const tab of workspaceTabs.sort((a, b) => (a.number || 0) - (b.number || 0))) {
      const rows: string[] = [];
      for (const pane of panes.filter((entry) => entry.tab_id === tab.tab_id)) {
        const status = pane.agent_status || "unknown";
        if (options.agentsOnly && !pane.agent) continue;
        if (options.statuses.size && !options.statuses.has(status)) continue;
        counts[status] = (counts[status] || 0) + 1;
        const mark = pane.pane_id === options.me ? "  <- YOU" : pane.pane_id === focus ? "  <- focus" : "";
        const cwd = short(pane.foreground_cwd || pane.cwd || "-");
        rows.push(`    ${pane.pane_id.padEnd(9)} ${(pane.agent || "shell").padEnd(7)} ${status.padEnd(8)} ${trunc(cwd, 26).padEnd(26)} ${trunc(pane.terminal_title_stripped, 52)}${mark}`);
        if (options.recaps && pane.agent && pane.pane_id !== options.me) {
          const { recap, pending } = options.enrich(pane.pane_id);
          if (pending) rows.push(`        !! UNSUBMITTED INPUT: "${trunc(pending, 80)}"`);
          if (recap) rows.push(`        recap: ${trunc(recap, 400)}`);
        }
      }
      if (!rows.length) continue;
      body.push(`  tab ${tab.tab_id} "${tab.label || "?"}" [${tab.agent_status || "?"}]`, ...rows);
    }
    if (!body.length) continue;
    output.push(
      `WORKSPACE ${workspace.workspace_id} ${workspace.label || "?"} [${workspace.agent_status || "?"}] ${workspace.tab_count ?? workspaceTabs.length} tabs, ${workspace.pane_count || 0} panes${workspace.focused ? "  *focused" : ""}`,
      ...body,
    );
  }

  output.push(Object.keys(counts).length ? "" : "(no panes matched)");
  const summary = Object.keys(counts).sort().map((key) => `${key}=${counts[key]}`).join("  ") || "none";
  output.push(`SUMMARY  ${summary}`);
  if (counts.done) output.push(`  ${counts.done} pane(s) DONE - inspect relevant output and delivery before calling the work complete.`);
  if (counts.blocked) output.push(`  ${counts.blocked} pane(s) BLOCKED - inspect the blocker; resolve what you own and keep independent work moving.`);
  if (counts.idle) output.push("  idle is not the same as free - run --recaps to see which are awaiting your decision.");

  const byWorktree = new Map<string, RosterPane[]>();
  for (const pane of panes.filter((entry) => entry.agent)) {
    const root = options.resolveWorktree(pane.foreground_cwd || pane.cwd || "");
    const group = byWorktree.get(root) || [];
    if (!byWorktree.has(root)) byWorktree.set(root, group);
    group.push(pane);
  }
  const risky = [...byWorktree.entries()].filter(([, group]) =>
    group.length > 1 && group.filter((pane) => pane.agent_status === "working").length > 1);
  if (risky.length) {
    output.push("", "SHARED WORKTREE (2+ agents working in one checkout - check before dispatching edits)");
    for (const [root, group] of risky) {
      output.push(`  ${short(root)}  ${group.map((pane) => `${pane.pane_id}[${pane.agent_status}]`).join(" ")}`);
    }
  }
  output.push("", `YOU=${options.me || "?"}  FOCUS=${focus || "?"}  (focus is the user cursor, not you)`);
  return output.join("\n");
}

export function main(args = process.argv.slice(2)): void {
  const result = spawnSync("herdr", ["api", "snapshot"], { encoding: "utf8" });
  if (result.status !== 0) {
    console.error("herdr api snapshot failed:");
    console.error((result.stderr || result.stdout).trim());
    process.exitCode = 1;
    return;
  }
  const observedAt = new Date().toISOString();
  if (args.includes("--json")) {
    process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
    return;
  }
  let snapshot: RosterSnapshot;
  try {
    snapshot = (JSON.parse(result.stdout) as { result: { snapshot: RosterSnapshot } }).result.snapshot;
  } catch (error) {
    console.error(`could not parse herdr snapshot: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }
  console.log(renderRoster(snapshot, {
    observedAt,
    agentsOnly: args.includes("--agents-only"),
    recaps: args.includes("--recaps"),
    statuses: statusArgs(args),
    me: process.env.HERDR_PANE_ID || "",
    enrich: readAgent,
    resolveWorktree: createWorktreeResolver(),
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
