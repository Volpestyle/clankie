import { findBoardPane, rpc } from "./runtime.ts";

interface PluginPaneResult {
  plugin_pane?: { pane?: { pane_id?: string } };
}

let ctx: { focused_pane_id?: string } = {};
try { ctx = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}"); } catch {}
const target = process.env.HERD_LEAD_TARGET || ctx.focused_pane_id || null;

const open = await findBoardPane().catch(() => "");
if (open) {
  console.error(`board already open in ${open} — herdr-lead focus jumps to it`);
  console.log(open);
  process.exit(0);
}

const res = await rpc<PluginPaneResult>("plugin.pane.open", {
  plugin_id: "herd-lead",
  entrypoint: "board",
  placement: "split",
  direction: "right",
  focus: false,
  ...(target ? { target_pane_id: target, env: { HERD_LEAD_PEER: target } } : {}),
});

if (res?.error) {
  console.error(JSON.stringify(res.error));
  process.exit(1);
}
console.log(res?.result?.plugin_pane?.pane?.pane_id || "opened");
