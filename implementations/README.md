# Implementations

Two implementations of the Rhizomatic spec, maintained **in parallel and in lockstep**:

- [`ts/`](ts/) — TypeScript
- [`rust/`](rust/) — Rust

Neither is canonical (SPEC-0 §5). They are two independent witnesses to the same spec, tested against
the shared [`../vectors/`](../vectors/). When they disagree, the spec or the vectors are
underspecified — that is a finding to resolve upstream, not a bug to paper over in one language.

See [../CLAUDE.md](../CLAUDE.md) for the workflow loop, testing norms, and the parity contract.
