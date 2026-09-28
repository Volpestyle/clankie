import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { envInt, paletteHex, rpc } from "./runtime.ts";
import type {
  AgentStatus, Correlations, Pane, SessionIndex, SwarmData, SwarmLink, SwarmNode, Tab, Worktree,
} from "./types.ts";

const EDGE_AGE_MS = envInt(process.env.HERD_LEAD_MAP_EDGE_AGE_MIN, 24 * 60) * 60_000;
const MAP_PORT = envInt(process.env.HERD_LEAD_MAP_PORT, 7433);

export interface SwarmInput {
  agents: Pane[];
  tabs: Tab[];
  worktrees: Worktree[];
  corr: Correlations;
  sessions: SessionIndex;
  me: string;
}

export function buildSwarm(input: SwarmInput): SwarmData {
  const agents = input.agents.filter((a) => a.agent);
  const paneIds = new Set(agents.map((a) => a.pane_id));
  const tabs = new Map(input.tabs.map((t) => [t.tab_id, t.label || t.tab_id]));
  const wtByDir = new Map(input.worktrees.map((w) => [w.dir, w]));
  const now = Date.now();

  const nodes: SwarmNode[] = [];
  const links: SwarmLink[] = [];

  for (const a of agents) {
    const hits = input.corr.agentDirs.get(a.pane_id) || [];
    nodes.push({
      id: a.pane_id,
      kind: "agent",
      label: a.pane_id,
      cluster: hits[0]?.dir || "",
      title: a.terminal_title_stripped || "",
      status: a.agent_status || "unknown",
      tab: tabs.get(a.tab_id) || a.tab_id,
    });
  }

  const hubDirs = new Set<string>();
  for (const [dir, panes] of input.corr.dirAgents) {
    if (panes.some((p) => paneIds.has(p))) hubDirs.add(dir);
  }
  for (const dir of hubDirs) {
    const w = wtByDir.get(dir);
    nodes.push({
      id: dir,
      kind: "hub",
      label: w?.name || path.basename(dir),
      cluster: dir,
      branch: w?.branch || "",
    });
  }

  nodes.push({ id: "you", kind: "you", label: "you", cluster: "" });

  for (const a of agents) {
    const hits = input.corr.agentDirs.get(a.pane_id) || [];
    for (const h of hits) {
      if (!hubDirs.has(h.dir)) continue;
      links.push({ s: a.pane_id, t: h.dir, kind: "on", at: 0, n: h.weight, live: h.live });
    }
    if ((a.agent_status || "") === "blocked") {
      links.push({ s: a.pane_id, t: "you", kind: "ask", at: now, n: 1 });
    }
  }

  const talk = new Map<string, SwarmLink>();
  for (const a of agents) {
    const s = input.sessions[a.terminal_title_stripped || ""];
    for (const cmd of s?.cmds || []) {
      if (cmd.target === a.pane_id || !paneIds.has(cmd.target)) continue;
      if (now - cmd.t > EDGE_AGE_MS) continue;
      const kind = cmd.verb === "read" || cmd.verb === "wait" ? "watch" : cmd.handoff ? "handoff" : "dispatch";
      const key = `${a.pane_id}|${cmd.target}|${kind}`;
      const prev = talk.get(key);
      if (prev) {
        prev.n++;
        prev.at = Math.max(prev.at, cmd.t);
      } else {
        talk.set(key, { s: a.pane_id, t: cmd.target, kind, at: cmd.t, n: 1 });
      }
    }
  }
  links.push(...talk.values());

  const statusOf = new Map(agents.map((a) => [a.pane_id, a.agent_status || "unknown" as AgentStatus]));
  for (const [dir, panes] of input.corr.dirAgents) {
    const here = [...new Set(panes)].filter((p) => paneIds.has(p)).sort();
    if (here.length < 2) continue;
    const liveWorking = here.filter((p) =>
      statusOf.get(p) === "working" &&
      (input.corr.agentDirs.get(p) || []).some((h) => h.dir === dir && h.live));
    for (let i = 0; i < here.length; i++) {
      for (let j = i + 1; j < here.length; j++) {
        links.push({
          s: here[i]!,
          t: here[j]!,
          kind: "couple",
          at: 0,
          n: 1,
          hot: liveWorking.includes(here[i]!) && liveWorking.includes(here[j]!),
        });
      }
    }
  }

  return { at: now, me: input.me, theme: paletteHex(), nodes, links };
}

const HTML_FILE = path.join(import.meta.dirname, "map.html");

export function startMap(build: () => SwarmData): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || "/", "http://local");
    try {
      if (u.pathname === "/") {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(fs.readFileSync(HTML_FILE));
      } else if (u.pathname === "/data") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(build()));
      } else if (u.pathname === "/focus") {
        const pane = u.searchParams.get("pane") || "";
        rpc("pane.focus", { pane_id: pane }).then(
          () => res.end("ok"),
          () => { res.statusCode = 502; res.end("focus failed"); },
        );
      } else {
        res.statusCode = 404;
        res.end();
      }
    } catch (error) {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : "error");
    }
  });
  server.unref();
  return new Promise((resolve, reject) => {
    const done = () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : MAP_PORT;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    };
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EADDRINUSE") return reject(error);
      server.removeAllListeners("error");
      server.once("error", reject);
      server.listen(0, "127.0.0.1", done);
    });
    server.listen(MAP_PORT, "127.0.0.1", done);
  });
}
