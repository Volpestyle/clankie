import type { ClankieApiClient } from "@clankie/api-client";
import { BrowserToolCatalogSchema, type BrowserToolCatalog } from "@clankie/protocol";

/**
 * The captain's read of his own browser catalog
 * ([ADR 0082](../../../docs/adr/0082-clankie-holds-the-browser.md)).
 *
 * A control plane that is down, a runner without the `agent-browser` binary,
 * and a doctrine profile that denies every browser action all arrive here as
 * the same shape: `available: false` with a reason. They are deliberately not
 * thrown, because this runs inside `session.started` — a throw there would
 * fail the whole session over a missing browser, which is the one outcome
 * worse than having no browser.
 */
export async function browserCatalog(client: ClankieApiClient): Promise<BrowserToolCatalog> {
  try {
    return await client.listBrowserTools();
  } catch (error) {
    return BrowserToolCatalogSchema.parse({
      schemaVersion: 1,
      available: false,
      reason: error instanceof Error ? error.message.slice(0, 200) : "browser_catalog_unreachable",
      tools: [],
    });
  }
}
