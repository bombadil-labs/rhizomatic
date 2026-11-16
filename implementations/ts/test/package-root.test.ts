// The package root never loads `better-sqlite3` (SPEC-18 proposal §9; slice 4 plan S4-1). It is an
// optional peer dependency behind the subpath `./store/sqlite`, so a host or a browser bundle
// without it still loads the root. Each case runs the TypeScript sources in a new Node process
// whose module resolver refuses `better-sqlite3`.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const BLOCK = `data:text/javascript,${encodeURIComponent(
  'export async function resolve(specifier, context, next) { if (specifier === "better-sqlite3") throw new Error("better-sqlite3 is not installed"); return next(specifier, context); }',
)}`;
const REGISTER = `data:text/javascript,${encodeURIComponent(
  `import { register } from "node:module"; register(${JSON.stringify(BLOCK)});`,
)}`;

/** Imports one module in a process where `better-sqlite3` cannot be resolved. */
function load(module: string): { status: number | null; output: string } {
  const url = pathToFileURL(resolve(pkg, module)).href;
  const run = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      REGISTER,
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(url)}); console.log("loaded");`,
    ],
    { cwd: pkg, encoding: "utf8", timeout: 120_000 },
  );
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

describe("the package root without better-sqlite3", () => {
  it("loads", () => {
    const root = load("src/index.ts");
    expect(root.output).toContain("loaded");
    expect(root.status).toBe(0);
  }, 120_000);

  it("the SQLite subpath does not, so the resolver is in force", () => {
    const sqlite = load("src/storage/sqlite-store.ts");
    expect(sqlite.output).toContain("better-sqlite3 is not installed");
    expect(sqlite.status).not.toBe(0);
  }, 120_000);

  it("the package exports the SQLite store at ./store/sqlite only, and depends on it optionally", () => {
    const manifest = JSON.parse(readFileSync(resolve(pkg, "package.json"), "utf8")) as {
      exports: Record<string, { default: string }>;
      dependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
      peerDependenciesMeta: Record<string, { optional?: boolean }>;
    };
    expect(manifest.exports["./store/sqlite"]?.default).toBe("./dist/storage/sqlite-store.js");
    expect(manifest.dependencies["better-sqlite3"]).toBeUndefined();
    expect(manifest.peerDependencies["better-sqlite3"]).toBeDefined();
    expect(manifest.peerDependenciesMeta["better-sqlite3"]?.optional).toBe(true);
  });
});
