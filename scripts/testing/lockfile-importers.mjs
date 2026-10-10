/**
 * Which pnpm importers (workspace package directories) resolve different
 * dependencies between two lockfiles (VUH-2044): an importer whose own entry
 * changed, or whose resolved closure reaches a changed snapshot or package.
 * Returns undefined when the lockfiles cannot be read with certainty; the
 * caller then treats the change as repository-wide.
 */
export function changedLockfileImporters(before, after) {
  const previous = parse(before);
  const current = parse(after);
  if (!previous || !current) return undefined;
  const changedKeys = new Set();
  for (const [section, keys] of [
    ["snapshots", union(previous.snapshots, current.snapshots)],
    ["packages", union(previous.packages, current.packages)],
  ]) {
    for (const key of keys) {
      if (previous[section].get(key)?.text === current[section].get(key)?.text) continue;
      if (section === "snapshots") changedKeys.add(key);
      // Package metadata (resolution, engines) is shared by all its peer variants.
      else
        for (const snapshot of union(previous.snapshots, current.snapshots))
          if (snapshot === key || snapshot.startsWith(`${key}(`)) changedKeys.add(snapshot);
    }
  }
  const changed = new Set();
  for (const importer of union(previous.importers, current.importers)) {
    const was = previous.importers.get(importer);
    const now = current.importers.get(importer);
    if (was?.text !== now?.text) {
      changed.add(importer);
      continue;
    }
    const seen = new Set();
    const pending = [...now.dependencies];
    while (pending.length) {
      const key = pending.pop();
      if (seen.has(key)) continue;
      seen.add(key);
      if (changedKeys.has(key)) {
        changed.add(importer);
        break;
      }
      const snapshot = current.snapshots.get(key);
      // An unresolvable reference means this reading is incomplete.
      if (!snapshot) return undefined;
      pending.push(...snapshot.dependencies);
    }
  }
  return changed;
}

const union = (left, right) => new Set([...left.keys(), ...right.keys()]);

/** The deterministic pnpm v9 layout: two-space section keys, fixed nesting. */
function parse(text) {
  if (text === undefined) return { importers: new Map(), snapshots: new Map(), packages: new Map() };
  if (!/^lockfileVersion: '9\.0'$/mu.test(text)) return undefined;
  const sections = { importers: new Map(), snapshots: new Map(), packages: new Map() };
  let section;
  let entry;
  let group;
  let dependency;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    if (!line.startsWith(" ")) {
      const name = /^([a-zA-Z]+):/u.exec(line)?.[1];
      section = name && name in sections ? sections[name] : undefined;
      entry = undefined;
      continue;
    }
    if (!section) continue;
    const key = /^ {2}(?! )('?)(.+?)\1:(?: \{\})?$/u.exec(line);
    if (key) {
      entry = { text: "", dependencies: [] };
      section.set(key[2], entry);
      group = undefined;
      continue;
    }
    if (!entry) return undefined;
    entry.text += `${line}\n`;
    const heading = /^ {4}([a-zA-Z]+):$/u.exec(line);
    if (heading) {
      group = heading[1];
      continue;
    }
    const resolves =
      group === "dependencies" || group === "optionalDependencies" || group === "devDependencies";
    if (!resolves) continue;
    if (section === sections.importers) {
      const name = /^ {6}('?)(.+?)\1:$/u.exec(line);
      if (name) dependency = name[2];
      const version = /^ {8}version: (.+)$/u.exec(line);
      if (version && dependency) push(entry, dependency, version[1]);
    } else {
      const pair = /^ {6}('?)(.+?)\1: (.+)$/u.exec(line);
      if (pair) push(entry, pair[2], pair[3]);
    }
  }
  return sections;
}

function push(entry, name, version) {
  const value = version.replace(/^'(.*)'$/u, "$1");
  // Workspace links are compiler imports, followed by the import graph instead.
  if (value.startsWith("link:")) return;
  // Aliases (`npm:` or `name@version`) name their target snapshot directly.
  entry.dependencies.push(/^[^\d].*@/u.test(value) ? value : `${name}@${value}`);
}
