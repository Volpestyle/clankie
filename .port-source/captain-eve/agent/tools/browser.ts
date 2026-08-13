import { defineDynamic, defineTool, type DynamicToolEntry } from "eve/tools";
import { z } from "zod";
import { browserCatalog } from "../../lib/browser.ts";
import { controlPlaneClient } from "../../lib/client.ts";

/**
 * Clankie's browser, resolved at session start rather than hand-written
 * ([ADR 0082](../../../../docs/adr/0082-clankie-holds-the-browser.md)).
 *
 * The catalog is whatever the runner's `agent-browser` host exposes *after*
 * doctrine has projected it, so this file never enumerates commands. A new
 * agent-browser release adds tools by appearing in the catalog, and an
 * operator narrows them by editing the registry — neither needs a code change
 * here, and neither can widen his reach past the registry's closed list.
 *
 * Entry naming is version-sensitive: eve 0.24.4's types name map entries
 * `slug__key` (so `browser__navigate`), while the current published docs name
 * them by bare key. The prefix is stripped defensively rather than assumed, so
 * the call carries the right tool name under either rule.
 *
 * `session.started` is deliberate: the catalog is stable for a conversation,
 * and resolving per step would re-fetch it on every model call. Approval is
 * enforced by the control plane on the call itself rather than by eve's
 * step-scoped `approval` hook, so the gate holds on a replayed turn too.
 */
/** The slug this file contributes under, when eve namespaces map entries. */
const BROWSER_TOOL_PREFIX = "browser__";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const catalog = await browserCatalog(controlPlaneClient());
      if (!catalog.available || catalog.tools.length === 0) {
        // One honest tool beats a silently empty surface: without this he has
        // no way to distinguish "no browser" from "never thought to look".
        return {
          unavailable: defineTool({
            description:
              "Report why your browser is not reachable right now. Your browser is normally available; " +
              "if this is the only browser tool you have, say you cannot browse and why, rather than " +
              "implying you chose not to.",
            inputSchema: z.object({}),
            execute: () => ({
              available: false,
              reason: catalog.reason ?? "the browser host reported no tools",
            }),
          }),
        };
      }

      const entries: Record<string, DynamicToolEntry> = {};
      for (const tool of catalog.tools) {
        // `defineTool` is eve's prescribed way to build a resolver entry, but
        // its optional properties are declared `?: T` where `DynamicToolEntry`
        // wants `?: T | undefined`; under `exactOptionalPropertyTypes` the two
        // disagree on shape while describing the same value.
        entries[tool.name] = defineTool({
          description: tool.requiresApproval
            ? `${tool.description}\n\nThis is ${tool.riskClass}-class and needs an operator approval. ` +
              `Calling it without one comes back refused with approval_required; relay that rather than retrying.`
            : tool.description,
          // The MCP server's own JSON Schema, passed through verbatim so the
          // model sees the arguments the tool actually takes. eve accepts a
          // raw JSON Schema object here alongside Standard Schema values.
          inputSchema: tool.inputSchema as Parameters<typeof defineTool>[0]["inputSchema"],
          // The tool name comes from `ctx.toolName`, not from the loop
          // variable. eve hoists inline `execute` bodies to module scope and
          // serializes whatever they reference as `__closureVars` for replay;
          // it collects those from enclosing *functions*, and `tool` is a
          // per-iteration binding in a `for…of` block. Reading the name the
          // model actually called needs no capture at all, and keeps 33
          // descriptors out of every durable closure snapshot.
          execute: async (input: unknown, ctx: { toolName: string }) =>
            controlPlaneClient().callBrowserTool({
              schemaVersion: 1,
              tool: ctx.toolName.startsWith(BROWSER_TOOL_PREFIX)
                ? ctx.toolName.slice(BROWSER_TOOL_PREFIX.length)
                : ctx.toolName,
              arguments: (input ?? {}) as Record<string, unknown>,
            }),
        }) as DynamicToolEntry;
      }
      return entries;
    },
  },
});
