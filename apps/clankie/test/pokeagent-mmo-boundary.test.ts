import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");
const productRoots = ["apps", "integrations", "packages"] as const;
/**
 * `world-protocol` is the one package that crosses from the world's repo, as a
 * pinned git dependency carrying the client transport on its `/ipc` subpath —
 * PokeAgent MMO ADR 0008. Clankie is a player in that world, not its owner
 * (ADR 0001), so the contract is allowed and the client and host are not.
 */
const allowedDependencies = new Set([
  "@pokeagent-mmo/firered",
  "@pokeagent-mmo/world-mcp",
  "@pokeagents/world-protocol",
]);
const allowedSourceImports = new Set(["@pokeagent-mmo/firered", "@pokeagents/world-protocol"]);
const skippedDirectories = new Set(["coverage", "dist", "node_modules", "test"]);

interface PackageManifest {
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

function workspacePackages(): readonly string[] {
  return productRoots.flatMap((root) =>
    readdirSync(join(repoRoot, root), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(repoRoot, root, entry.name, "package.json")))
      .map((entry) => join(repoRoot, root, entry.name)),
  );
}

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:[cm]?[jt]sx?)$/u.test(entry.name) ? [path] : [];
  });
}

function packageName(specifier: string): string {
  return specifier.split("/").slice(0, 2).join("/");
}

function importedSpecifiers(source: string): readonly string[] {
  return [...source.matchAll(/(?:from\s+|import\s*(?:\(\s*)?|require\(\s*)["']([^"']+)["']/gu)].map(
    (match) => match[1]!,
  );
}

describe("PokeAgent MMO is an external MCP world", () => {
  it("depends only on the packaged MCP server or transport-free FireRed knowledge", () => {
    const violations: string[] = [];
    for (const packageRoot of workspacePackages()) {
      const path = join(packageRoot, "package.json");
      const manifest = JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
      const dependencies = {
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies,
      };
      for (const dependency of Object.keys(dependencies)) {
        if (dependency.startsWith("@pokeagent-mmo/") && !allowedDependencies.has(dependency)) {
          violations.push(`${manifest.name} depends on ${dependency}`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("does not import the MMO client or host into Clankie", () => {
    const violations: string[] = [];
    for (const packageRoot of workspacePackages()) {
      for (const file of sourceFiles(packageRoot)) {
        const source = readFileSync(file, "utf8");
        for (const specifier of importedSpecifiers(source)) {
          if (specifier.startsWith("@pokeagent-mmo/") && !allowedSourceImports.has(packageName(specifier))) {
            violations.push(`${relative(repoRoot, file)} imports ${specifier}`);
          }
        }
        if (source.includes("../pokeagent-mmo") || source.includes("/dev/pokeagent-mmo/")) {
          violations.push(`${relative(repoRoot, file)} reaches into a PokeAgent MMO checkout`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("does not implement the world socket protocol", () => {
    const violations: string[] = [];
    for (const packageRoot of workspacePackages()) {
      for (const file of sourceFiles(packageRoot)) {
        const source = readFileSync(file, "utf8");
        const namesWorldTransport =
          /\b(?:HostRequest|WORLD_SOCKET|callHost|worldSocketPath)\b|host\.sock/u.test(source);
        const opensSocket = /["']node:net["']|\bcreateConnection\s*\(/u.test(source);
        if (namesWorldTransport && opensSocket) {
          violations.push(`${relative(repoRoot, file)} opens the PokeAgent MMO socket directly`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});
