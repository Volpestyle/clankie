import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("loads the real bundled snapshot only on first catalog use in a fresh process", async () => {
  const entry = new URL("../src/index.ts", import.meta.url).href;
  const snapshot = fileURLToPath(new URL("../data/models-dev-snapshot.json", import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--input-type=module",
    "-e",
    `import { createRequire } from 'node:module';
     const require = createRequire(import.meta.url);
     const { loadBundledCatalog } = await import(${JSON.stringify(entry)});
     const before = Boolean(require.cache[${JSON.stringify(snapshot)}]);
     const catalog = loadBundledCatalog();
     console.log(JSON.stringify({ before,
       after: Boolean(require.cache[${JSON.stringify(snapshot)}]),
       memoized: catalog === loadBundledCatalog(),
       openai: Object.keys(catalog.openai.models).length > 0 }));`,
  ]);
  expect(JSON.parse(stdout)).toEqual({ before: false, after: true, memoized: true, openai: true });
});
