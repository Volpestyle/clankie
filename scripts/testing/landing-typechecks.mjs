import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

const text = (root, args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const paths = (root, args) => text(root, args).split("\0").filter(Boolean);

/** Compiler inputs, including type-only and relative imports across workspace boundaries. */
export function landingTypechecks(root, base) {
  const changed = new Set([
    ...paths(root, ["diff", "--name-only", "-z", base]),
    ...paths(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const projects = [];
  for (const group of ["apps", "integrations", "packages"]) {
    for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = `${group}/${entry.name}`;
      const manifestPath = join(root, directory, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (!manifest.scripts?.typecheck) continue;
      const config = join(root, directory, "tsconfig.json");
      let parsed;
      if (existsSync(config)) {
        parsed = ts.getParsedCommandLineOfConfigFile(
          config,
          {},
          {
            ...ts.sys,
            onUnRecoverableConfigFileDiagnostic: (error) => {
              throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
            },
          },
        );
        if (!parsed || parsed.errors.length) throw new Error(`Cannot read compiler inputs: ${config}`);
      }
      projects.push({ name: manifest.name, directory, parsed });
    }
  }
  const all = projects.map((project) => project.name).sort();
  let allReason;
  // Compiler/installation settings can change resolution even without a source edit.
  if (
    [...changed].some((path) =>
      /^(?:tsconfig[^/]*\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json)$/u.test(path),
    )
  )
    allReason = "compiler or dependency configuration";
  if (changed.has("package.json")) {
    const current = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const previous = JSON.parse(text(root, ["show", `${base}:package.json`]));
    if (
      ["dependencies", "devDependencies", "optionalDependencies", "engines", "packageManager"].some(
        (key) => JSON.stringify(current[key]) !== JSON.stringify(previous[key]),
      )
    )
      allReason = "root dependency configuration";
  }

  const consumers = new Map();
  const owners = new Map();
  const selected = new Set(allReason ? all : []);
  const importInfo = new Map();
  const resolutionCaches = new Map();
  const seeds = new Set([...changed].map((path) => resolve(root, path)));
  const normalize = (path) => {
    if (existsSync(path)) return realpathSync(path);
    const parent = dirname(path);
    return parent === path ? resolve(path) : join(normalize(parent), relative(parent, path));
  };
  // Resolve removed imports against their old contents so deletion cannot hide a consumer.
  const removed = new Map(
    paths(root, ["diff", "--name-only", "--diff-filter=D", "-z", base]).map((path) => [
      normalize(resolve(root, path)),
      text(root, ["show", `${base}:${path}`]),
    ]),
  );
  const host = {
    ...ts.sys,
    fileExists: (path) => ts.sys.fileExists(path) || removed.has(normalize(path)),
    readFile: (path) => ts.sys.readFile(path) ?? removed.get(normalize(path)),
  };
  const local = (path) => {
    const name = relative(root, path);
    return name !== ".." && !name.startsWith("../") && !name.includes("node_modules/");
  };
  const edge = (dependency, consumer) => {
    let entries = consumers.get(dependency);
    if (!entries) consumers.set(dependency, (entries = new Set()));
    entries.add(consumer);
  };
  let modules = 0;
  for (const project of projects) {
    const prefix = `${project.directory}/`;
    const metadataChanged = [...changed].some(
      (path) =>
        path === `${prefix}package.json` ||
        (path.startsWith(prefix) && /(?:^|\/)tsconfig[^/]*\.json$/u.test(path)),
    );
    if (!project.parsed) {
      if ([...changed].some((path) => path.startsWith(prefix) && !path.endsWith(".md")))
        selected.add(project.name);
      continue;
    }
    const optionsKey = JSON.stringify({ ...project.parsed.options, configFilePath: undefined });
    let cache = resolutionCaches.get(optionsKey);
    if (!cache) {
      cache = ts.createModuleResolutionCache(root, (path) => path, project.parsed.options);
      resolutionCaches.set(optionsKey, cache);
    }
    const visited = new Set();
    const pending = [
      ...project.parsed.fileNames,
      ...[...removed.keys()].filter(
        (file) =>
          file.startsWith(resolve(root, project.directory) + "/") && /\.(?:[cm]?tsx?|jsx?)$/u.test(file),
      ),
    ];
    while (pending.length) {
      const file = normalize(pending.pop());
      if (!local(file) || !host.fileExists(file) || visited.has(file)) continue;
      visited.add(file);
      let fileOwners = owners.get(file);
      if (!fileOwners) owners.set(file, (fileOwners = new Set()));
      fileOwners.add(project.name);
      if (metadataChanged) seeds.add(file);
      let info = importInfo.get(file);
      if (!info) {
        info = ts.preProcessFile(host.readFile(file), true, true);
        importInfo.set(file, info);
      }
      modules++;
      const mode = ts.getImpliedNodeFormatForFile(
        file,
        cache.getPackageJsonInfoCache(),
        host,
        project.parsed.options,
      );
      for (const imported of info.importedFiles) {
        let dependency = ts.resolveModuleName(
          imported.fileName,
          file,
          project.parsed.options,
          host,
          cache,
          undefined,
          mode,
        ).resolvedModule?.resolvedFileName;
        // Retain consumers of a deleted relative module, which resolution can no longer find.
        if (!dependency && imported.fileName.startsWith(".")) {
          const candidate = resolve(dirname(file), imported.fileName);
          dependency = [candidate, candidate.replace(/\.js$/u, ".ts"), `${candidate}.ts`].find((path) =>
            seeds.has(path),
          );
        }
        if (!dependency) continue;
        dependency = normalize(dependency);
        if (!local(dependency)) continue;
        edge(dependency, file);
        pending.push(dependency);
      }
      for (const referenced of info.referencedFiles) {
        const dependency = normalize(resolve(dirname(file), referenced.fileName));
        if (!local(dependency)) continue;
        edge(dependency, file);
        pending.push(dependency);
      }
    }
  }
  const pending = [...seeds];
  const affected = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (affected.has(file)) continue;
    affected.add(file);
    for (const owner of owners.get(file) ?? []) selected.add(owner);
    for (const consumer of consumers.get(file) ?? []) pending.push(consumer);
  }
  const cacheInputs = [
    ...new Set([
      ...[...owners]
        .filter(([, fileOwners]) => [...fileOwners].some((name) => selected.has(name)))
        .map(([file]) => relative(root, file)),
      ...projects
        .filter((project) => selected.has(project.name))
        .flatMap((project) => [`${project.directory}/package.json`, `${project.directory}/tsconfig.json`]),
      ...readdirSync(root).filter((file) => /^tsconfig[^/]*\.json$/u.test(file)),
    ]),
  ]
    .filter((file) => existsSync(resolve(root, file)))
    .sort();
  const hash = createHash("sha256");
  for (const file of cacheInputs)
    hash
      .update(file)
      .update("\0")
      .update(readFileSync(resolve(root, file)))
      .update("\0");
  return {
    packages: [...selected].sort(),
    total: all.length,
    changed: [...changed].sort(),
    modules,
    reason: allReason ?? "real compiler import graph",
    // Turbo's manifest task dependencies omit relative imports across packages.
    // Include the actual compiler inputs in its cache key as well as its task scope.
    cacheInputs,
    inputHash: hash.digest("hex"),
  };
}
