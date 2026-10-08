import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

/** A native Pi consumer, never a tool authority or an operator bridge. */
export function createPiWorkerFleet(pi, options = {}) {
  const client = new Client({ name: "clankie-pi-worker", version: "1" });
  const registered = new Set();
  const enabled = new Set();
  let catalog = new Map();
  let context;
  let identity;
  let closed = false;
  let ready;
  let connected = false;
  let refresh = Promise.resolve();
  const identityOf = (ctx) =>
    JSON.stringify([
      ctx.cwd,
      ctx.sessionManager.getSessionId(),
      ctx.sessionManager.getSessionDir(),
      ctx.sessionManager.getSessionFile(),
    ]);
  const current = (ctx) => !closed && ctx?.mode === "tui" && identityOf(ctx) === identity;
  const deactivate = () => {
    if (context) pi.setActiveTools(pi.getActiveTools().filter((name) => !registered.has(name)));
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    catalog.clear();
    try {
      deactivate();
    } catch {
      /* A retired Pi runtime cannot be edited. */
    }
    await client.close().catch(() => {});
  };
  const unavailable = () => new Error("Native fleet tools unavailable; no call was sent");
  const synchronize = async () => {
    if (!current(context)) return;
    const next = new Map();
    const cursors = new Set();
    let cursor;
    do {
      const page = await client.listTools(cursor === undefined ? {} : { cursor }, { timeout: 30_000 });
      for (const tool of page.tools) {
        if (next.has(tool.name) || next.size >= 256) throw unavailable();
        if (!registered.has(tool.name) && pi.getAllTools().some((existing) => existing.name === tool.name))
          throw unavailable();
        next.set(tool.name, tool);
      }
      cursor = page.nextCursor;
      if (cursor !== undefined && cursors.has(cursor)) throw unavailable();
      cursors.add(cursor);
    } while (cursor !== undefined);
    if (!current(context)) return;
    const observed = new Set(pi.getActiveTools());
    // Remember native owner choices only while a tool is advertised. Temporary
    // server withdrawal must not be confused with an owner disabling the tool.
    for (const name of catalog.keys()) {
      if (observed.has(name)) enabled.add(name);
      else enabled.delete(name);
    }
    const active = [...observed].filter((name) => !registered.has(name));
    // Invalidate old definitions before any registration. A held reference must
    // never call a tool withdrawn from the server's current catalog.
    catalog = next;
    for (const tool of next.values()) {
      const first = !registered.has(tool.name);
      registered.add(tool.name);
      pi.registerTool({
        name: tool.name,
        label: tool.title ?? tool.name,
        description: tool.description ?? "",
        parameters: tool.inputSchema,
        ...(client.getInstructions() ? { promptGuidelines: [client.getInstructions()] } : {}),
        async execute(_id, args, signal, _update, ctx) {
          if (!current(ctx) || ctx.isProjectTrusted() !== true || catalog.get(tool.name) !== tool)
            throw unavailable();
          signal?.throwIfAborted();
          await options.beforeCall?.();
          signal?.throwIfAborted();
          if (!current(ctx) || ctx.isProjectTrusted() !== true || catalog.get(tool.name) !== tool)
            throw unavailable();
          let result;
          try {
            // One standard MCP invocation. Cancellation or a missing reply
            // never authorizes another invocation or replacement process.
            result = await client.callTool({ name: tool.name, arguments: args }, undefined, {
              signal,
              timeout: 30_000,
            });
          } catch {
            throw new Error("Fleet MCP call returned no result; it may have applied. Do not repeat it.");
          }
          const structured =
            result.structuredContent === undefined
              ? []
              : [{ type: "text", text: JSON.stringify(result.structuredContent) }];
          return {
            content: [
              ...result.content.map((block) =>
                block.type === "text" || block.type === "image"
                  ? block
                  : { type: "text", text: JSON.stringify(block) },
              ),
              ...structured,
            ],
            details: { mcp: result },
          };
        },
      });
      if (first) enabled.add(tool.name);
      if (enabled.has(tool.name)) active.push(tool.name);
    }
    pi.setActiveTools(active);
  };
  const refreshCatalog = () => {
    refresh = refresh.then(synchronize).catch(close);
    return refresh;
  };
  client.onclose = () => {
    void close();
  };
  client.setNotificationHandler(ToolListChangedNotificationSchema, () =>
    connected ? refreshCatalog() : undefined,
  );
  pi.on("session_start", (event, ctx) => {
    if (context || event.reason !== "startup" || ctx.mode !== "tui") {
      void close();
      return;
    }
    context = ctx;
    identity = identityOf(ctx);
    const env = getDefaultEnvironment();
    for (const key of ["HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HERDR_ENV", "CLANKIE_STATE"])
      if (process.env[key] !== undefined) env[key] = process.env[key];
    const transport =
      options.transport ??
      new StdioClientTransport({
        command: process.env.CLANKIE_LAUNCHER_PATH ?? "clankie",
        args: ["mcp", "--fleet"],
        env,
        cwd: ctx.cwd,
        stderr: "ignore",
      });
    ready = client
      .connect(transport)
      .then(() => {
        connected = true;
        return refreshCatalog();
      })
      .catch(close);
    return ready;
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    if (!current(ctx)) {
      await close();
      return;
    }
    await ready;
  });
  pi.on("tool_result", (event) => {
    // Pi 0.87.1 marks a returned tool value successful by default. Its native
    // result hook carries MCP's error flag without throwing away the receipt.
    if (registered.has(event.toolName) && event.details?.mcp)
      return { isError: event.details.mcp.isError === true };
  });
  for (const event of [
    "session_before_switch",
    "session_before_fork",
    "session_before_tree",
    "session_shutdown",
  ])
    pi.on(event, close);
  return { close };
}
