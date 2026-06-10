#!/usr/bin/env node
// The top-level parity runner: both witnesses' green-gates, one command.
//   node tools/check-all.mjs
// Exits non-zero on the first failure. On Windows it injects the scoop rustup/gcc paths
// recorded in implementations/rust/CLAUDE.md; elsewhere it assumes cargo is on PATH.

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "../..");

function run(label, command, cwd, env = {}) {
  process.stdout.write(`\n=== ${label} ===\n`);
  execSync(command, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
}

// --- TypeScript witness ---
const tsDir = join(root, "implementations", "ts");
run("TypeScript: green-gate", "npm run check", tsDir);

// --- Rust witness ---
const rustDir = join(root, "implementations", "rust");
const env = {};
if (process.platform === "win32") {
  const scoop = join(homedir(), "scoop");
  const cargoHome = join(scoop, "persist", "rustup", ".cargo");
  if (existsSync(cargoHome)) {
    env.RUSTUP_HOME = join(scoop, "persist", "rustup", ".rustup");
    env.CARGO_HOME = cargoHome;
    env.PATH = `${join(cargoHome, "bin")};${join(scoop, "apps", "gcc", "current", "bin")};${process.env.PATH}`;
  }
}
run("Rust: fmt", "cargo fmt --check", rustDir, env);
run("Rust: clippy", "cargo clippy --all-targets --quiet -- -D warnings", rustDir, env);
run("Rust: tests", "cargo test --quiet", rustDir, env);

process.stdout.write("\nBoth witnesses green. The parity contract holds.\n");
