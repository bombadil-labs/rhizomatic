#!/usr/bin/env node
// The Haskell witness's green-gate: compile with the platform GHC and run the
// conformance binary. No cabal, no package manager, no network — the witness
// uses GHC boot packages only, so a bare `ghc` is the whole toolchain. Node is
// used as the launcher purely for cross-platform path/shell portability
// (matching tools/check-all.mjs, which is already Node).
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

mkdirSync("build", { recursive: true });
const exe = process.platform === "win32" ? "build\\conformance.exe" : "build/conformance";
execFileSync(
  "ghc",
  ["-O1", "-Wall", "-Werror", "-isrc", "-itest", "test/Main.hs", "-outputdir", "build", "-o", exe],
  { stdio: "inherit" },
);
execFileSync(exe, [], { stdio: "inherit" });
