// Fails when code launches Chromium without its sandbox (#560). Playwright passes
// --no-sandbox to Chromium unless a launch sets `chromiumSandbox: true`, so every
// `launch`, `launchServer` and `launchPersistentContext` of Playwright's Chromium
// must provably set it, and no code may pass --no-sandbox or --disable-setuid-sandbox.
//
// It parses every code file with TypeScript and fails closed. It resolves nothing:
// Chromium is reached only as a binding named in a Playwright import (or the
// destructuring of an awaited literal `import()`/`require()`), or as `.chromium` on
// such a module binding (`{ default as pw }` counts as one; `pw.default` is refused). Every use of those bindings must be a plain member access;
// one passed, returned, assigned, spread, exported or accessed by a computed key is
// refused, as is every `import()`/`require()` whose specifier isn't a literal (each
// legitimate one carries its own allow comment) and any re-export of Playwright. A launch passes only with an inline object literal whose
// `chromiumSandbox` is the literal `true`, whose spreads are inline literals that
// can't carry `chromiumSandbox` or `args`, and whose `args` are literal strings.
// A Playwright launch is never excused. Only a load the check can't name, or a
// sandbox flag outside any Playwright launch (a raw Chrome spawn, say), may be,
// by a real comment giving the reason, on its own line directly before that one
// statement or trailing it:
//   // allow-no-sandbox -- loads this checkout's own module by path, not Playwright
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
const sandboxKeys = new Set(["chromiumSandbox", "args"]);
const unsandboxed = /--(?:no-sandbox|disable-setuid-sandbox)\b/u;
const allowed = /allow-no-sandbox\s+--\s+\S/u;

const unwrap = (node) => {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node)
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

/** `import(x)` or `require(x)`. */
const loader = (node) =>
  ts.isCallExpression(node) &&
  (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(node.expression) && node.expression.text === "require"));

