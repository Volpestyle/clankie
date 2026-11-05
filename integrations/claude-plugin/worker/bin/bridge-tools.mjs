// The tools a copy of this bridge defines itself, read module by module so a
// copy missing one still names the rest (#379). Clankie forwards his own
// wrappers (clankie_tools, clankie_call) through any copy, so they are not here.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SOURCES = [
  ["seat-tools.mjs", (module) => [module.MESSAGE_TOOL, module.REPORT_LEADS_TOOL, ...module.PEER_TOOLS]],
  ["message-status.mjs", (module) => [module.MESSAGE_CLANKIE_STATUS_TOOL]],
  ["review-tools.mjs", (module) => module.REVIEW_TOOLS],
  ["evidence-push.mjs", (module) => [module.EVIDENCE_PUSH_TOOL]],
];

/** Tool names defined by the bridge in `binDirectory`; a module that will not load contributes none. */
export async function bridgeToolNames(binDirectory) {
  const names = [];
  for (const [file, tools] of SOURCES) {
    try {
      // allow-no-sandbox -- loads the worker plugin's own bin modules by path, not Playwright
      const module = await import(pathToFileURL(join(binDirectory, file)).href);
      for (const tool of tools(module)) if (typeof tool?.name === "string") names.push(tool.name);
    } catch {
      /* A copy without this module cannot serve its tools. */
    }
  }
  return [...new Set(names)].sort();
}
