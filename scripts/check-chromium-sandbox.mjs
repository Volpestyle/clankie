// Fails when code launches Chromium without its sandbox (#560). Playwright passes
// --no-sandbox to Chromium unless a launch sets `chromiumSandbox: true`, so every
// `launch`, `launchServer` and `launchPersistentContext` of Playwright's Chromium
// must provably set it, and no code may pass --no-sandbox or --disable-setuid-sandbox.
//
// It parses each file with TypeScript and fails closed: it follows Chromium through
// imports (renamed, namespace, default, dynamic), aliases and destructuring, and
// refuses any use it can't follow. A launch passes only when its options are an
// object literal, or a `const` bound to one, whose last `chromiumSandbox` is the
// literal `true` with no later spread that could override it, and whose `args`, if
// any, are literal strings. Spreads may only add other keys.
// A launch that truly cannot keep the sandbox (a Linux CI runner, say) says why
// on its own line or the line above, and keeps that exception scoped:
//   // allow-no-sandbox -- this runner's kernel denies the user namespaces Chrome needs
// Usage: node scripts/check-chromium-sandbox.mjs [ROOT]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const root = resolve(process.argv[2] ?? resolve(import.meta.dirname, ".."));
const code = /\.[cm]?[jt]sx?$/u;
// This checker and its test name what it refuses; docs and evals keep history and fixtures.
const skipped = [
  /^scripts\/check-chromium-sandbox\.mjs$/u,
  /^apps\/docs\/test\/chromium-sandbox\.integration\.test\.ts$/u,
  /^docs\//u,
  /^evals\//u,
];
const playwright = /(^|\/)(?:playwright|playwright-core|@playwright\/test)(?:\/|$)/u;
const launches = new Set(["launch", "launchServer", "launchPersistentContext"]);
// Keys a spread must not carry, since they decide the sandbox.
const sandboxKeys = new Set(["chromiumSandbox", "args"]);
const unsandboxed = /--(?:no-sandbox|disable-setuid-sandbox)\b/u;
const allowed = /allow-no-sandbox\s+--\s+\S/u;

const unwrap = (node) => {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isAwaitExpression(node)
  )
    node = node.expression;
  return node;
};
const literalText = (node) =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
const keyName = (name) =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : undefined;