function checkFile(path, source, report) {
  const kind = /\.[cm]?tsx?$/u.test(path)
    ? path.endsWith("x")
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS
    : path.endsWith("x")
      ? ts.ScriptKind.JSX
      : ts.ScriptKind.JS;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
  const lineOf = (node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line;
  // The innermost statement holding a node: an exception covers exactly that one.
  const statementOf = (node) => {
    let statement = node;
    while (
      statement.parent &&
      !ts.isBlock(statement.parent) &&
      !ts.isSourceFile(statement.parent) &&
      !ts.isModuleBlock(statement.parent) &&
      !ts.isCaseOrDefaultClause(statement.parent)
    )
      statement = statement.parent;
    return statement;
  };
  // Statements holding a Playwright launch: no comment excuses anything in them.
  const launchStatements = new Set();
  /**
   * A real comment that gives a reason, bound to one statement: on its own line
   * directly before it (not trailing an earlier statement), or trailing it on its
   * last line. Strings never count.
   */
  const excused = (statement) => {
    const comments = [
      ...(ts.getLeadingCommentRanges(source, statement.getFullStart()) ?? []).filter((range) => {
        const start = source.lastIndexOf("\n", range.pos - 1) + 1;
        return source.slice(start, range.pos).trim() === "";
      }),
      ...(ts.getTrailingCommentRanges(source, statement.getEnd()) ?? []),
    ];
    return comments.some((range) => allowed.test(source.slice(range.pos, range.end)));
  };
  // Only a load the check can't name, or a flag outside any Playwright launch, may be excused.
  const pending = [];
  const fail = (node, message, excusable = false) =>
    pending.push({ node, message, excusable, statement: statementOf(node) });
  const flush = () => {
    for (const { node, message, excusable, statement } of pending) {
      if (excusable && !launchStatements.has(statement) && excused(statement)) continue;
      report(`${path}:${lineOf(node) + 1}: ${message}`);
    }
  };

  // Names bound to a Playwright module, and names bound to its Chromium, by declaration only.
  const modules = new Set();
  const chromiums = new Set();
  const loadedModule = (node) => {
    let at = unwrap(node);
    if (ts.isAwaitExpression(at)) at = unwrap(at.expression);
    return loader(at) && playwright.test(literalText(at.arguments[0]) ?? "");
  };
  const declare = (node) => {
    if (ts.isImportDeclaration(node) && playwright.test(literalText(node.moduleSpecifier) ?? "")) {
      const clause = node.importClause;
      if (clause?.name) modules.add(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) modules.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings))
        for (const element of bindings.elements) {
          const from = (element.propertyName ?? element.name).text;
          if (from === "chromium") chromiums.add(element.name.text);
          // `{ default as pw }` is the module itself.
          if (from === "default") modules.add(element.name.text);
        }
    }
    if (ts.isImportEqualsDeclaration(node)) fail(node, "an `import =` the check can't follow");
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      playwright.test(literalText(node.moduleSpecifier) ?? "")
    )
      fail(node, "re-exports Playwright, which the check can't follow");
    if (ts.isVariableDeclaration(node) && node.initializer && loadedModule(node.initializer)) {
      if (ts.isIdentifier(node.name)) modules.add(node.name.text);
      else if (ts.isObjectBindingPattern(node.name))
        for (const element of node.name.elements) {
          const from = keyName(element.propertyName ?? element.name);
          if (from === undefined || element.dotDotDotToken)
            fail(element, "destructures Playwright in a way the check can't follow");
          else if (!ts.isIdentifier(element.name))
            fail(element, "destructures Playwright in a way the check can't follow");
          else if (from === "chromium") chromiums.add(element.name.text);
          else if (from === "default") modules.add(element.name.text);
        }
      else fail(node, "destructures Playwright in a way the check can't follow");
    }
    ts.forEachChild(node, declare);
  };
  declare(file);

  // Identifiers that name a declaration or a property, rather than use a binding.
  const naming = (node) => {
    const parent = node.parent;
    return (
      (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
      ((ts.isImportSpecifier(parent) || ts.isBindingElement(parent)) &&
        (parent.name === node || parent.propertyName === node)) ||
      (ts.isVariableDeclaration(parent) && parent.name === node) ||
      (ts.isPropertyAssignment(parent) && parent.name === node) ||
      ts.isImportClause(parent) ||
      ts.isNamespaceImport(parent) ||
      (ts.isQualifiedName(parent) && parent.right === node)
    );
  };
  const inType = (node) => {
    for (let at = node.parent; at; at = at.parent) if (ts.isTypeNode(at)) return true;
    return false;
  };

  // Every object a spread can add: inline literals, either branch of a conditional.
  const harmless = (node) => {
    node = unwrap(node);
    if (ts.isConditionalExpression(node)) return harmless(node.whenTrue) && harmless(node.whenFalse);
    if (!ts.isObjectLiteralExpression(node)) return false;
    return node.properties.every((property) =>
      ts.isSpreadAssignment(property)
        ? harmless(property.expression)
        : property.name !== undefined &&
          keyName(property.name) !== undefined &&
          !sandboxKeys.has(keyName(property.name)),
    );
  };
  const checkLaunch = (call, method) => {
    launchStatements.add(statementOf(call));
    const given = call.arguments[method === "launchPersistentContext" ? 1 : 0];
    const options = given && unwrap(given);
    if (!options || !ts.isObjectLiteralExpression(options))
      return fail(call, `chromium.${method} options aren't an inline object literal`);
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
  /** A use of Chromium: only `chromium.member`, and a launch method only called in place. */
  const useChromium = (node) => {
    const parent = node.parent;
    if (!ts.isPropertyAccessExpression(parent) || parent.expression !== node)
      return fail(node, "Chromium is used in a way the check can't follow");
    const method = parent.name.text;
    if (!launches.has(method)) return;
    if (ts.isCallExpression(parent.parent) && parent.parent.expression === parent)
      checkLaunch(parent.parent, method);
    else fail(parent, `chromium.${method} is used in a way the check can't follow`);
  };

  const visit = (node) => {
    const flag = (text) => text !== undefined && unsandboxed.test(text);
    if (literalText(node) !== undefined && flag(literalText(node)))
      fail(node, `passes a sandbox-disabling flag: ${literalText(node)}`, true);
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      !(ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken) &&
      flag(folded(node))
    )
      fail(node, `passes a sandbox-disabling flag: ${folded(node)}`, true);
    if (ts.isTemplateExpression(node) && flag(node.getText(file)))
      fail(node, "passes a sandbox-disabling flag in a template", true);

    // A loader the check can't read in a file that names Playwright, or a Playwright
    // load anywhere but a declaration.
    if (loader(node)) {
      const specifier = literalText(node.arguments[0]);
      if (specifier === undefined) fail(node, "loads a module the check can't name", true);
      else if (playwright.test(specifier)) {
        let at = node.parent;
        while (ts.isParenthesizedExpression(at) || ts.isAwaitExpression(at)) at = at.parent;
        if (!ts.isVariableDeclaration(at)) fail(node, "loads Playwright where the check can't follow it");
      }
    }

    // `.chromium` on anything the check doesn't track may be Playwright's; only a direct
    // call (another library's `Browser.chromium(...)`) is left alone.
    if (
      !inType(node) &&
      ((ts.isPropertyAccessExpression(node) && node.name.text === "chromium") ||
        (ts.isElementAccessExpression(node) && folded(node.argumentExpression) === "chromium")) &&
      !(ts.isIdentifier(unwrap(node.expression)) && modules.has(unwrap(node.expression).text)) &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node)
    )
      fail(node, "reaches a `chromium` the check can't trace to its import");
    if (ts.isIdentifier(node) && !naming(node) && !inType(node)) {
      if (chromiums.has(node.text)) useChromium(node);
      else if (modules.has(node.text)) {
        const parent = node.parent;
        if (!ts.isPropertyAccessExpression(parent) || parent.expression !== node)
          fail(node, "a Playwright module is used in a way the check can't follow");
        else if (parent.name.text === "chromium") useChromium(parent);
        // A module's `default` is the module again; the check refuses rather than follows it.
        else if (parent.name.text === "default")
          fail(parent, "reaches Playwright through `default`, which the check refuses");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  flush();
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
  checkFile(path, source, (line) => failures.push(line));
}
if (failures.length) {
  process.stderr.write(
    [
      "Chromium launched without its sandbox, or launched where the check can't prove it.",
      "Playwright adds --no-sandbox unless a launch sets `chromiumSandbox: true`. Set it as a literal",
      "in the launch's inline options, or explain a scoped exception with `// allow-no-sandbox -- why`.",
      ...failures,
      "",
    ].join("\n"),
  );
  process.exit(1);
}
console.log(`chromium sandbox: ${files.length} files checked`);
