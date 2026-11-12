// The whole-set methods of the memory `Reactor` are deprecated (SPEC-18 slice 2 plan, decision b
// and O1): `snapshot`, `arrivalLog`, `digest` and the unflagged `eval`. They stay for consumers
// until slice 5. This rail holds two things: each of the four carries `@deprecated` naming a
// replacement, and no source file outside the reactor itself calls one.
//
// It is a type-aware grep. A text search cannot tell `reactor.digest()` from `DeltaSet.digest()`,
// so the rail asks the compiler which declaration each call reaches. It reads `src/` only: tests,
// tools and demos may still call the deprecated methods.

import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../src");
const reactorFile = join(src, "reactor", "reactor.ts");
const DEPRECATED = ["snapshot", "arrivalLog", "digest", "eval"] as const;

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

/** The four method declarations of `class Reactor`, by name. */
function deprecatedDeclarations(): Map<string, ts.MethodDeclaration> {
  const file = program.getSourceFile(reactorFile)!;
  const found = new Map<string, ts.MethodDeclaration>();
  ts.forEachChild(file, (node) => {
    if (!ts.isClassDeclaration(node) || node.name?.text !== "Reactor") return;
    for (const member of node.members)
      if (
        ts.isMethodDeclaration(member) &&
        ts.isIdentifier(member.name) &&
        (DEPRECATED as readonly string[]).includes(member.name.text)
      )
        found.set(member.name.text, member);
  });
  return found;
}

describe("the deprecated whole-set methods of Reactor", () => {
  const declarations = deprecatedDeclarations();

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

  it("no source file outside the reactor calls one", () => {
    const targets = new Set<ts.Node>(declarations.values());
    const calls: string[] = [];
    let examined = 0;
    for (const file of program.getSourceFiles()) {
      if (!file.fileName.startsWith(src) || file.fileName === reactorFile) continue;
      const visit = (node: ts.Node): void => {
        const name = ts.isPropertyAccessExpression(node)
          ? node.name
          : ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)
            ? node.argumentExpression
            : undefined;
        if (name !== undefined && (DEPRECATED as readonly string[]).includes(name.text)) {
          examined += 1;
          const symbol = checker.getSymbolAtLocation(name);
          if (symbol?.declarations?.some((d) => targets.has(d)) === true) {
            const { line } = file.getLineAndCharacterOfPosition(node.getStart());
            calls.push(`${relative(src, file.fileName)}:${line + 1} ${node.getText()}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
    expect(calls).toEqual([]);
    // The scan reaches the calls of the same names on other types (`DeltaSet.digest`, a journal
    // peer's `snapshot`), so it is not empty because it found nothing to look at.
    expect(examined).toBeGreaterThan(5);
  });
});
