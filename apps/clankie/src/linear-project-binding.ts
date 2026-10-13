import type { McpHost } from "./mcp-host.ts";

/** Validate through the selected verified Linear connection, never the local fallback. */
export async function linearProjectExists(
  host: Pick<McpHost, "account" | "call">,
  id: string,
): Promise<boolean> {
  const before = await host.account("linear", "operator");
  const result = await host.call({
    lane: "operator",
    server: "linear",
    tool: "get_project",
    arguments: { query: id },
    resultMode: "data",
  });
  const after = await host.account("linear", "operator");
  if (before.binding !== after.binding) throw new Error("Linear connection changed");
  if (result.outcome !== "ok" || result.isError) throw new Error("Bound Linear project unavailable");
  const project = JSON.parse(result.content) as { id?: unknown; uuid?: unknown };
  // Remote MCP exposes a display identifier in id; the API adapter exposes the UUID.
  return (project.uuid ?? project.id) === id;
}
