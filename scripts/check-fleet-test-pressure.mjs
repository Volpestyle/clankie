// Admission fixtures must control memory/load; native observers remain real.
import { glob, readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import ts from "typescript";

const root = resolve(process.argv[2] ?? resolve(import.meta.dirname, ".."));
const failures = [];
let governors = 0;
let files = 0;
const ambientNames = new Set([
  "ResourcePressureSampler",
  "darwinAvailableMemoryMb",
  "loadavg",
  "freemem",
  "cpus",
]);

const nativeObserverCases = new Set([
  "packages/fleet-resources/test/heavy-admission.integration.test.ts:the real sampler reports busy cores the kernel counts",
  "packages/fleet-resources/test/probe-failure.integration.test.ts:proves real helper availability with a fixture caller PID 1 without authorizing PID 1",
]);

function check(path, source, location = path, nativeChild = false) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const declarations = new Map();
  const importedNames = new Map();
  function index(node) {
    if (
      (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      const entries = declarations.get(node.name.text) ?? [];
      entries.push(node);
      declarations.set(node.name.text, entries);
    }
    if (ts.isImportSpecifier(node)) importedNames.set(node.name.text, (node.propertyName ?? node.name).text);
    ts.forEachChild(node, index);
  }
  index(file);
  function nativeScope(node) {
    if (nativeChild || path.endsWith("/darwin-pressure.integration.test.ts")) return true;
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (
        ts.isCallExpression(parent) &&
        parent.arguments[0] &&
        ts.isStringLiteralLike(parent.arguments[0]) &&
        nativeObserverCases.has(`${path}:${parent.arguments[0].text}`)
      )
        return true;
    }
    return false;
  }
  // Resolve only lexically visible local values. Unknown options fail closed;
  // this is a fixture convention, not an arbitrary JS/dataflow analyzer.
  function declaration(node) {
    const entries = declarations.get(node.text) ?? [];
    for (let scope = node.parent; scope; scope = scope.parent) {
      const found = entries.find((entry) => {
        let owner = entry.parent;
        while (owner && !ts.isBlock(owner) && !ts.isSourceFile(owner)) owner = owner.parent;
        return owner === scope;
      });
      if (found) return found;
    }
  }
  function value(node, seen = new Set()) {
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node))
      return value(node.expression, seen);
    if (ts.isIdentifier(node)) {
      const local = declaration(node);
      return local && ts.isFunctionDeclaration(local) ? local : value(local?.initializer, seen);
    }
    return node;
  }
  function name(node, seen = new Set()) {
    if (!node || seen.has(node)) return "";
    seen.add(node);
    if (ts.isIdentifier(node)) {
      const imported = importedNames.get(node.text);
      if (imported) return imported;
      const local = declaration(node)?.initializer;
      if (local) return name(local, seen);
    }
    return node.getText(file).split(".").at(-1);
  }
  function probe(node) {
    const object = value(node);
    if (!object || !ts.isObjectLiteralExpression(object)) return;
    let result;
    for (const property of object.properties) {
      if (ts.isSpreadAssignment(property)) {
        const inherited = probe(property.expression);
        if (!inherited) return; // A later dynamic spread could erase the probe.
        result = inherited;
      } else if (property.name?.getText(file).replaceAll('"', "").replaceAll("'", "") === "probe") {
        result = ts.isShorthandPropertyAssignment(property)
          ? value(property.name)
          : ts.isMethodDeclaration(property)
            ? property
            : value(property.initializer);
      }
    }
    return result;
  }
  function ambient(node, seen = new Set()) {
    if (!node || seen.has(node)) return false;
    seen.add(node);
    if (ts.isIdentifier(node)) {
      if (ambientNames.has(importedNames.get(node.text) ?? node.text)) return true;
      const local = declaration(node);
      if (local && ambient(local.initializer ?? local.body, seen)) return true;
    }
    if (
      ts.isStringLiteralLike(node) &&
      /\/proc\/(?:meminfo|loadavg)|memory_pressure|MemAvailable/u.test(node.text)
    )
      return true;
    let found = false;
    ts.forEachChild(node, (child) => {
      found ||= ambient(child, seen);
    });
    return found;
  }
  function visit(node) {
    // Also reject host reads outside the named observer cases, so passing a
    // measured value through a helper parameter cannot conceal its source.
    if (
      !nativeScope(node) &&
      (((ts.isCallExpression(node) || ts.isNewExpression(node)) && ambientNames.has(name(node.expression))) ||
        (ts.isStringLiteralLike(node) && /^\/proc\/(?:meminfo|loadavg)$/u.test(node.text)))
    ) {
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      failures.push(
        `${location}:${line}: ambient pressure read belongs in a native-observer test, not an admission fixture`,
      );
    }
    if (ts.isCallExpression(node) && name(node.expression) === "createResourceGovernor") {
      governors++;
      const input = probe(node.arguments[0]);
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      if (
        !input ||
        !(
          ts.isArrowFunction(input) ||
          ts.isFunctionExpression(input) ||
          ts.isFunctionDeclaration(input) ||
          ts.isMethodDeclaration(input)
        )
      ) {
        failures.push(
          `${location}:${line}: admission fixture must supply an explicit controlled pressure probe`,
        );
      } else if (!path.endsWith("/darwin-pressure.integration.test.ts") && ambient(input)) {
        failures.push(
          `${location}:${line}: admission probe reads ambient host memory/load; use controlled pressure`,
        );
      }
    }
    // The real subprocess fixtures include inline JS as well as .mjs drivers.
    if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const text = ts.isNoSubstitutionTemplateLiteral(node)
        ? node.text
        : node.head.text +
          node.templateSpans.map((span) => '"__fixture_interpolation__"' + span.literal.text).join("");
      if (/createResourceGovernor|ResourcePressureSampler/u.test(text))
        check(path, text, `${location} (inline child)`, nativeScope(node));
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
}

for await (const path of glob("packages/fleet-resources/test/**/*.{ts,mjs}", { cwd: root })) {
  files++;
  check(path, await readFile(resolve(root, path), "utf8"));
}
if (!files || !governors)
  failures.push(`No fleet-resource admission fixtures found under ${relative(process.cwd(), root)}`);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Fleet pressure policy: ${governors} governor constructions in ${files} files have explicit probes; native Darwin observer retained.`,
  );
}
