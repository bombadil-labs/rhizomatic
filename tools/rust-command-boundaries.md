# Rust command boundary gate

Run `node tools/check-rust-command-boundaries.mjs` and
`node --test tools/check-rust-command-boundaries.test.mjs` from the repository root.
The gate builds the `syn` inventory example for the executable host target and uses
Cargo's reported executable path, including when a custom target directory is set.

The scanner reads every production source cfg region, including host and WASM
branches. The gate compares live public symbol ownership and dependency records
with `contracts/command/rust-exports.json`. Reviewed contract classifications and
semantic descriptions remain separate from generated structural facts.
Dependency permission comes from `contracts/command/BOUNDARIES.json`.

The root module can reexport bindings. The WASM transport adapter can call its
existing delta, syntax, schema and resolution owners. Neither exception applies to
ordinary semantic modules. Host filesystem and HTTP facilities are permitted at
named adapter functions; importing or calling those functions from semantic code
is rejected. Crypto dependencies are limited to their implementing modules.
Standard library containers, string/number codecs and memory operations are
allowed; environment, clocks, process spawning and filesystem access are not
implicit semantic capabilities.

Tests use temporary Rust source trees, processed by the real scanner. They cover
upward dependencies, aliases, type paths, cfg branches, macro arguments, ambient
host access, unknown syntax/import forms, and stale or invalid inventories. These
small source trees exercise scanning and ownership; they are not compiled Rust
programs. The real witness is compiled and tested separately.

This is source AST enforcement. It does not prove compiler trait resolution,
method-dispatch purity, foreign dependency internals, or arbitrary transitive
purity. In particular, permitted containers may use internal randomized hashing;
canonical output and ingestion-order conformance remain separate obligations.
Unknown production modules and unsupported macro/import forms fail closed.
