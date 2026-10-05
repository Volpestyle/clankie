import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Compile preserved b5533700 inputs, resolving all their dependencies from the original source directory. */
export async function baselineProof(checkout: string) {
  const source = join(checkout, "apps/clankie/src");
  const saved = join(checkout, ".local/project-proof/baseline");
  const outfile = join(saved, "bundle.mjs");
  await build({
    stdin: {
      contents: await readFile(join(saved, "local-fleet-proof.ts"), "utf8"),
      resolveDir: source,
      sourcefile: "baseline-local-fleet-proof.ts",
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    banner: {
      js: 'import { createRequire as baselineRequire } from "node:module"; const require = baselineRequire(import.meta.url);',
    },
    plugins: [
      {
        name: "preserved-proof",
        setup(plugin) {
          plugin.onResolve({ filter: /^\.\/(project-process-proof|local-fleet-process)\.ts$/ }, (args) => ({
            path: args.path.slice(2),
            namespace: "preserved",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "preserved" }, async (args) => ({
            contents: await readFile(join(saved, args.path), "utf8"),
            resolveDir: source,
            loader: "ts",
          }));
        },
      },
    ],
  });
  return import(pathToFileURL(outfile).href) as Promise<typeof import("../../../src/local-fleet-proof.ts")>;
}
