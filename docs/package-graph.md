# vNext TypeScript package graph

This is the first artifact of the vNext restructure. It records the actual import graph before
source moves and the acyclic package graph that the moves must satisfy. Package names describe
source boundaries inside the existing `@bombadil/rhizomatic` npm distribution; the aggregate
`src/index.ts` remains the public entry point. Root module files remain as compatibility
re-exports for existing source imports; internal packages import one another directly.

Run `node tools/check-package-graph.mjs --report` to print every local import with its runtime or
type classification. The checker parses TypeScript import and export declarations, resolves local
`.js` specifiers to source files, rejects unresolved local imports, and checks all package edges
including edges needed by emitted declarations. The check runs in the TypeScript green gate.

## Baseline at `50675e9`

The 25 source modules have 121 local import/export edges. The runtime module graph has no cycle.
The combined runtime and declaration graph has cycles, including
`hview → resolution → hview` and `pred → eval → pred`. These are legal while files share one
package, but would become invalid package dependencies if each file's semantic label were used
as its build package. The following crossings are the reason for the boundary work:

| Current edge | Boundary decision |
| --- | --- |
| `pack → reactor.manifestMemberIds` | Put the manifest parser with delta vocabulary. |
| `eval → resolution` | Put the pure View policy kernel below terminal term execution. |
| `eval → schema.SchemaRegistry` | Put terminal term execution above the registry package. |
| `reactor → resolution` | `reactor` sits above the resolve composition it materializes. |
| `hview`, `schema → term-io` | Shared canonical syntax sits below both. |
| `term-json → eval.termContainsInView` | Structural validation sits with syntax. |
| `reactor`, `derivation → schema-deltas.VOCAB_PREFIX` | Import vocabulary directly from delta. |

## Build DAG for the boundary move

An arrow means “may depend on.” The graph is a build order, not a renumbering of the spec layers.
Storage remains semantically L0 and still depends on delta parsing to rehydrate a pack.

```text
delta
syntax       → delta
schema       → syntax, delta
algebra      → syntax, delta
resolve-kernel → algebra, syntax, delta
resolve      → resolve-kernel, algebra, schema, syntax, delta
schema-load  → resolve, schema, syntax, delta
reactor      → resolve, resolve-kernel, algebra, schema, syntax, delta
storage      → delta
federation   → reactor, resolve, syntax, delta
derivation   → reactor, algebra, delta
```

`schema-load` is the registry adapter for self-hosted schema deltas. The `resolve` package owns
the terminal `resolve` term composition and public `evalTerm` entry point. `resolve-kernel` owns
pure View policy evaluation below that composition; `algebra` owns HView serialization. This
prevents upward imports. Future `principal`
and `erasure` packages are absent until their semantic steps. The approved name is **erasure**;
negation remains an algebraic delta operation.

The graph check treats type-only imports and inline `import()` types as package edges. It permits
internal source cycles within a package but rejects cycles and undeclared edges across packages.
The aggregate public barrel is excluded as an entry point and cannot be imported by an internal
package.
