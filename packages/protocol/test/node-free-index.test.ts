import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The React Native client (clankie-app) bundles `@clankie/protocol`'s index with
// Metro, which has no node built-ins. A `node:` import anywhere in the index's
// relative import graph breaks the App Store archive, so this walks that graph.
const SPECIFIER = /\bfrom\s+"([^"]+)"|\bimport\s+"([^"]+)"/gu;

function specifiers(file: string): string[] {
  return [...readFileSync(file, "utf8").matchAll(SPECIFIER)].map((match) => match[1] ?? match[2] ?? "");
}

function importGraph(entry: string): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const pending = [entry];
  for (let file = pending.shift(); file !== undefined; file = pending.shift()) {
    if (graph.has(file)) continue;
    const imports = specifiers(file);
    graph.set(file, imports);
    for (const specifier of imports) {
      if (specifier.startsWith(".")) pending.push(resolve(dirname(file), specifier));
    }
  }
  return graph;
}

describe("protocol index stays node-free", () => {
  it("imports no node built-in anywhere in the index's relative import graph", () => {
    const builtins = new Set(builtinModules);
    const offenders: string[] = [];
    for (const [file, imports] of importGraph(resolve(import.meta.dirname, "../src/index.ts"))) {
      for (const specifier of imports) {
        if (specifier.startsWith("node:") || builtins.has(specifier))
          offenders.push(`${file} -> ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
