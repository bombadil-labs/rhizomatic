#!/usr/bin/env node
// The top-level parity runner: every witness's green-gate, one command.
//   node tools/check-all.mjs [witness ...]
// Discovers witnesses from implementations/*/witness.json (issue #19: N witnesses, parity as a
// relation over the set, not a pair). Each manifest declares its conformance level (SPEC-0 §5.1)
// and its check commands; byte-parity itself is enforced inside each witness's conformance tests,
// which all load the same vectors/. Exits non-zero on the first failure.
//
// envProfile "cargo-scoop-windows" injects the scoop rustup/gcc paths recorded in
// implementations/rust/CLAUDE.md; elsewhere it assumes cargo is on PATH.

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "../..");
const implDir = join(root, "implementations");

function envFor(profile) {
  if (profile === "cargo-scoop-windows" && process.platform === "win32") {
    const scoop = join(homedir(), "scoop");
    const cargoHome = join(scoop, "persist", "rustup", ".cargo");
    if (existsSync(cargoHome)) {
      return {
        RUSTUP_HOME: join(scoop, "persist", "rustup", ".rustup"),
        CARGO_HOME: cargoHome,
        PATH: `${join(cargoHome, "bin")};${join(scoop, "apps", "gcc", "current", "bin")};${process.env.PATH}`,
      };
    }
  }
  return {};
}

const only = process.argv.slice(2);
const witnesses = readdirSync(implDir)
  .filter((d) => existsSync(join(implDir, d, "witness.json")))
  .map((d) => ({ dir: join(implDir, d), ...JSON.parse(readFileSync(join(implDir, d, "witness.json"), "utf8")) }))
  .filter((w) => only.length === 0 || only.includes(w.witness));

if (witnesses.length === 0) {
  console.error(only.length ? `no witness matches: ${only.join(", ")}` : "no witness.json manifests found");
  process.exit(1);
}

for (const w of witnesses) {
  const env = envFor(w.envProfile);
  for (const check of w.checks) {
    process.stdout.write(`\n=== ${w.language} witness (L${w.conformanceLevel}): ${check.label} ===\n`);
    execSync(check.command, { cwd: w.dir, stdio: "inherit", env: { ...process.env, ...env } });
  }
}

const roster = witnesses.map((w) => `${w.language} (L${w.conformanceLevel})`).join(", ");
process.stdout.write(`\nAll ${witnesses.length} witnesses green — ${roster}. The parity contract holds.\n`);
