// Native Claude Code mods (>= 2.1.287) can read the catalog the model actually
// sees. Command SessionStart hooks run before MCP is available and cannot.
const STARTUP_MS = 20_000;
const RETRY_MS = 500;
const WATCH_MS = 5_000;
// Every report costs Clankie fresh process proofs, so an unchanged catalog it
// already accepted is not resent. The heartbeat only restores his in-memory
// verdict after a service restart (VUH-2062).
const HEARTBEAT_MS = 300_000;
let interactive = false;
let generation = 0;
let probing = false;
let watcher;
let activeTools = 0;
let nextWatchAfter = 0;
// A successful check clears the status, not the warning history. Intermittent
// link failures must not print the same cause again after every healthy probe.
const warnedCauses = new Set();
let failures = 0;
let retryAfter = 0;
let accepted;
const activeTurns = new Set();
let activitySession;
let activityInstance;
let activitySequence = 0;
let reportingActivity = false;
let activityFingerprint;
const childActivity = new Map();

/**
 * Where this session sits, as the worker's link names it: its Herdr pane, else the
 * Herdr desktop app's terminal Clankie started it in (ADR 0319). Clankie clears the
 * Herdr variables a desktop terminal would inherit, so empty ones are none.
 */
async function seatOf($) {
  const pane = (await $.env.get("HERDR_PANE_ID"))?.trim();
  const socket = (await $.env.get("HERDR_SOCKET_PATH"))?.trim();
  if (pane || socket) return pane && socket ? { pane, socket } : undefined;
  const terminal = (await $.env.get("HC_TERMINAL_ID"))?.trim();
  const core = (await $.env.get("HC_TERMINAL_SOCKET"))?.trim();
  return terminal && core && /^t[0-9a-z]+$/u.test(terminal)
    ? { pane: `herdr-core/${terminal}`, socket: core }
    : undefined;
}

async function reportActivity($) {
  if (!interactive || reportingActivity) return;
  reportingActivity = true;
  try {
    const sessionId = await $.session.id();
    const now = await $.clock.now();
    if (activitySession !== sessionId) {
      activitySession = sessionId;
      activityInstance = now;
      activitySequence = 0;
      childActivity.clear();
      activityFingerprint = undefined;
    }
    const instance = activityInstance;
    const where = await seatOf($);
    // Native 2.1.310 returns exact child agent IDs and current task states.
    // It excludes the root. Root turn events use generated agent IDs without
    // a verified root discriminator, so they must not renew a root lease.
    const agents = await $.agent.list();
    if (
      !Array.isArray(agents) ||
      agents.length > 64 ||
      agents.some(
        (agent) =>
          typeof agent.id !== "string" ||
          !agent.id ||
          agent.id.length > 200 ||
          (agent.teammateId !== undefined && (typeof agent.teammateId !== "string" || !agent.teammateId)) ||
          !["running", "waiting", "idle", "completed", "failed", "killed", "paused"].includes(agent.status),
      ) ||
      new Set(agents.map((agent) => agent.id)).size !== agents.length
    )
      return;
    const currentSession = await $.session.id();
    if (
      !where ||
      !interactive ||
      currentSession !== sessionId ||
      activitySession !== sessionId ||
      activityInstance !== instance
    )
      return;
    const children = agents
      .filter((agent) => agent.teammateId === undefined)
      .map((agent) => {
        const state = agent.status === "running" ? "working" : "idle";
        const previous = childActivity.get(agent.id);
        const since = previous?.state === state ? previous.since : now;
        childActivity.set(agent.id, { state, since });
        return { agentId: agent.id, state, stateSince: new Date(since).toISOString() };
      });
    const ids = new Set(children.map((child) => child.agentId));
    for (const id of childActivity.keys()) if (!ids.has(id)) childActivity.delete(id);
    children.sort((left, right) => left.agentId.localeCompare(right.agentId));
    const fingerprint = JSON.stringify(children);
    // Only working children need continuous renewals. Send idle transitions
    // once, without adding an observer subprocess to every idle pane timer.
    if (
      !children.some((child) => child.state === "working") &&
      (fingerprint === activityFingerprint || (children.length === 0 && activityFingerprint === undefined))
    )
      return;
    const helper =
      $.plugin.name === "clankie-worker"
        ? `${$.plugin.root}/mods/activity.mjs`
        : `${$.plugin.root}/worker/mods/activity.mjs`;
    const result = await $.process.run(["node", helper], {
      stdin: JSON.stringify({
        sessionId,
        activity: {
          instanceStartedAt: new Date(instance).toISOString(),
          sequence: ++activitySequence,
          checkedAt: new Date(now).toISOString(),
          children,
        },
      }),
      timeoutMs: 4500,
    });
    if (
      result.exitCode === 0 &&
      interactive &&
      activitySession === sessionId &&
      activityInstance === instance
    )
      activityFingerprint = fingerprint;
  } catch {
    // Lost native observation expires its facts; it never holds work.
  } finally {
    reportingActivity = false;
  }
}

