import { randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";

const fingerprint = (tools) => JSON.stringify([...tools].sort((a, b) => a.name.localeCompare(b.name)));

/** One bounded discovery at a time; failed reads preserve the last advertised catalog. */
export function createCatalogWatcher({ list, notify }) {
  let previous;
  let pending;
  return {
    observe(tools) {
      previous = fingerprint(tools);
    },
    check() {
      pending ??= (async () => {
        const tools = await list();
        const next = fingerprint(tools);
        if (previous !== undefined && next !== previous) await notify();
        previous = next;
      })().finally(() => {
        pending = undefined;
      });
      return pending;
    },
  };
}

/** Optional private controller IPC for a locally hired Codex app-server. */
export async function signalCodexCatalog(path) {
  if (!path) return;
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, randomUUID(), { mode: 0o600 });
  await rename(temporary, path);
}
