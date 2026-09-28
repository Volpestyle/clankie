import { paletteHex } from "./runtime.ts";
import type { SwarmData, SwarmLink, SwarmNode } from "./types.ts";

type Rgb = [number, number, number];

const hexRgb = (hex: string): Rgb => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

const STATUS_COLOR: Record<string, string> = {
  working: "blue", blocked: "red", done: "green", idle: "subtext", unknown: "overlay",
};

const EDGE_STYLE: Record<string, { color: string; skip: number; arrow: boolean }> = {
  dispatch: { color: "subtext", skip: 1, arrow: true },
  handoff: { color: "peach", skip: 1, arrow: true },
  watch: { color: "overlay", skip: 2, arrow: true },
  couple: { color: "overlay", skip: 3, arrow: false },
  ask: { color: "red", skip: 1, arrow: true },
  on: { color: "teal", skip: 2, arrow: false },
};

function edgeAlpha(l: SwarmLink, now: number): number {
  if (l.kind === "couple") return l.hot ? 0.9 : 0.4;
  if (l.kind === "on") return 0.3;
  if (l.kind === "ask") return 0.95;
  const age = now - l.at;
  return age < 600e3 ? 0.95 : age < 3600e3 ? 0.7 : age < 6 * 3600e3 ? 0.5 : 0.35;
}

function hashN(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function bresenham(x0: number, y0: number, x1: number, y1: number): Array<[number, number]> {
  const cells: Array<[number, number]> = [];
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const stepX = x0 < x1 ? 1 : -1, stepY = y0 < y1 ? 1 : -1;
  let err = dx + dy, x = x0, y = y0;
  for (let guard = 0; guard < 4000; guard++) {
    cells.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += stepX; }
    if (e2 <= dx) { err += dx; y += stepY; }
  }
  return cells;
}

interface Placement { x: number; y: number }
interface LabelSpec { col: number; text: string; rgb: Rgb }

export interface SwarmFrame {
  lines: string[];
  order: string[];
  rowOf(id: string): number | null;
  posOf(id: string): { col: number; row: number } | null;
  hitAt(col: number, row: number): string | null;
}

