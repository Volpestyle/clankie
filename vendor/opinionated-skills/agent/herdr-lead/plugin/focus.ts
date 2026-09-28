import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { BOARD_LABEL, rpc } from "./runtime.ts";
import type { HerdrSnapshot } from "./types.ts";

const STATE = process.env.HERDR_PLUGIN_STATE_DIR
  || path.join(os.homedir(), ".local/state/herdr/plugins/herd-lead");
const BOARD_FILE = path.join(STATE, "board.json");

interface SavedBoard {
  peer?: string;
  pane?: string;
}

interface PluginPaneResult {
  plugin_pane?: { pane?: { pane_id?: string } };
}

function readBoard(): SavedBoard {
  try { return JSON.parse(fs.readFileSync(BOARD_FILE, "utf8")) as SavedBoard; } catch { return {}; }
}

function rememberPeer(peer: string, pane: string): void {
  try {
    fs.mkdirSync(STATE, { recursive: true });
    fs.writeFileSync(BOARD_FILE, JSON.stringify({ ...readBoard(), peer, pane }));
  } catch {}
}

const snap = (await rpc<{ snapshot?: HerdrSnapshot }>("session.snapshot", {}))?.result?.snapshot;
if (!snap) { console.error("no snapshot"); process.exit(1); }

const me = process.env.HERD_LEAD_TARGET || snap.focused_pane_id;
const board = (snap.panes || []).find((p) => p.label === BOARD_LABEL);
const saved = readBoard();

if (!board) {
  const res = await rpc<PluginPaneResult>("plugin.pane.open", {
    plugin_id: "herd-lead",
    entrypoint: "board",
    placement: "split",
    direction: "right",
    focus: true,
    ...(me ? { target_pane_id: me, env: { HERD_LEAD_PEER: me } } : {}),
  });
  if (res.error) {
    console.error(res.error.message || "could not open herd lead board");
    process.exit(1);
  }
  console.log(res?.result?.plugin_pane?.pane?.pane_id || "opened");
  process.exit(0);
}

let target: string | undefined;
if (me === board.pane_id) {
  const panes = (snap.panes || []).filter((p) => p.pane_id !== board.pane_id);
  target = panes.find((p) => p.pane_id === saved.peer)?.pane_id
    || panes.filter((p) => p.agent).find((p) => p.tab_id === board.tab_id)?.pane_id
    || panes.filter((p) => p.agent)[0]?.pane_id;
} else {
  target = board.pane_id;
  if (me) rememberPeer(me, board.pane_id);
}

if (!target) { console.error("nothing to focus"); process.exit(1); }

const focused = await rpc("pane.focus", { pane_id: target });
if (focused.error) {
  console.error(focused.error.message || `could not focus ${target}`);
  process.exit(1);
}
console.log(target);
