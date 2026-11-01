// Loads body-transfer.ts on its own: stubs the two imports that only locate
// directories, and finds zod/hono in REPLAY_DEPS when the workspace has no install.
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const stub = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
export async function resolve(specifier, context, next) {
  if (specifier === "@clankie/settings" && context.parentURL?.endsWith("/apps/clankie/src/body-transfer.ts"))
    return { url: stub("export const discordAttachmentRoot = (env) => env.REPLAY_ATTACHMENTS ?? '/nonexistent-replay-attachments';"), shortCircuit: true };
  if (specifier === "./memory.ts" && context.parentURL?.endsWith("/body-transfer.ts"))
    return { url: stub("export const defaultMemoryDir = (env) => env.REPLAY_MEMORY ?? '/nonexistent-replay-memory';"), shortCircuit: true };
  if (specifier === "@clankie/protocol/body-transfer")
    return { url: new URL("../../../packages/protocol/src/body-transfer.ts", import.meta.url).href, shortCircuit: true };
  try {
    return await next(specifier, context);
  } catch (error) {
    if (!process.env.REPLAY_DEPS || !["zod", "hono"].includes(specifier)) throw error;
    const parentURL = pathToFileURL(join(process.env.REPLAY_DEPS, "package.json")).href;
    return next(specifier, { ...context, parentURL });
  }
}
