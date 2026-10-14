#!/usr/bin/env node
// The pre-push gate: the fast checks CI runs on every pull request, in the order that fails
// soonest, plus a freshness check of every generated file. Run it before every push.
//   node tools/precheck.mjs
// It does not run the witness test suites (`npm run check`, `cargo test`) or the heavy
// release-candidate tier; CI runs those. Exits non-zero on the first failure.

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const ts = join(root, "implementations/ts");
const rust = join(root, "implementations/rust");

// Generated files that CI compares byte for byte with a fresh build.
const generated = ["docs", "vectors", "contracts/command/coverage.json", "contracts/command/TOWERS.json"];

function snapshot() {
  const out = new Map();
  const walk = (p) => {
    if (!existsSync(p)) return;
    if (statSync(p).isDirectory()) for (const n of readdirSync(p)) walk(join(p, n));
    else out.set(relative(root, p), createHash("sha256").update(readFileSync(p)).digest("hex"));
  };
  for (const g of generated) walk(join(root, g));
  return out;
}

const steps = [
  ["materialization packet", root, "node contracts/materialization/validate.mjs --self-test"],
  ["command contracts and TS export inventory", root, "node tools/check-command-contracts.mjs --self-test"],
  ["package graph", root, "node tools/check-package-graph.mjs"],
  ["Rust boundaries and dependency inventory", root, "node tools/check-rust-command-boundaries.mjs"],
  ["TS format, lint and types", ts, "npm run -s format:check && npm run -s lint && npm run -s typecheck"],
  ["Rust format and clippy", rust, "cargo fmt --check && cargo clippy -q --all-targets -- -D warnings"],
  [
    "generated files are fresh",
    ts,
    "npm run -s docs:build && npm run -s gen-vectors && npm run -s gen-command-vectors && npm run -s gen-evidence-vectors && npm run -s gen-materialization-vectors",
  ],
];

let before;
for (const [name, cwd, cmd] of steps) {
  if (name === "generated files are fresh") before = snapshot();
  const t = Date.now();
  process.stdout.write(`precheck: ${name} ... `);
  try {
    execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
  } catch (e) {
    console.log("FAILED");
    process.stdout.write(String(e.stdout ?? "") + String(e.stderr ?? ""));
    process.exit(1);
  }
  console.log(`ok (${((Date.now() - t) / 1000).toFixed(0)} s)`);
}
const after = snapshot();
const moved = [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k));
if (moved.length) {
  console.log("precheck: the generators changed these files; review and commit them:");
  for (const m of moved.sort()) console.log("  " + m);
  process.exit(1);
}
console.log("precheck: all fast checks pass");
