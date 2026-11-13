// The whole-set methods of the memory `Reactor` are deprecated (SPEC-18 slice 2 plan, decision b
// and O1): `snapshot`, `arrivalLog`, `digest` and the unflagged `eval`, plus `legacyHoldings`,
// which returns the same whole-set access for the legacy in-memory peer. They stay for consumers
// until slice 5. This rail holds two things: each of the five carries `@deprecated` naming a
// replacement, and no source file outside the reactor itself reaches one, except the two legacy
// peer files that may call `legacyHoldings`.
//
// It is a type-aware grep. A text search cannot tell `reactor.digest()` from `DeltaSet.digest()`,
// so the rail asks the compiler about each access. An access counts when its symbol is the
// `Reactor` method, or when its receiver's type is one a `Reactor` is assignable to: that catches
// a call through an interface the class satisfies, or through `Pick<Reactor, ...>`. It sees
// property access, a string-like element key (quoted or template) and object destructuring. It
// reads `src/` only: tests, tools and demos may still call the deprecated methods.
//
// It does not follow a method pulled off by computed key from a variable (`r[name]()`), nor a
// receiver typed `any`; both are lint-visible elsewhere and rare enough to leave.

import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../src");
const reactorFile = join(src, "reactor", "reactor.ts");
const DEPRECATED = ["snapshot", "arrivalLog", "digest", "eval", "legacyHoldings"] as const;
const isDeprecatedName = (name: string): boolean =>
  (DEPRECATED as readonly string[]).includes(name);
/** The legacy in-memory peer and its HTTP binding sync by listing everything until slice 5. */
const LEGACY_ALLOWED: Readonly<Record<string, readonly string[]>> = {
  legacyHoldings: [join("federation", "peer.ts"), join("federation", "http.ts")],
};

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(dir, entry.name))
      : entry.name.endsWith(".ts")
        ? [join(dir, entry.name)]
        : [],
  );

const program = ts.createProgram(walk(src).sort(), {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2022,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
});
const checker = program.getTypeChecker();

/** The class declaration of `Reactor`. */
function reactorClass(): ts.ClassDeclaration {
  const file = program.getSourceFile(reactorFile)!;
  const found = file.statements.find(
    (node): node is ts.ClassDeclaration =>
      ts.isClassDeclaration(node) && node.name?.text === "Reactor",
  );
  if (found === undefined) throw new Error("class Reactor not found");
  return found;
}

/** The deprecated method declarations of `class Reactor`, by name. */
function deprecatedDeclarations(cls: ts.ClassDeclaration): Map<string, ts.MethodDeclaration> {
  const found = new Map<string, ts.MethodDeclaration>();
  for (const member of cls.members)
    if (
      ts.isMethodDeclaration(member) &&
      ts.isIdentifier(member.name) &&
      isDeprecatedName(member.name.text)
    )
      found.set(member.name.text, member);
  return found;
}

const cls = reactorClass();
const declarations = deprecatedDeclarations(cls);
const reactorType = checker.getDeclaredTypeOfSymbol(checker.getSymbolAtLocation(cls.name!)!);

/** Whether a value of this type may be a `Reactor`: the type is one a `Reactor` is assignable to. */
function mayBeReactor(type: ts.Type): boolean {
  const base = checker.getNonNullableType(checker.getBaseConstraintOfType(type) ?? type);
  if ((base.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return false;
  if (base.isUnion()) return base.types.some(mayBeReactor);
  return checker.isTypeAssignableTo(reactorType, base);
}

/** Each access in one file to a deprecated name that reaches a `Reactor`. */
function reactorAccesses(
  file: ts.SourceFile,
  examined: { n: number },
): { name: string; at: string }[] {
  const targets = new Set<ts.Node>(declarations.values());
  const hits: { name: string; at: string }[] = [];
  const record = (node: ts.Node, name: string): void => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart());
    hits.push({ name, at: `${relative(src, file.fileName)}:${line + 1} ${node.getText()}` });
  };
  const visit = (node: ts.Node): void => {
    let key: ts.Node | undefined;
    let name: string | undefined;
    let receiver: ts.Type | undefined;
    if (ts.isPropertyAccessExpression(node)) {
      key = node.name;
      name = node.name.text;
      if (isDeprecatedName(name)) receiver = checker.getTypeAtLocation(node.expression);
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression)
    ) {
      key = node.argumentExpression;
      name = node.argumentExpression.text;
      if (isDeprecatedName(name)) receiver = checker.getTypeAtLocation(node.expression);
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const prop = node.propertyName ?? node.name;
      key = prop;
      name = ts.isIdentifier(prop) || ts.isStringLiteralLike(prop) ? prop.text : undefined;
      if (name !== undefined && isDeprecatedName(name))
        receiver = checker.getTypeAtLocation(node.parent);
    }
    if (key !== undefined && name !== undefined && receiver !== undefined) {
      examined.n += 1;
      const symbol = checker.getSymbolAtLocation(key);
      if (symbol?.declarations?.some((d) => targets.has(d)) === true || mayBeReactor(receiver))
        record(node, name);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return hits;
}

describe("the deprecated whole-set methods of Reactor", () => {
  it("each carries @deprecated and names a replacement", () => {
    expect([...declarations.keys()].sort()).toEqual([...DEPRECATED].sort());
    for (const [name, declaration] of declarations) {
      const tag = ts.getJSDocTags(declaration).find((t) => t.tagName.text === "deprecated");
      expect(tag, name).toBeDefined();
      const text = ts.getTextOfJSDocComment(tag!.comment) ?? "";
      // A replacement is named in code font: a function, a method or a type.
      expect(text, name).toMatch(/`[A-Za-z.]+(\([^`]*\))?`/);
    }
  });

  it("no source file outside the reactor reaches one, but the legacy peer's allowance", () => {
    const calls: string[] = [];
    const examined = { n: 0 };
    let allowed = 0;
    for (const file of program.getSourceFiles()) {
      if (!file.fileName.startsWith(src) || file.fileName === reactorFile) continue;
      const rel = relative(src, file.fileName);
      for (const hit of reactorAccesses(file, examined))
        if (LEGACY_ALLOWED[hit.name]?.includes(rel) === true) allowed += 1;
        else calls.push(hit.at);
    }
    expect(calls).toEqual([]);
    // The allowance is in use: the legacy peer still reaches `legacyHoldings`. When it stops, the
    // allowance goes too.
    expect(allowed).toBeGreaterThan(0);
    // The scan reaches the calls of the same names on other types (`DeltaSet.digest`, a journal
    // peer's `snapshot`), so it is not empty because it found nothing to look at.
    expect(examined.n).toBeGreaterThan(5);
  });
});