export function renderSwarmFrame(opts: {
  data: SwarmData;
  width: number;
  rows: number;
  now: number;
  sel: string | null;
  me: string;
}): SwarmFrame {
  const { data, width, rows, now, sel } = opts;
  const colors = data.theme?.colors || paletteHex().colors;
  const rgb = (name: string): Rgb => hexRgb(colors[name as keyof typeof colors] || "#6c7086");
  const base = rgb("base");
  const blend = (c: Rgb, a: number): Rgb => [
    Math.round(base[0] + (c[0] - base[0]) * a),
    Math.round(base[1] + (c[1] - base[1]) * a),
    Math.round(base[2] + (c[2] - base[2]) * a),
  ];

  const PW = width;
  const PH = rows * 2;
  const px: Array<Rgb | null> = new Array(PW * PH).fill(null);
  const put = (x: number, y: number, c: Rgb): void => {
    x = Math.round(x); y = Math.round(y);
    if (x >= 0 && x < PW && y >= 0 && y < PH) px[y * PW + x] = c;
  };
  const labels = new Map<number, LabelSpec[]>();
  const label = (row: number, colCenter: number, text: string, color: Rgb, align: "center" | "left" | "right" = "center", depth = 0): void => {
    if (row < 0 || row >= rows || !text) return;
    const col = align === "center" ? Math.round(colCenter - text.length / 2)
      : align === "left" ? Math.round(colCenter)
      : Math.round(colCenter - text.length);
    const list = labels.get(row) || [];
    const collides = list.some((l) => col < l.col + l.text.length + 1 && l.col < col + text.length + 1);
    if (collides && depth < 2) return label(row + 1, colCenter, text, color, align, depth + 1);
    if (!labels.has(row)) labels.set(row, list);
    list.push({ col, text, rgb: color });
  };

  const lattice = 12;
  const dot = blend(rgb("surface"), 0.8);
  for (let y = 0; y < PH; y += lattice) for (let x = 0; x < PW; x += lattice) put(x, y, dot);

  const agents = data.nodes.filter((n) => n.kind === "agent");
  const place = new Map<string, Placement>();
  const order: string[] = [];

  if (agents.length) {
    const byCluster = new Map<string, { key: string; label: string; agents: SwarmNode[]; hub: SwarmNode | null }>();
    for (const n of data.nodes) {
      if (n.kind === "you") continue;
      const key = n.cluster || "·";
      if (!byCluster.has(key)) byCluster.set(key, { key, label: key, agents: [], hub: null });
      const g = byCluster.get(key)!;
      if (n.kind === "hub") { g.hub = n; g.label = n.label; }
      else g.agents.push(n);
    }
    const groups = [...byCluster.values()].sort((a, b) =>
      (a.key === "·" ? 1 : 0) - (b.key === "·" ? 1 : 0) || a.label.localeCompare(b.label));
    const cx = Math.floor(PW / 2);
    const cy = Math.floor((PH - 12) / 2);
    const orbit = 8;
    const single = groups.length <= 1;
    const Ry = single ? 0 : Math.max(6, Math.min(22, cy - orbit - 5, PH - 12 - cy - orbit));
    const Rx = single ? 0 : Math.max(Ry, Math.min(cx - 28, Math.max(26, Math.round(Ry * 2.6))));
    const startAng = groups.length === 2 ? 180 : -90;

    groups.forEach((g, i) => {
      const ang = (startAng + i * 360 / Math.max(1, groups.length)) * Math.PI / 180;
      const hx = cx + Math.round(Math.cos(ang) * Rx);
      const hy = cy + Math.round(Math.sin(ang) * Ry);
      if (g.hub) place.set(g.hub.id, { x: hx, y: hy });
      const away = groups.length <= 1 ? -Math.PI / 2 : ang;
      const sorted = [...g.agents].sort((a, b) => a.id.localeCompare(b.id));
      const spots: Placement[] = [];
      sorted.forEach((a, j) => {
        const aa = away + (sorted.length === 1 ? 0 : j * 2 * Math.PI / sorted.length + hashN(g.key) % 7 * 0.13);
        const spot = { x: hx + Math.round(Math.cos(aa) * orbit * 1.6), y: hy + Math.round(Math.sin(aa) * orbit) };
        place.set(a.id, spot);
        spots.push(spot);
        order.push(a.id);
      });
      if (g.hub) {
        const cands: Array<[number, number, "center" | "left" | "right"]> =
          [[0, -6, "center"], [0, 7, "center"], [7, 1, "left"], [-7, 1, "right"]];
        let best = cands[0]!, bestScore = -1;
        for (const cand of cands) {
          const score = Math.min(99, ...spots.map((s) => Math.hypot(hx + cand[0] - s.x, hy + cand[1] - s.y)))
            + (cand[2] === "center" ? 1.5 : 0);
          if (score > bestScore) { bestScore = score; best = cand; }
        }
        const [ox, oy, align] = best;
        const row = Math.floor((hy + oy) / 2);
        const nameRow = align === "center" && oy < 0 ? row - 1 : row;
        label(nameRow, hx + ox, g.hub.label, blend(rgb("subtext"), 0.95), align);
        if (g.hub.branch && align === "center") {
          label(nameRow + 1, hx + ox, g.hub.branch, blend(rgb("overlay"), 0.9), align);
        }
      }
    });
    place.set("you", { x: cx, y: Math.min(PH - 5, cy + Ry + orbit + 10) });
  }

  const at = (id: string): Placement | undefined => place.get(id);

  const ego = sel ? new Set([sel, ...data.links.flatMap((l) => (l.s === sel ? [l.t] : l.t === sel ? [l.s] : []))]) : null;
  const wall = Date.now();

  for (const l of data.links) {
    let ownHub = false;
    if (l.kind === "on") {
      const src = data.nodes.find((n) => n.id === l.s);
      ownHub = !!src && src.cluster === l.t;
    }
    const a = at(l.s), b = at(l.t);
    if (!a || !b) continue;
    const st = EDGE_STYLE[l.kind] || EDGE_STYLE.dispatch!;
    let alpha = edgeAlpha(l, wall) * (ownHub ? 0.55 : 1);
    if (ego && !(ego.has(l.s) && ego.has(l.t))) alpha *= 0.15;
    const color = l.kind === "couple" && l.hot ? rgb("red") : rgb(st.color);
    const path = bresenham(a.x, a.y, b.x, b.y);
    const trimmed = path.slice(2, Math.max(2, path.length - 2));
    trimmed.forEach(([x, y], i) => {
      if (i % st.skip !== 0) return;
      put(x, y, blend(color, alpha));
    });
    if (st.arrow && trimmed.length > 2) {
      const [hx, hy] = trimmed[trimmed.length - 2]!;
      put(hx, hy, blend(color, Math.min(1, alpha + 0.2)));
      put(hx + 1, hy, blend(color, Math.min(1, alpha + 0.2)));
    }
    if ((l.kind === "dispatch" || l.kind === "handoff") && wall - l.at < 600e3 && trimmed.length > 2) {
      const dimP = ego && !(ego.has(l.s) && ego.has(l.t));
      const p = Math.floor((now * 0.014 + hashN(l.s + l.t) % 97) % trimmed.length);
      put(trimmed[p]![0], trimmed[p]![1], blend(rgb("text"), dimP ? 0.2 : 1));
    }
  }

  const DISC: Array<[number, number]> = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -2; dx <= 2; dx++) {
    if (Math.abs(dx) === 2 && dy !== 0) continue;
    DISC.push([dx, dy]);
  }
  const DIAMOND: Array<[number, number]> = [];
  for (let dy = -2; dy <= 2; dy++) for (let dx = -3; dx <= 3; dx++) {
    if (Math.abs(dx) / 1.5 + Math.abs(dy) <= 2) DIAMOND.push([dx, dy]);
  }

  for (const n of data.nodes) {
    const p = at(n.id);
    if (!p) continue;
    const dimmed = ego ? !ego.has(n.id) : false;
    const baseAlpha = dimmed ? 0.3 : 1;
    if (n.kind === "hub") {
      for (const [dx, dy] of DIAMOND) {
        const edge = Math.abs(dx) / 1.5 + Math.abs(dy) > 1.2;
        put(p.x + dx, p.y + dy, blend(rgb("teal"), baseAlpha * (edge ? 0.9 : 0.4)));
      }
    } else if (n.kind === "you") {
      for (const [dx, dy] of DISC) put(p.x + dx, p.y + dy, blend(rgb("lavender"), baseAlpha));
      put(p.x, p.y - 2, blend(rgb("lavender"), baseAlpha));
      label(Math.floor(p.y / 2) + 2, p.x, "you", blend(rgb("lavender"), baseAlpha));
    } else {
      const color = rgb(STATUS_COLOR[n.status || "unknown"] || "overlay");
      let alpha = baseAlpha;
      if (n.status === "blocked") alpha *= (now / 500) % 2 < 1 ? 1 : 0.4;
      for (const [dx, dy] of DISC) put(p.x + dx, p.y + dy, blend(color, alpha));
      if (n.id === data.me) put(p.x, p.y, base);
      if (n.status === "working") {
        const a = now / 700 + hashN(n.id) % 13;
        put(p.x + Math.round(Math.cos(a) * 4), p.y + Math.round(Math.sin(a) * 3), blend(color, baseAlpha));
      }
      if (sel === n.id) {
        const ring = blend(rgb("text"), 0.7);
        for (let k = -3; k <= 3; k++) {
          put(p.x + k, p.y - 3, ring);
          put(p.x + k, p.y + 3, ring);
        }
        for (let k = -2; k <= 2; k++) {
          put(p.x - 4, p.y + k, ring);
          put(p.x + 4, p.y + k, ring);
        }
      }
      const labelRow = Math.floor((p.y + 3) / 2) + 1;
      label(labelRow >= rows ? Math.floor((p.y - 4) / 2) : labelRow, p.x, n.label,
        blend(sel === n.id ? rgb("text") : rgb("subtext"), dimmed ? 0.35 : 1));
    }
  }

  if (!agents.length) {
    label(Math.floor(rows / 2), Math.floor(PW / 2), "no agents in the herd", rgb("subtext"));
  } else if (!data.links.some((l) => l.kind === "dispatch" || l.kind === "handoff" || l.kind === "watch" || l.kind === "ask")) {
    const youP = place.get("you");
    const row = youP ? Math.floor(youP.y / 2) + 4 : rows - 4;
    label(Math.min(rows - 2, row), Math.floor(PW / 2),
      "quiet swarm — prompts, watches, handoffs, and blocked agents draw here", blend(rgb("overlay"), 0.9));
  }

  if (PW >= 76) {
    const legend: Array<[string, string, number]> = [
      ["■ working", "blue", 0.9], ["■ idle", "subtext", 0.9], ["■ blocked", "red", 0.9],
      ["■ done", "green", 0.9], ["◆ worktree", "teal", 0.9], ["■ you", "lavender", 0.9],
    ];
    let col = 2;
    for (const [text, cn, a] of legend) {
      if (col + text.length >= PW) break;
      label(rows - 1, col, text, blend(rgb(cn), a), "left");
      col += text.length + 3;
    }
  }

  const FG = (c: Rgb): string => `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`;
  const BG = (c: Rgb): string => `\x1b[48;2;${c[0]};${c[1]};${c[2]}m`;
  const lines: string[] = [];
  for (let row = 0; row < rows; row++) {
    const chars: Array<{ ch: string; fg: Rgb | null; bg: Rgb | null }> = [];
    for (let x = 0; x < PW; x++) {
      const top = px[row * 2 * PW + x];
      const bot = px[(row * 2 + 1) * PW + x];
      if (top && bot) chars.push({ ch: "▀", fg: top, bg: bot });
      else if (top) chars.push({ ch: "▀", fg: top, bg: null });
      else if (bot) chars.push({ ch: "▄", fg: bot, bg: null });
      else chars.push({ ch: " ", fg: null, bg: null });
    }
    for (const spec of labels.get(row) || []) {
      for (let i = 0; i < spec.text.length; i++) {
        const x = spec.col + i;
        if (x >= 0 && x < PW) chars[x] = { ch: spec.text[i]!, fg: spec.rgb, bg: null };
      }
    }
    let out = "";
    let curFg = "", curBg = "";
    for (const ch of chars) {
      const fg = ch.fg ? FG(ch.fg) : "";
      const bg = ch.bg ? BG(ch.bg) : "";
      if (fg !== curFg) { out += fg || "\x1b[39m"; curFg = fg; }
      if (bg !== curBg) { out += bg || "\x1b[49m"; curBg = bg; }
      out += ch.ch;
    }
    lines.push(out + "\x1b[0m");
  }

  return {
    lines,
    order,
    rowOf: (id) => {
      const p = place.get(id);
      return p ? Math.floor(p.y / 2) : null;
    },
    posOf: (id) => {
      const p = place.get(id);
      return p ? { col: p.x, row: Math.floor(p.y / 2) } : null;
    },
    hitAt: (col, row) => {
      const y = row * 2 + 1;
      let best: string | null = null, bestD = 5;
      for (const [id, p] of place) {
        const d = Math.hypot(p.x - col, (p.y - y) / 2);
        if (d < bestD) { bestD = d; best = id; }
      }
      return best;
    },
  };
}
