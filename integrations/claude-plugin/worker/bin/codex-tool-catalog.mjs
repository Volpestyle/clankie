const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Read only the catalog of an already loaded original native thread.
 * Omitting threadId would read a different observer runtime, and resuming a
 * thread would create one. Neither proves what the interactive pane accepted.
 * https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/src/request_processors/mcp_processor.rs
 */
export async function codexToolCatalogReport({
  sessionId,
  bridge = "worker",
  request,
  requireConnected = false,
  onServerStatus,
}) {
  const report = {
    schemaVersion: 1,
    harness: "codex",
    sessionId,
    bridge,
    tools: [],
    checkedAt: new Date().toISOString(),
  };
  if (!request) {
    report.error =
      "Advisory: this embedded Codex session exposes no native catalog endpoint, so its Clankie tool catalog is unverified. Continue the assignment with your current lead; this does not require a new hire.";
    return report;
  }
  try {
    const loaded = await request("thread/loaded/list", {});
    if (!object(loaded) || !Array.isArray(loaded.data) || !loaded.data.includes(sessionId))
      throw new Error("Original Codex thread is not loaded on this native endpoint");
    const matches = [];
    const cursors = new Set();
    let cursor;
    for (;;) {
      const status = await request("mcpServerStatus/list", {
        threadId: sessionId,
        serverName: "clankie",
        detail: "toolsAndAuthOnly",
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (!object(status) || !Array.isArray(status.data)) throw new Error("Malformed native MCP status");
      matches.push(...status.data.filter((row) => object(row) && row.name === "clankie"));
      if (status.nextCursor == null) break;
      if (typeof status.nextCursor !== "string" || cursors.has(status.nextCursor) || cursors.size >= 64)
        throw new Error("Incomplete native MCP status pagination");
      cursor = status.nextCursor;
      cursors.add(cursor);
    }
    // A complete original-thread inventory proving the server absent/rejected
    // is a mismatch (accepted no tools), rather than an observation failure.
    if (matches.length === 0) {
      if (requireConnected) throw new Error("Original Codex Clankie server is absent");
      return report;
    }
    if (matches.length !== 1) throw new Error("Native Codex Clankie server is ambiguous");
    const row = matches[0];
    // Only a complete, unambiguous original-thread response can prove a
    // terminal startup failure. Keep this native observation out of the
    // catalog report's public wire schema.
    onServerStatus?.({
      ...(typeof row.runtimeStatus === "string" ? { runtimeStatus: row.runtimeStatus } : {}),
      ...(typeof row.toolsError === "string" ? { toolsError: row.toolsError.slice(0, 1024) } : {}),
    });
    if (
      ["failed", "disabled", "cancelled", "disconnected"].includes(row.runtimeStatus) ||
      row.toolsError != null
    ) {
      if (requireConnected)
        throw new Error("Original Codex Clankie server is disconnected or rejected tools");
      return report;
    }
    if (row.runtimeStatus !== "connected")
      throw new Error(`Native Codex Clankie server is ${String(row.runtimeStatus ?? "unverified")}`);
    if (!object(row.tools)) throw new Error("Malformed native Clankie tool catalog");
    report.tools = Object.keys(row.tools).sort();
  } catch (error) {
    report.error = (error instanceof Error ? error.message : String(error)).slice(0, 1024);
  }
  report.checkedAt = new Date().toISOString();
  return report;
}
