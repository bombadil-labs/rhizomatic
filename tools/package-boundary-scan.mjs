// Direct source-boundary enforcement. This is not a proof of transitive purity:
// declared crypto intrinsics and capability adapters still require review.
export const hostModules = {
  "federation/file-peer-state.ts": {
    modules: ["node:fs", "node:crypto", "node:path"],
    globals: { process: ["pid"] },
    reason:
      "Atomic peer-state file adapter; filesystem and random temporary names.",
  },
  "federation/file-durable-state.ts": {
    modules: ["node:fs", "node:crypto", "node:path"],
    globals: { process: ["pid"] },
    reason:
      "Atomic durable-state file adapter; filesystem and random temporary names.",
  },
  "federation/file-single-peer.ts": {
    modules: ["node:fs"],
    reason: "Explicit single-peer file opening capability.",
  },
  "federation/file-signed-loose-admission.ts": {
    modules: [],
    reason: "Explicit file admission adapter delegates durable-state writes.",
  },
  "federation/http.ts": {
    modules: ["node:http"],
    globals: { fetch: true },
    reason: "Explicit HTTP transport capability.",
  },
};
const externalBindings = {
  delta: {
    "@noble/curves/ed25519": ["ed25519"],
    "@noble/hashes/sha2": ["sha512"],
    "@noble/hashes/blake3": ["blake3"],
    "@noble/hashes/utils": ["bytesToHex", "concatBytes", "hexToBytes"],
  },
  "schema-load": { "@noble/hashes/utils": ["hexToBytes"] },
};
const ambient = new Set([
  "Date",
  "process",
  "globalThis",
  "global",
  "window",
  "self",
  "document",
  "navigator",
  "performance",
  "crypto",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "console",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "queueMicrotask",
  "requestAnimationFrame",
  "eval",
  "Function",
  "require",
  "module",
  "exports",
  "Intl",
  "WeakRef",
  "FinalizationRegistry",
  "Atomics",
  "SharedArrayBuffer",
]);
const randomMembers = new Set([
  "random",
  "randomBytes",
  "randomPrivateKey",
  "randomSecretKey",
  "getRandomValues",
  "randomUUID",
]);

export function scanBoundarySource(ts, ast, file, owner) {
  const imports = [],
    host = hostModules[file];
  const fail = (message) => {
    throw Error(`${file}: ${message}`);
  };
  const staticName = (node, computed = false) => {
    if (!node) return undefined;
    if (ts.isIdentifier(node)) return computed ? undefined : node.text;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      return node.text;
    if (ts.isComputedPropertyName(node))
      return staticName(node.expression, true);
    return undefined;
  };
  const permittedGlobal = (node) => {
    const permitted = host?.globals?.[node.text];
    if (permitted === true) return true;
    const parent = node.parent;
    if (!Array.isArray(permitted) || parent.expression !== node) return false;
    return (
      (ts.isPropertyAccessExpression(parent) &&
        permitted.includes(parent.name.text)) ||
      (ts.isElementAccessExpression(parent) &&
        permitted.includes(staticName(parent.argumentExpression, true)))
    );
  };
  const add = (specifier, kind, bindings) => {
    if (specifier.startsWith("@bombadil/rhizomatic"))
      fail("imports its own aggregate package");
    if (specifier.startsWith(".")) {
      imports.push({ specifier, kind });
      return;
    }
    if (host?.modules.includes(specifier)) return;
    const allowed = externalBindings[owner]?.[specifier];
    if (!allowed || !bindings || bindings.some((b) => !allowed.includes(b)))
      fail(`undeclared external dependency/binding ${specifier}`);
  };
  const bindingsOf = (node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (
        !clause ||
        clause.name ||
        !clause.namedBindings ||
        !ts.isNamedImports(clause.namedBindings)
      )
        return undefined;
      return clause.namedBindings.elements.map(
        (e) => (e.propertyName ?? e.name).text,
      );
    }
    if (node.exportClause && ts.isNamedExports(node.exportClause))
      return node.exportClause.elements.map(
        (e) => (e.propertyName ?? e.name).text,
      );
    return undefined;
  };
  const reference = (node) => {
    const p = node.parent;
    if (ts.isPropertyAccessExpression(p) && p.name === node) return false;
    if (
      (ts.isPropertyAssignment(p) ||
        ts.isMethodDeclaration(p) ||
        ts.isPropertyDeclaration(p) ||
        ts.isPropertySignature(p)) &&
      p.name === node
    )
      return false;
    if (ts.isImportSpecifier(p) && p.propertyName === node) return false;
    return true;
  };
  function visit(node) {
    if (ts.isImportEqualsDeclaration(node))
      fail("unsupported import-equals form");
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    )
      fail("unsupported require import form");
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) {
        if (!ts.isStringLiteral(node.moduleSpecifier))
          fail("unresolved module specifier");
        const clause = ts.isImportDeclaration(node)
          ? node.importClause
          : node.exportClause;
        const named =
          clause && ts.isImportClause(clause) ? clause.namedBindings : clause;
        const onlyTypes =
          named &&
          (ts.isNamedImports(named) || ts.isNamedExports(named)) &&
          named.elements.length > 0 &&
          named.elements.every((e) => e.isTypeOnly);
        const typeOnly =
          node.isTypeOnly ||
          clause?.isTypeOnly ||
          (onlyTypes && !node.importClause?.name);
        add(
          node.moduleSpecifier.text,
          typeOnly ? "type" : "runtime",
          bindingsOf(node),
        );
      }
    }
    if (ts.isImportTypeNode(node)) {
      if (
        !ts.isLiteralTypeNode(node.argument) ||
        !ts.isStringLiteral(node.argument.literal)
      )
        fail("unresolved import type");
      // Qualified external import types use the same explicit binding allowlist.
      const rootName = (q) =>
        ts.isIdentifier(q)
          ? q.text
          : ts.isQualifiedName(q)
            ? rootName(q.left)
            : undefined;
      add(
        node.argument.literal.text,
        "type",
        node.qualifier ? [rootName(node.qualifier)] : undefined,
      );
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const arg = node.arguments[0];
      if (node.arguments.length !== 1 || !arg || !ts.isStringLiteral(arg))
        fail("unresolved dynamic import");
      add(arg.text, "runtime", undefined);
    }
    {
      if (
        ts.isMetaProperty(node) &&
        node.keywordToken === ts.SyntaxKind.ImportKeyword
      )
        fail("undeclared module location observation");
      if (
        ts.isIdentifier(node) &&
        ambient.has(node.text) &&
        reference(node) &&
        !permittedGlobal(node)
      )
        fail(`undeclared ambient observation ${node.text}`);
      if (
        ts.isBindingElement(node) &&
        randomMembers.has(staticName(node.propertyName ?? node.name))
      )
        fail("undeclared destructured randomness capability");
      if (
        ts.isPropertyAccessExpression(node) &&
        randomMembers.has(node.name.text)
      )
        fail(`undeclared randomness member ${node.name.text}`);
      if (ts.isElementAccessExpression(node)) {
        const arg = node.argumentExpression;
        if (
          randomMembers.has(staticName(arg, true)) ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "Math" &&
            !(
              ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)
            ))
        )
          fail("undeclared computed randomness capability");
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return imports;
}
