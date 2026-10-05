import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
/** Exact local b5b24bdb inputs; no production imports silently substituted for their three proof modules. */
export async function frequencyBaseline(checkout: string, ref: "ae91cca8" | "b5b24bdb") {
  const saved = join(checkout, `.local/project-proof/frequency/baseline-${ref}`);
  const resolveDir = join(checkout, "apps/clankie/src");
  const outfile = join(saved, "bundle.mjs");
  await build({
    stdin: {
      contents:
        'export * from "./local-fleet-proof.ts"; export * from "./project-process-proof.ts"; export * from "./local-codex-seats.ts";',
      resolveDir,
      loader: "ts",
    },
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    banner: {
      js: 'import { createRequire as baselineRequire } from "node:module"; const require = baselineRequire(import.meta.url);',
    },
    plugins: [
      {
        name: "preserved-frequency",
        setup(plugin) {
          plugin.onResolve(
            {
              filter:
                /^\.\/(project-process-proof|local-fleet-process|local-fleet-proof|local-codex-seats)\.ts$/,
            },
            (args) => ({ path: args.path.slice(2), namespace: "preserved" }),
          );
          plugin.onLoad({ filter: /.*/, namespace: "preserved" }, async (args) => ({
            contents: await readFile(join(saved, args.path), "utf8"),
            resolveDir,
            loader: "ts",
          }));
        },
      },
    ],
  });
  return import(pathToFileURL(outfile).href) as Promise<
    typeof import("../../../src/local-fleet-proof.ts") &
      typeof import("../../../src/project-process-proof.ts") &
      typeof import("../../../src/local-codex-seats.ts")
  >;
}
