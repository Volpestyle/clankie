// Native Claude Code mods (>= 2.1.287) can read the catalog the model actually
// sees. Command SessionStart hooks run before MCP is available and cannot.
const STARTUP_MS = 20_000;
const RETRY_MS = 500;
let interactive = false;
let generation = 0;

export function register(on) {
  on("session.start", async ($, event, next) => {
    interactive = event.isInteractive;
    if (interactive) await scheduleProbe($);
    return next(event);
  });
  // A mod's session.start runs once per process. Native SessionStart also
  // covers /clear, /resume and compaction without replacing the native session.
  on("classic.SessionStart", async ($, event, next) => {
    if (interactive && !event.agent_id) await scheduleProbe($);
    return next(event);
  });
  // An unchanged module need not be reloaded with its MCP configuration.
  // Recheck after the native fixing action, preserving its result.
  on("command.run", { command: "reload-plugins" }, async ($, event, next) => {
    const result = await next(event);
    if (interactive) await scheduleProbe($);
    return result;
  });
}

async function scheduleProbe($) {
  const pane = await $.env.get("HERDR_PANE_ID");
  const socket = await $.env.get("HERDR_SOCKET_PATH");
  if (!pane || !socket) return;
  const deadline = (await $.clock.now()) + STARTUP_MS;
  const sessionId = await $.session.id();
  const probe = ++generation;
  // Let the session finish starting so its MCP clients can finish discovery.
  $.clock.after(0, async () => checkCatalog($, deadline, sessionId, probe));
}

async function checkCatalog($, deadline, sessionId, probe) {
  if (generation !== probe || (await $.session.id()) !== sessionId) return;
  const bridge = $.plugin.name === "clankie-worker" ? "worker" : "operator";
  const helper =
    bridge === "worker" ? `${$.plugin.root}/mods/report.mjs` : `${$.plugin.root}/worker/mods/report.mjs`;
  const report = {
    schemaVersion: 1,
    harness: "claude",
    sessionId,
    bridge,
    tools: [],
    checkedAt: new Date(await $.clock.now()).toISOString(),
  };
  if (bridge === "operator") {
    const conversationId = await $.env.get("CLANKIE_CONVERSATION_ID");
    if (conversationId) report.conversationId = conversationId;
  }
  try {
    // The native client resolves this plugin's server, including a transport
    // deduplicated under another registration. Use that exact namespace.
    const connection = await $.mcp.connect("clankie");
    // Refused connections omit server in Claude's native API. Its own plugin
    // registration still has a known namespace; an available native catalog
    // with none of that server's tools proves a mismatch, including rejection
    // of the entire server's tools/list.
    const server = connection.isConnected ? connection.server : `plugin:${$.plugin.name}:clankie`;
    if (typeof server !== "string") throw new Error("Native MCP namespace is unavailable");
    const prefix = `mcp__${server.replace(/[^a-zA-Z0-9_-]/g, "_")}__`;
    // Keep only this server's exact namespace; another server with the same
    // tool names cannot make a broken Clankie bridge look healthy.
    report.tools = (await $.tool.list())
      .filter((tool) => tool.mcp && tool.name.startsWith(prefix))
      .map((tool) => tool.name.slice(prefix.length));
  } catch (error) {
    report.error = `Native Claude tool catalog unavailable: ${String(error).slice(0, 512)}`;
  }
  let result;
  try {
    const response = await $.process.run(["node", helper], {
      stdin: JSON.stringify(report),
      timeoutMs: 10_000,
    });
    if (response.exitCode !== 0) throw new Error(response.stderr || "catalog report failed");
    result = JSON.parse(response.stdout);
  } catch (error) {
    result = {
      status: "unverified",
      detail: `Clankie tool check could not be reported: ${String(error).slice(0, 512)}`,
      remediation: "Run clankie doctor in this pane to inspect its fleet link.",
    };
  }
  if (generation !== probe || (await $.session.id()) !== sessionId) return;
  if (result.status === "unlinked" || result.status === "matched") {
    $.ui.status(undefined);
    return;
  }
  if ((await $.clock.now()) < deadline) {
    $.clock.after(RETRY_MS, async () => checkCatalog($, deadline, sessionId, probe));
    return;
  }
  const message = [result.detail, result.remediation].filter(Boolean).join(" ");
  $.ui.status(message || "Clankie tools are unverified; run clankie doctor in this pane.");
  $.ui.log(message || "Clankie tools are unverified; run clankie doctor in this pane.");
}
