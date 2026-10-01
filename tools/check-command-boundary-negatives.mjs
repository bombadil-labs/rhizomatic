import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "command-boundary-"));
try {
  for (const [name, files, pattern] of [
    [
      "type-only upward",
      {
        "delta/a.ts": 'import type { X } from "../syntax/b.js";',
        "syntax/b.ts": "export type X=string;",
      },
      /undeclared type package edge/,
    ],
    [
      "runtime upward",
      {
        "delta/a.ts": 'import { x } from "../syntax/b.js";',
        "syntax/b.ts": "export const x=1;",
      },
      /undeclared runtime package edge/,
    ],
    [
      "aggregate import",
      {
        "delta/a.ts": 'import { x } from "../index.js";',
        "index.ts": "export const x=1;",
      },
      /imports aggregate/,
    ],
    [
      "dynamic unresolved",
      { "delta/a.ts": 'const path="x"; import(path);' },
      /unresolved dynamic import/,
    ],
    [
      "external host dependency",
      { "delta/a.ts": 'import fs from "node:fs";' },
      /undeclared external dependency/,
    ],
    [
      "inline type upward",
      {
        "delta/a.ts": 'export type X=import("../syntax/b.js").X;',
        "syntax/b.ts": "export type X=string;",
      },
      /undeclared type package edge/,
    ],
    [
      "type reexport upward",
      {
        "delta/a.ts": 'export { type X } from "../syntax/b.js";',
        "syntax/b.ts": "export type X=string;",
      },
      /undeclared type package edge/,
    ],
    [
      "dynamic literal upward",
      {
        "delta/a.ts": 'import("../syntax/b.js");',
        "syntax/b.ts": "export const x=1;",
      },
      /undeclared runtime package edge/,
    ],
    [
      "external dynamic aggregate",
      { "delta/a.ts": 'import("@bombadil/rhizomatic");' },
      /own aggregate package/,
    ],
    [
      "import equals unresolved",
      { "delta/a.ts": 'import x = require("unknown");' },
      /unsupported import-equals/,
    ],
    [
      "crypto random alias",
      {
        "delta/a.ts": 'import { randomBytes as r } from "@noble/hashes/utils";',
      },
      /undeclared external dependency/,
    ],
    [
      "crypto namespace import",
      { "delta/a.ts": 'import * as utils from "@noble/hashes/utils";' },
      /undeclared external dependency/,
    ],
    [
      "core federation host import",
      { "federation/core.ts": 'import fs from "node:fs";' },
      /undeclared external dependency/,
    ],
    [
      "core federation indirect host",
      {
        "federation/core.ts": 'import { x } from "./file-durable-state.js";',
        "federation/file-durable-state.ts": "export const x=1;",
      },
      /pure module reaches undeclared host capability/,
    ],
    [
      "core federation clock",
      { "federation/core.ts": "export const now=Date.now();" },
      /undeclared ambient observation/,
    ],
    [
      "computed ambient clock",
      { "delta/a.ts": 'export const now=globalThis["Date"].now();' },
      /undeclared ambient observation/,
    ],
    [
      "random function capture",
      { "delta/a.ts": "export const random=Math.random;" },
      /undeclared randomness/,
    ],
    [
      "computed random member",
      { "delta/a.ts": 'export const random=Math["random"];' },
      /computed randomness/,
    ],
    [
      "unknown computed Math member",
      { "delta/a.ts": "export const f=(key:string)=>Math[key];" },
      /computed randomness/,
    ],
    [
      "undeclared file adapter network",
      { "federation/file-peer-state.ts": 'import http from "node:http";' },
      /undeclared external dependency/,
    ],
    [
      "destructured randomness",
      { "delta/a.ts": "const {random:r}=Math; export {r};" },
      /destructured randomness/,
    ],
    [
      "hidden module location",
      { "delta/a.ts": "export const source=import.meta.url;" },
      /module location observation/,
    ],
    [
      "host unresolved require",
      { "federation/http.ts": "const x=require(variable);" },
      /unsupported require import/,
    ],
    [
      "direct hidden clock",
      { "delta/a.ts": "export const now=Date.now();" },
      /undeclared ambient observation/,
    ],
  ]) {
    const fixture = join(dir, name);
    for (const [path, source] of Object.entries(files)) {
      mkdirSync(dirname(join(fixture, path)), { recursive: true });
      writeFileSync(join(fixture, path), source);
    }
    const result = spawnSync(
      process.execPath,
      [join(root, "tools/check-package-graph.mjs"), "--source", fixture],
      { encoding: "utf8" },
    );
    if (result.status === 0 || !pattern.test(result.stderr))
      throw Error(
        `boundary negative accepted or wrong reason: ${name}: ${result.stderr}`,
      );
  }
  for (const [name, files] of [
    [
      "benign property names",
      {
        "delta/a.ts":
          "export const x={process:1,Date:2}; export const y=x.process;",
      },
    ],
    [
      "explicit crypto primitives",
      {
        "delta/a.ts":
          'import { bytesToHex as hex } from "@noble/hashes/utils"; export {hex};',
      },
    ],
    [
      "declared host operation",
      {
        "federation/file-peer-state.ts":
          'import { readFileSync } from "node:fs"; export const read=readFileSync;',
      },
    ],
    [
      "allowed type and runtime edges",
      {
        "syntax/a.ts":
          'import {x,type X} from "../delta/b.js"; export {x}; export type Y=X;',
        "delta/b.ts": "export const x=1; export type X=number;",
      },
    ],
  ]) {
    const fixture = join(dir, name);
    for (const [path, source] of Object.entries(files)) {
      mkdirSync(dirname(join(fixture, path)), { recursive: true });
      writeFileSync(join(fixture, path), source);
    }
    const result = spawnSync(
      process.execPath,
      [join(root, "tools/check-package-graph.mjs"), "--source", fixture],
      { encoding: "utf8" },
    );
    if (result.status !== 0)
      throw Error(`valid boundary fixture refused: ${name}: ${result.stderr}`);
  }
  console.log(
    "Disposable TypeScript AST boundary/observation negative fixtures rejected for their intended reasons.",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
