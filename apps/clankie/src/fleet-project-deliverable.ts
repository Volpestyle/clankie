import type { McpHost } from "./mcp-host.ts";

/** Display-only tracker provenance. Coalesced, bounded reads through the verified connection. */
export function createDeliverableProjectReader(host: Pick<McpHost, "call">) {
  const reads = new Map<string, { expires: number; result: Promise<string | undefined> }>();
  let active = 0;
  return async (deliverable: string): Promise<string | undefined> => {
    const keys = [...new Set(deliverable.match(/\b[A-Z][A-Z0-9]*-\d+\b/gu) ?? [])];
    const key =
      keys.length === 1
        ? keys[0]
        : /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(deliverable)
          ? deliverable.toLowerCase()
          : undefined;
    if (!key) return undefined;
    const now = Date.now();
    for (const [id, read] of reads) if (read.expires <= now) reads.delete(id);
    const existing = reads.get(key);
    if (existing) return existing.result;
    if (active >= 2 || reads.size >= 128) return undefined;
    active++;
    const read = { expires: Infinity, result: Promise.resolve(undefined as string | undefined) };
    read.result = (async () => {
      try {
        const result = await host.call({
          lane: "operator",
          server: "linear",
          tool: "get_issue",
          arguments: { id: key },
          resultMode: "data",
          requestPriority: "background",
          timeoutMs: 1_000,
        });
        if (result.outcome !== "ok" || result.isError) return undefined;
        const issue = JSON.parse(result.content) as {
          id?: unknown;
          uuid?: unknown;
          identifier?: unknown;
          projectId?: unknown;
          project?: { id?: unknown };
        };
        if (
          ![issue.id, issue.uuid, issue.identifier].some(
            (id) => typeof id === "string" && id.toLowerCase() === key.toLowerCase(),
          )
        )
          return undefined;
        const projectId = issue.projectId ?? issue.project?.id;
        return typeof projectId === "string" &&
          /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(projectId)
          ? projectId.toLowerCase()
          : undefined;
      } catch {
        return undefined;
      } finally {
        active--;
        read.expires = Date.now() + 60_000;
      }
    })();
    reads.set(key, read);
    return read.result;
  };
}
