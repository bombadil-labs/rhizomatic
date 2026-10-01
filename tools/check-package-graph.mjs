#!/usr/bin/env node
// Check local TypeScript source imports at both runtime and declaration time.
// `--report` prints the actual module edges; the default checks for cycles and
// rejects imports that escape an internal package through another package's barrel.
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { hostModules, scanBoundarySource } from "./package-boundary-scan.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceArgument = process.argv.indexOf("--source");
if (sourceArgument !== -1 && !process.argv[sourceArgument + 1])
  throw new Error("missing --source path");
const src =
  sourceArgument === -1
    ? join(root, "implementations", "ts", "src")
    : resolve(process.argv[sourceArgument + 1]);
const require = createRequire(
  join(root, "implementations", "ts", "package.json"),
);
const ts = require("typescript");
const report = process.argv.includes("--report");
const allowedDependencies = {
  "command-data": ["delta"],
  command: [
    "command-data",
    "schema-load",
    "schema",
    "resolve",
    "resolve-kernel",
    "principal",
    "syntax",
    "delta",
    "federation",
  ],
  delta: [],
  syntax: ["delta"],
  schema: ["syntax", "delta"],
  algebra: ["syntax", "delta"],
  "resolve-kernel": ["algebra", "syntax", "delta"],
  resolve: ["resolve-kernel", "algebra", "schema", "syntax", "delta"],
  "schema-load": ["resolve", "schema", "syntax", "delta"],
  reactor: [
    "resolve",
    "resolve-kernel",
    "algebra",
    "schema",
    "syntax",
    "delta",
  ],
  principal: ["reactor", "resolve", "schema", "syntax", "delta"],
  storage: ["delta"],
  federation: ["reactor", "resolve", "syntax", "storage", "delta"],
  derivation: ["reactor", "algebra", "delta"],
};

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")
      ? [path]
      : [];
  });
}

function packageOf(path) {
  const parts = relative(src, path).split(sep);
  return parts.length === 1 ? "aggregate" : parts[0];
}

function localTarget(from, specifier) {
  if (!specifier.startsWith(".")) return undefined;
  const path = resolve(dirname(from), specifier.replace(/\.js$/, ".ts"));
  if (!path.startsWith(src + sep) || !existsSync(path)) {
    throw new Error(
      `${relative(src, from)}: unresolved local import ${specifier}`,
    );
  }
  return path;
}

const files = sourceFiles(src).sort();
const edges = [];
for (const from of files) {
  const ast = ts.createSourceFile(
    from,
    readFileSync(from, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  if (packageOf(from) === "aggregate" && relative(src, from) !== "index.ts") {
    if (
      ast.statements.length !== 1 ||
      !ts.isExportDeclaration(ast.statements[0])
    ) {
      throw new Error(
        `${relative(src, from)} must only re-export its internal package module`,
      );
    }
  }
  for (const edge of scanBoundarySource(
    ts,
    ast,
    relative(src, from).split(sep).join("/"),
    packageOf(from),
  )) {
    const to = localTarget(from, edge.specifier);
    if (to) {
      const fromFile = relative(src, from).split(sep).join("/");
      const toFile = relative(src, to).split(sep).join("/");
      if (
        packageOf(from) !== "aggregate" &&
        !hostModules[fromFile] &&
        hostModules[toFile]
      ) {
        throw new Error(
          `${fromFile}: pure module reaches undeclared host capability ${toFile}`,
        );
      }
      edges.push({ from, to, kind: edge.kind });
    }
  }
}

function findCycle(nodes, links) {
  const outgoing = new Map([...nodes].map((node) => [node, []]));
  for (const [from, to] of links) outgoing.get(from)?.push(to);
  const visited = new Set();
  const active = new Set();
  const stack = [];
  function visit(node) {
    if (active.has(node)) return [...stack.slice(stack.indexOf(node)), node];
    if (visited.has(node)) return undefined;
    active.add(node);
    stack.push(node);
    for (const to of outgoing.get(node) ?? []) {
      const cycle = visit(to);
      if (cycle) return cycle;
    }
    stack.pop();
    active.delete(node);
    visited.add(node);
    return undefined;
  }
  for (const node of nodes) {
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return undefined;
}

const runtimeCycle = findCycle(
  files,
  edges.filter((e) => e.kind === "runtime").map((e) => [e.from, e.to]),
);
if (runtimeCycle)
  throw new Error(
    `runtime module cycle: ${runtimeCycle.map((f) => relative(src, f)).join(" -> ")}`,
  );
const declarationCycle = findCycle(
  files,
  edges.map((e) => [e.from, e.to]),
);

const packageEdges = edges.filter(
  (e) =>
    packageOf(e.from) !== packageOf(e.to) && packageOf(e.from) !== "aggregate",
);
const packages = new Set(files.map(packageOf).filter((p) => p !== "aggregate"));
for (const pkg of packages) {
  if (!(pkg in allowedDependencies))
    throw new Error(`undeclared package: ${pkg}`);
}
for (const e of packageEdges) {
  if (packageOf(e.to) === "aggregate") {
    throw new Error(
      `${relative(src, e.from)} imports aggregate ${relative(src, e.to)}`,
    );
  }
  if (!allowedDependencies[packageOf(e.from)]?.includes(packageOf(e.to))) {
    throw new Error(
      `undeclared ${e.kind} package edge: ${packageOf(e.from)} -> ${packageOf(e.to)} (${relative(src, e.from)} -> ${relative(src, e.to)})`,
    );
  }
}
const packageCycle = findCycle(
  packages,
  packageEdges.map((e) => [packageOf(e.from), packageOf(e.to)]),
);
if (packageCycle)
  throw new Error(
    `package cycle (runtime or declarations): ${packageCycle.join(" -> ")}`,
  );

if (report) {
  for (const e of edges) {
    console.log(
      `${relative(src, e.from)} -> ${relative(src, e.to)} [${e.kind}]`,
    );
  }
  console.log("Package edges:");
  for (const e of [
    ...new Set(
      packageEdges.map(
        (e) => `${packageOf(e.from)} -> ${packageOf(e.to)} [${e.kind}]`,
      ),
    ),
  ].sort())
    console.log(e);
  if (declarationCycle)
    console.log(
      `Existing declaration cycle: ${declarationCycle.map((f) => relative(src, f)).join(" -> ")}`,
    );
}
console.log(
  `Package graph green: ${files.length} modules, ${edges.length} local imports, ${packages.size} internal packages.`,
);
