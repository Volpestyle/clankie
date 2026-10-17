/**
 * Lets a checkout's services run their TypeScript under plain Node (VUH-2393).
 * Node strips types from the workspace's own `.ts` files but refuses inside
 * `node_modules`, where a dependency such as `@pokeagents/world-protocol`
 * publishes TypeScript sources. This load hook strips those few the same way,
 * in-process; it replaced the tsx wrapper and its esbuild child. Installed
 * releases run compiled bundles and never load it.
 */
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith("file:") || !url.includes("/node_modules/") || !/\.[cm]?ts$/u.test(url))
      return nextLoad(url, context);
    const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), {
      mode: "strip",
      sourceUrl: url,
    });
    return { format: url.endsWith(".cts") ? "commonjs" : "module", source, shortCircuit: true };
  },
});