export function register(on) {
  on("session.start", async ($, event, next) => {
    interactive = event.isInteractive;
    if (interactive) {
      activitySession = await $.session.id();
      activityInstance = await $.clock.now();
      activitySequence = 0;
      activeTurns.clear();
      childActivity.clear();
      activityFingerprint = undefined;
      await reportActivity($);
      await scheduleProbe($);
      watcher?.cancel();
      // This runs in the original native session. Native Claude consumes MCP
      // list_changed itself; observing its accepted catalog needs no prompt,
      // SDK query, fork, plugin reload, or all-server reconnect.
      watcher = $.clock.every(WATCH_MS, async () => {
        await reportActivity($);
        if ((await $.clock.now()) >= nextWatchAfter) await scheduleProbe($, false);
      });
    }
    return next(event);
  });
  on("session.end", async ($, event, next) => {
    interactive = false;
    generation += 1;
    watcher?.cancel();
    watcher = undefined;
    activeTurns.clear();
    activeTools = 0;
    activitySession = undefined;
    activityInstance = undefined;
    childActivity.clear();
    activityFingerprint = undefined;
    nextWatchAfter = 0;
    retryAfter = 0;
    failures = 0;
    accepted = undefined;
    warnedCauses.clear();
    return next(event);
  });
  on("turn.start", ($, event, next) => {
    activeTurns.add(event.turnId);
    return next(event);
  });
  on("turn.complete", async ($, event, next) => {
    try {
      return await next(event);
    } finally {
      activeTurns.delete(event.turnId);
      await reportActivity($);
      if (interactive) await scheduleProbe($, false);
    }
  });
  on("tool.call", async ($, event, next) => {
    activeTools += 1;
    try {
      return await next(event);
    } finally {
      activeTools -= 1;
    }
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

async function scheduleProbe($, startup = true) {
  if (!interactive || probing || activeTools || activeTurns.size) return;
  if (!startup && (await $.clock.now()) < retryAfter) return;
  if (!(await seatOf($))) return;
  const deadline = (await $.clock.now()) + (startup ? STARTUP_MS : 0);
  nextWatchAfter = deadline;
  const sessionId = await $.session.id();
  const probe = ++generation;
  // Let the session finish starting so its MCP clients can finish discovery.
  $.clock.after(0, async () => checkCatalog($, deadline, sessionId, probe, startup));
}

async function checkCatalog($, deadline, sessionId, probe, force) {
  if (probing) return;
  probing = true;
  try {
    await observeCatalog($, deadline, sessionId, probe, force);
  } finally {
    probing = false;
  }
}

async function observeCatalog($, deadline, sessionId, probe, force) {
  const current = async () => {
    const observedSessionId = await $.session.id();
    return (
      interactive &&
      generation === probe &&
      observedSessionId === sessionId &&
      !activeTools &&
      activeTurns.size === 0
    );
  };
  if (!(await current())) return;
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
    // Background native agents may outlive the main turn. Do not touch their
    // shared MCP connection while any loop/tool is active. Unknown statuses
    // also hold observation, rather than treating an unavailable idle proof as
    // permission to reconnect.
    const agents = await $.agent.list();
    if (
      !(await current()) ||
      agents.some((agent) => !["completed", "failed", "killed"].includes(agent.status))
    )
      return;
    // The native client resolves this plugin's server, including a transport
    // deduplicated under another registration. Use that exact namespace.
    const preferred = bridge === "worker" ? "worker" : "lead";
    let name = preferred;
    let connection;
    try {
      connection = await $.mcp.connect(name);
    } catch {
      /* Legacy registration. */
    }
    if (!connection?.isConnected) {
      let legacy;
      try {
        legacy = await $.mcp.connect("clankie");
      } catch {
        /* Absent legacy registration. */
      }
      if (legacy?.isConnected) {
        name = "clankie";
        connection = legacy;
      }
    }
    if (!connection) throw new Error("Native MCP API unavailable");
    if (!(await current())) return;
    // Refused connections omit server in Claude's native API. Its own plugin
    // registration still has a known namespace; an available native catalog
    // with none of that server's tools proves a mismatch, including rejection
    // of the entire server's tools/list.
    const server = connection?.isConnected ? connection.server : `plugin:${$.plugin.name}:${name}`;
    if (typeof server !== "string") throw new Error("Native MCP namespace is unavailable");
    const prefix = `mcp__${server.replace(/[^a-zA-Z0-9_-]/g, "_")}__`;
    // Keep only this server's exact namespace; another server with the same
    // tool names cannot make a broken Clankie bridge look healthy.
    const tools = await $.tool.list();
    if (!(await current())) return;
    report.tools = tools
      .filter((tool) => tool.mcp && tool.name.startsWith(prefix))
      .map((tool) => tool.name.slice(prefix.length));
  } catch {
    report.error = "Native Claude tool catalog unavailable: original mod API unsupported or disconnected";
  }
  if (!(await current())) return;
  const fingerprint = JSON.stringify([
    report.sessionId,
    report.bridge,
    report.conversationId ?? null,
    report.error ?? null,
    [...report.tools].sort(),
  ]);
  const checkedAt = await $.clock.now();
  if (!force && accepted?.fingerprint === fingerprint && checkedAt - accepted.at < HEARTBEAT_MS) {
    nextWatchAfter = checkedAt + WATCH_MS;
    return;
  }
  accepted = undefined;
  let result;
  try {
    const response = await $.process.run(["node", helper], {
      stdin: JSON.stringify(report),
      timeoutMs: 25_000,
    });
    if (response.exitCode !== 0) throw new Error(response.stderr || "catalog report failed");
    result = JSON.parse(response.stdout);
  } catch {
    result = {
      status: "unverified",
      reason: "report_helper_failed",
      detail: "Clankie tool check report helper failed or exceeded its 25s deadline.",
      remediation:
        "Run clankie doctor in this pane. Ask Clankie to refresh the worker plugin; then save this session and restart/resume Claude.",
    };
  }
  if (!(await current())) return;
  if (result.status === "unlinked" || result.status === "matched") {
    accepted = { fingerprint, at: checkedAt };
    nextWatchAfter = (await $.clock.now()) + WATCH_MS;
    failures = 0;
    retryAfter = 0;
    $.ui.status(undefined);
    return;
  }
  if ((await $.clock.now()) < deadline) {
    $.clock.after(RETRY_MS, async () => checkCatalog($, deadline, sessionId, probe, force));
    return;
  }
  const message = [result.detail, result.remediation].filter(Boolean).join(" ");
  const warning = message || "Clankie tools are unverified; run clankie doctor in this pane.";
  $.ui.status(warning);
  const cause = result.reason || warning;
  if (!warnedCauses.has(cause)) {
    $.ui.log(warning);
    warnedCauses.add(cause);
  }
  // Repeated turns do not amplify a congested link's background traffic.
  failures = Math.min(failures + 1, 4);
  retryAfter = (await $.clock.now()) + Math.min(60_000, WATCH_MS * 2 ** failures);
  nextWatchAfter = retryAfter;
}
