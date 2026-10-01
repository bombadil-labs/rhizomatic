# Shared fixture and adapter contract

This contract supplies test framing, never alternate command semantics. The normative wire is SPEC-15 and the existing signed Delta JSON debug profile.

`vectors/command/descriptions.json` has format `rhizomatic-command-vectors/1` and `cases`. Each case has a unique `id`, an acceptance `scenario`, a `kind` (`view`, `bindings`, `configuration`, `operation`, `request`, `outcome`), `input`, and `expected`. View/bindings inputs are lowercase canonical CBOR hex. Description inputs are `{id, claims, sig}` in the existing debug profile. `expected.valid` is mandatory; successful canonical fixtures have `expected.canonicalHex`; inspectable decoded values use the existing debug bytes representation. Invalid fixtures describe their independent rejection reason in `oracle`.

Adapters run `construct`, `validate`, `execute`, and `read-result` stages. They read one JSON object from stdin and write one JSON object to stdout; diagnostics go to stderr. Invocation framing has `mode`, `scenario`, `artifact` where applicable, and explicit host fixture context. The artifact is `{format:"rhizomatic-command-artifact/1",entryId,deltas:[signed debug deltas]}`. Validation returns the exact serialized artifact and a verdict; execution repeats validation independently. Execution emits a signed debug outcome delta. Read-result verifies attribution and fully decodes the View.

Only fixture context (seeds, initial durable state, receiver observations and fault schedule) may accompany a semantic artifact. No parsed native program, private registry, object handle, compiled callback, or implicit ambient source may cross a stage. Every tower uses its own durable directory. Retain/query sequences keep state only within one tower.

Capabilities are exact stage contract IDs from TOWERS.json and are marked supported only after executed case evidence. Elixir/Haskell keep L0 and do not advertise these stages.

Canonical CBOR/body assertions fix signed input identity, receiver identity, configuration, timestamp and durable state. Oracles explain expected values independently of generated output. An output generator is never its own oracle.
