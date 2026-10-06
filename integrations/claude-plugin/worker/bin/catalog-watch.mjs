import { randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";

const fingerprint = (tools, revision) =>
  JSON.stringify({ tools: [...tools].sort((a, b) => a.name.localeCompare(b.name)), revision });

/** One bounded discovery at a time; failed reads preserve the last advertised catalog. */
export function createCatalogWatcher({ list, notify, revision }) {
  let previous;
  let pending;
  let observation = 0;
  return {
    observe(tools) {
      observation += 1;
      previous = fingerprint(tools, revision?.());
    },
    check() {
      pending ??= (async () => {
        const started = observation;
        const tools = await list();
        const next = fingerprint(tools, revision?.());
        // A native tools/list may have observed a newer catalog while this
        // background read was pending. Never overwrite that observation.
        if (started !== observation) return;
        if (previous !== undefined && next !== previous) await notify();
        if (started === observation) previous = next;
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