/** A string built only from literals with `+`, folded; undefined when any part isn't literal. */
function folded(node) {
  node = unwrap(node);
  const text = literalText(node);
  if (text !== undefined) return text;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = folded(node.left);
    const right = folded(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

function checkFile(path, source, report) {
  const kind = /\.[cm]?tsx?$/u.test(path)
    ? path.endsWith("x")
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS
    : path.endsWith("x")
      ? ts.ScriptKind.JSX
      : ts.ScriptKind.JS;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
  const lines = source.split("\n");
  const fail = (node, message) => {
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line;
    if (allowed.test(lines[line] ?? "") || allowed.test(lines[line - 1] ?? "")) return;
    report(`${path}:${line + 1}: ${message}`);
  };

  // Names bound to a Playwright module, and names bound to its Chromium.
  const modules = new Set();
  const chromiums = new Set();
  const isModuleLoad = (node) => {
    node = unwrap(node);
    return (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      playwright.test(literalText(node.arguments[0]) ?? "")
    );
  };
  const isModule = (node) => {
    node = unwrap(node);
    return (ts.isIdentifier(node) && modules.has(node.text)) || isModuleLoad(node);
  };
  const isChromium = (node) => {
    node = unwrap(node);
    if (ts.isIdentifier(node)) return chromiums.has(node.text) && !declares(node);
    if (ts.isPropertyAccessExpression(node))
      return node.name.text === "chromium" && isModule(node.expression);
    if (ts.isElementAccessExpression(node)) return isModule(node.expression);
    return false;
  };
  // An identifier that names a declaration or a property, not a use of a binding.
  const declares = (node) => {
    const parent = node.parent;
    return (
      (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
      ((ts.isImportSpecifier(parent) || ts.isBindingElement(parent)) &&
        (parent.name === node || parent.propertyName === node)) ||
      (ts.isVariableDeclaration(parent) && parent.name === node) ||
      (ts.isPropertyAssignment(parent) && parent.name === node) ||
      ts.isImportClause(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isQualifiedName(parent)
    );
  };
  const bindPattern = (pattern) => {
    for (const element of pattern.elements) {
      const from = element.propertyName ? keyName(element.propertyName) : keyName(element.name);
      if (from === "chromium" && ts.isIdentifier(element.name)) chromiums.add(element.name.text);
    }
  };
  const collect = (node) => {
    if (ts.isImportDeclaration(node) && playwright.test(literalText(node.moduleSpecifier) ?? "")) {
      const clause = node.importClause;
      if (clause?.name) modules.add(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) modules.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings))
        for (const element of bindings.elements)
          if ((element.propertyName ?? element.name).text === "chromium") chromiums.add(element.name.text);
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const value = node.initializer;
      if (isModule(value)) {
        if (ts.isIdentifier(node.name)) modules.add(node.name.text);
        else if (ts.isObjectBindingPattern(node.name)) bindPattern(node.name);
      } else if (isChromium(value) && ts.isIdentifier(node.name)) chromiums.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  // Twice, so an alias declared before what it aliases is still followed.
  collect(file);
  collect(file);

  const constObject = (identifier) => {
    let found;
    const visit = (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === identifier.text &&
        node.initializer &&
        ts.isVariableDeclarationList(node.parent) &&
        node.parent.flags & ts.NodeFlags.Const
      )
        found = found === undefined ? unwrap(node.initializer) : null;
      ts.forEachChild(node, visit);
    };
    visit(file);
    return found && ts.isObjectLiteralExpression(found) ? found : undefined;
  };

  // Every object a spread can add: literals, either branch of a conditional.
  const spreadObjects = (node) => {
    node = unwrap(node);
    if (ts.isObjectLiteralExpression(node)) return [node];
    if (ts.isConditionalExpression(node)) {
      const branches = [spreadObjects(node.whenTrue), spreadObjects(node.whenFalse)];
      return branches.includes(undefined) ? undefined : branches.flat();
    }
    if (ts.isIdentifier(node)) {
      const bound = constObject(node);
      return bound ? [bound] : undefined;
    }
    return undefined;
  };
  // True when a spread can't carry a key that decides the sandbox.
  const harmless = (node) =>
    spreadObjects(node)?.every((object) =>
      object.properties.every((property) =>
        ts.isSpreadAssignment(property)
          ? harmless(property.expression)
          : property.name !== undefined &&
            keyName(property.name) !== undefined &&
            !sandboxKeys.has(keyName(property.name)),
      ),
    ) ?? false;

  const checkOptions = (call, method) => {
    const given = call.arguments[method === "launchPersistentContext" ? 1 : 0];
    let options = given && unwrap(given);
    if (options && ts.isIdentifier(options)) options = constObject(options);
    if (!options || !ts.isObjectLiteralExpression(options))
      return fail(call, `chromium.${method} options aren't an object literal the check can read`);
    let sandboxed = false;
    for (const property of options.properties) {
      if (ts.isSpreadAssignment(property)) {
        if (!harmless(property.expression))
          return fail(property, `chromium.${method} spreads options that could change the sandbox`);
        continue;
      }
      const name = property.name && keyName(property.name);
      if (name === undefined)
        return fail(property, `chromium.${method} has an option key the check can't read`);
      if (name === "chromiumSandbox") {
        sandboxed =
          ts.isPropertyAssignment(property) &&
          unwrap(property.initializer).kind === ts.SyntaxKind.TrueKeyword;
        if (!sandboxed)
          return fail(property, `chromium.${method} sets chromiumSandbox to something but true`);
      }
      if (name === "args") {
        const list = ts.isPropertyAssignment(property) ? unwrap(property.initializer) : undefined;
        if (!list || !ts.isArrayLiteralExpression(list))
          return fail(property, `chromium.${method} args aren't a literal list`);
        for (const element of list.elements)
          if (literalText(element) === undefined)
            return fail(element, `chromium.${method} args has an entry that isn't a literal string`);
      }
    }
    if (!sandboxed) fail(call, `chromium.${method} without chromiumSandbox: true`);
  };

  const inType = (node) => {
    for (let at = node.parent; at; at = at.parent) if (ts.isTypeNode(at)) return true;
    return false;
  };
  const visit = (node) => {
    const flag = (text) => text !== undefined && unsandboxed.test(text);
    if (literalText(node) !== undefined && flag(literalText(node)))
      fail(node, `passes a sandbox-disabling flag: ${literalText(node)}`);
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      !(ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken) &&
      flag(folded(node))
    )
      fail(node, `passes a sandbox-disabling flag: ${folded(node)}`);
    if (ts.isTemplateExpression(node) && flag(node.getText(file)))
      fail(node, "passes a sandbox-disabling flag in a template");

    if (ts.isExpression(node) && isChromium(node) && !inType(node)) {
      const parent = node.parent;
      const member = ts.isPropertyAccessExpression(parent)
        ? parent.name.text
        : ts.isElementAccessExpression(parent)
          ? literalText(parent.argumentExpression)
          : undefined;
      const accessed =
        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
        parent.expression === node;
      if (accessed && member !== undefined) {
        if (launches.has(member)) {
          if (ts.isCallExpression(parent.parent) && parent.parent.expression === parent)
            checkOptions(parent.parent, member);
          else fail(parent, `chromium.${member} is used in a way the check can't follow`);
        }
      } else if (
        !(ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isIdentifier(parent.name))
      )
        // An alias is followed; anything else (a computed member, an argument, a property) is not.
        fail(node, "Chromium is used in a way the check can't follow");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
}

const failures = [];
const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
})
  .split("\0")
  .filter((path) => path && code.test(path) && !skipped.some((rule) => rule.test(path)));
for (const path of files) {
  let source;
  try {
    source = readFileSync(resolve(root, path), "utf8");
  } catch {
    continue; // Deleted in the working tree but still in the index.
  }
  if (!/chromium|sandbox/u.test(source)) continue;
  checkFile(path, source, (line) => failures.push(line));
}
if (failures.length) {
  process.stderr.write(
    [
      "Chromium launched without its sandbox, or launched where the check can't prove it.",
      "Playwright adds --no-sandbox unless a launch sets `chromiumSandbox: true`. Set it as a literal",
      "in the launch's options, or explain a scoped exception with `// allow-no-sandbox -- why`.",
      ...failures,
      "",
    ].join("\n"),
  );
  process.exit(1);
}
console.log(`chromium sandbox: ${files.length} files checked`);
