import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
/** Preserved proof inputs; a1ceae9d also pins the complete source/transport dependency graph. */
export async function frequencyBaseline(checkout: string, ref: "ae91cca8" | "b5b24bdb" | "a1ceae9d") {
  const saved = join(
    checkout,
    ref === "a1ceae9d"
      ? `.local/project-proof/churn/benchmark/baseline-${ref}`
      : `.local/project-proof/frequency/baseline-${ref}`,
  );
  const resolveDir = join(checkout, "apps/clankie/src");
  const outfile = join(saved, "bundle.mjs");
  await build({
    stdin: {
      contents:
        'export * from "./local-fleet-proof.ts"; export * from "./project-process-proof.ts"; export * from "./local-codex-seats.ts";' +
        (ref === "a1ceae9d"
          ? 'export { closeNativeProcessObservers } from "./native-process-transport.ts";'
          : ""),
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
          if (ref === "a1ceae9d") {
            plugin.onLoad({ filter: /\.(?:ts|mjs)$/ }, async (args) => {
              const path = relative(checkout, args.path);
              if (
                !path.startsWith("apps/clankie/src/") &&
                !path.startsWith("integrations/claude-plugin/worker/")
              )
                return;
              let contents = await readFile(join(saved, path), "utf8");
              if (path === "apps/clankie/src/local-fleet-process.ts") {
                const original = 'repoRoot = resolve(import.meta.dirname, "../../..")';
                if (contents.split(original).length !== 2)
                  throw new Error("Baseline helper resolver changed");
                contents = contents.replace(original, `repoRoot = ${JSON.stringify(saved)}`);
              }
              return { contents, resolveDir: dirname(args.path), loader: path.endsWith(".ts") ? "ts" : "js" };
            });
            return;
          }
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
      typeof import("../../../src/local-codex-seats.ts") &
      Partial<Pick<typeof import("../../../src/native-process-transport.ts"), "closeNativeProcessObservers">>
  >;
}
