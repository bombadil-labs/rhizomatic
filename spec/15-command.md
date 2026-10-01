# Rhizomatic command intake and library boundary specification

SPEC-15 — adopted command profile 1. Baseline: `454e7ac` (`rhizomatic-after`).

This is the implementation contract for the first portable command profile and the boundary acceptance framework for Rhizomatic's libraries. It resolves the working choices in the earlier intake design proposal (historical, outside this repository). It does not claim that the witnesses already implement them. MUST, MUST NOT, and REQUIRED describe acceptance requirements for this work. Existing normative specifications retain their meaning; contradictions require an explicit amendment and vectors, not an implementation workaround.

The [handoff](../contracts/command/HANDOFF.md) defines milestones. [BOUNDARIES.json](../contracts/command/BOUNDARIES.json) assigns each library its responsibilities and proofs. [ACCEPTANCE.json](../contracts/command/ACCEPTANCE.json) lists required scenarios; these are test specifications, not passing vectors. [CI.md](../contracts/command/CI.md) specifies enforcement, including the randomized composition plan in [TOWERS.json](../contracts/command/TOWERS.json). The earlier 18-case probe remains a design experiment and is superseded where this document differs.

## 1. Objective and scope

**R-01 — Semantic boundary.** Every externally meaningful interpretation choice MUST have a portable description, or be explicitly classified as an intrinsic or a granted host capability. Native objects, compiled programs, indexes, and caches MAY implement those descriptions. Native implementation types need not become wire formats. No library may require an undeclared application callback to determine a portable profile's meaning.

Commands are the umbrella concept. Retain and evaluate are command kinds. Operation declarations describe supported kinds; requests describe invocations. Functions, bindings, applications, and results can be described by deltas. Admission of a description does not itself invoke, install, or activate it.

**R-02 — First delivery.** Implement `rhizomatic.command/1` in TS and Rust, including retain, evaluate, operation discovery, represented results, durable admission, and explicit composition. Preserve existing L0–L4 conformance. Elixir and Haskell retain their declared levels; this work does not require them to implement intake.

This delivery excludes runtime operation installation, arbitrary artifacts, reactive scheduling, materialization commands, effective erasure commands, bundle authorization, general transactions, subscriptions, transport servers, structural program introspection, full HyperView transport, and Loam changes. Existing implementations of these mechanisms remain governed by their current contracts. Library cards record later portability obligations separately from this delivery's acceptance.

The first profile is a small, fixed bootstrap of two operation kinds. Its common invocation framing is extensible through separately versioned profiles; it does not claim arbitrary code execution.

## 2. Decisions fixed for this delivery

**R-03 — Decisions.** The following are requirements, replacing the proposal's tentative choices:

| Question | Decision |
| --- | --- |
| Entry point | One explicitly addressed request delta per invocation |
| Operation selection | Exact installed declaration delta ID |
| Installation | Explicit boot configuration; receiving declarations cannot install them |
| Invocation/support retention | Ephemeral unless explicitly named as retain payload |
| Admission | Atomic offer of signed loose payload through the existing ordinary journal |
| Retry | Re-evaluate every attempt; no command-ID response cache or exactly-once claim |
| Composition | A later request can require the journal head returned by an earlier command |
| Evaluation source | Current complete admitted set, or the installed catalog, captured explicitly |
| Historical evaluation | Explicit evaluation time over the captured current set; not historical storage retrieval |
| Definitions | Explicit signed definition acts and complete supplied reference closure |
| Selection among conflicting names | Refuse ambiguous registry input; never pick by packet order |
| Principal interpretation | Explicit named core/sameAuthor/rootOrSameAuthor profiles |
| Result representation | Canonical existing View bytes in a signed outcome delta, with a strict reader |
| Cross-language proof | Shared vectors plus actual mixed-witness construction/execution/readback |
| Bootstrap recursion | Enumerated intrinsics and pinned definitions; no claim of zero native semantics |

The probe's `after` field and success cache are NOT part of profile 1. They do not acquire durable semantics implicitly. Exact-head composition is deliberately narrower than a workflow scheduler: intervening commits cause an explicit precondition failure.

## 3. Bootstrap and endpoint configuration

**R-04 — Bootstrap inventory.** Publish a finite inventory identifying: delta/CBOR codecs, content addressing and signatures; command shape decoding and dispatch; existing algebra and resolution semantics; schema-definition decoding and registry construction; the three evaluation interpretation profiles; journal admission and consistent snapshot capability; response signing. Identify the existing `HyperSchemaSchema` and `SchemaSchema` programs by their canonical pins. Native gather, selection, decoding, validation, and execution stages MUST be named separately. No recursively named meta-schema is required unless it performs a distinct interpretation.

**R-05 — Endpoint configuration.** Each endpoint loads one signed configuration delta, supplied through a local boot capability. Its author MUST be the receiving peer's governing key and its receiver MUST match that peer. The receiver's key and the act of selecting a configuration are bootstrap trust inputs; the configuration cannot authenticate its own installation. The runtime retains the exact selected configuration for its lifetime. Changing it requires a new endpoint instance and configuration ID. Its claims MUST be valid at every new invocation's receiver time. The wire-visible configuration is reconstructible, but paths, locks, private keys, and cache layout remain host-local capabilities.

Configuration supplies the allowed caller key set, installed operation declaration IDs, total ordinary admission quota, and request resource limits. Authorizing a caller grants it both operations and access to the entire admitted source and catalog in this profile. Fine-grained source access or per-operation permissions require another explicitly named profile; do not implement invisible native filtering.

Peer initialization is an explicit boot action through the existing durable capability. An admitted-source query does not lazily create a peer or synthesize a journal. After boot, loss of store availability can refuse admitted-source operations while leaving catalog evaluation available.

Operation declarations MUST be signed by the peer key, valid at invocation time, referenced by the selected configuration, and have exactly the supported intrinsic contracts in section 5. Profile 1 requires exactly one retain and one evaluate declaration. Their signatures establish attribution; their presence in the selected configuration establishes installation. Supplied lookalikes or declarations signed by another key cannot replace them.

## 4. Delta grammar and framing

**R-06 — Common grammar.** All roles below are prefixed with `VOCAB_PREFIX + ".command."`, whose standard value is `rhizomatic.command.`. Tables show suffixes. No change to the Delta wire format is permitted. All command/configuration/operation/outcome descriptions are signed deltas using existing ID/signature rules.

Notation: `text` is a primitive string; `number` is a finite primitive number; `integer` is a nonnegative safe integer; `ref` is a DeltaRef with no context; `entity` is an EntityRef with no context. Bytes targets carry exactly the MIME specified below. `1`, `?`, and `+` mean exactly one, zero or one, and one or more pointers. Repeated set-valued references or keys MUST be distinct; duplicate arguments are malformed even if equal. Unknown roles, target kinds, contexts, or enum values are refused, not ignored. Arbitrary roles inside payload deltas remain legal.

All delta IDs, program pins and digests MUST have the existing canonical content-address spelling (`1e20` followed by 64 lowercase hexadecimal digits). Journal heads use that spelling or the empty initial head. Receiver IDs and author keys use the existing canonical `ed25519:` spelling. Readers enforce these domains wherever the tables say ID, pin, digest or head, not merely string type. Profile names and vocabulary values shown with `rhizomatic` use the configured standard vocabulary prefix consistently.

| Configuration role | Cardinality/type | Meaning |
| --- | --- | --- |
| kind | 1 text | `endpoint/1` |
| receiver | 1 entity | Canonical receiving PeerId |
| caller | + text | Allowed canonical Ed25519 author keys |
| installed | + ref | Exactly the retain and evaluate declaration IDs |
| quota | 1 integer | Maximum charged ordinary membership under this endpoint's admission profile |
| max-deltas | 1 integer | Positive maximum delivered appearances, before deduplication |
| max-bytes | 1 integer | Positive maximum sum of canonical claims bytes plus decoded signature bytes, counted per appearance |

**R-07 — Request grammar.** A transport or local caller supplies `(entryId, delta appearances)`. `entryId` MUST be a canonical delta ID. It selects exactly one described invocation; it is not an operation tag. Delivery order has no semantic meaning. Every named support delta MUST be supplied in this invocation; no silent ambient-store lookup. References inside payload data are not support dependencies and may be unresolved.

| Common request role | Cardinality/type | Meaning |
| --- | --- | --- |
| kind | 1 text | `request/1` |
| receiver | 1 entity | Endpoint PeerId |
| configuration | 1 ref | Exact selected configuration ID |
| operation | 1 ref | Installed operation declaration ID |
| expected-head | ? text | Exact expected journal head, including empty string for the initial head |

Retain adds one or more `payload` refs and no evaluation arguments. Evaluate adds exactly the arguments in section 8. To store a request description, a separate retain invocation names that request as payload; its storage never causes a second invocation. An invocation cannot practically include its own content address in its signed claims. A payload may describe another request, definition, or operation without activating it.

**R-08 — Appearance validation.** First decode using strict existing Delta and JSON-debug-profile rules, enforce limits, and verify content IDs and signatures of EVERY supplied appearance. Only then deduplicate by ID. When multiple valid canonical signatures authenticate the same claims and ID, select the appearance with the lexicographically smallest signature bytes, preserving that supplied signed delta without re-signing. An already admitted ID remains a duplicate and its stored appearance is not replaced. An invalid appearance sharing an ID with a valid appearance or an admitted delta invalidates the delivery. An exact repeat of a valid appearance is permitted and counts toward limits. Do not rely on `DeltaSet.add` to validate duplicates. Snapshot/copy untrusted native objects before use; callers cannot mutate a verified request between checking and execution.

After deduplication, every supplied delta MUST be reachable as the entry itself or through its direct `payload`, `hyperschema`, `schema`, or `definition` arguments. There is no implicit traversal of arbitrary payload pointers. Extraneous supplied deltas are refused as `unexpected-support`. Configuration and installed declarations come from the selected endpoint catalog; redundantly supplying them is unexpected support unless also explicitly retained as payload. Missing requested definitions or payloads are `missing-support`.

Invalid entry IDs or unparseable transport framing yield a typed local transport error before a command response can be addressed. For a canonical entry ID, the endpoint can sign a refusal even when the named delta is absent or invalid. A refusal never claims that the requester authenticated successfully. The first delivery specifies a local invocation interface and a fixture transport, not an HTTP protocol.

**R-09 — Canonical description construction.** Writers emit fields in table order; repeatable fields sort by target ID/key using UTF-8 byte ordering. Readers accept any pointer order, applying the same meaning. Reordering pointers changes a signed request's ID under existing Delta rules; equivalent argument meanings do not imply byte-identical response deltas when the request reference differs. Readers never repair or re-sign incoming deltas. Fixtures comparing full responses MUST hold the request ID, signer, receiver time, source, and configuration constant.

## 5. Operation declarations

**R-10 — Operation grammar.** Declarations contain these roles, in order:

| Role | Cardinality/type | Retain / evaluate value |
| --- | --- | --- |
| kind | 1 text | `operation/1` |
| name | 1 entity | `rhizomatic.command.retain` / `rhizomatic.command.evaluate` |
| interpreter | 1 text | `rhizomatic.command.retain/1` / `rhizomatic.command.evaluate/1` |
| input-contract | 1 text | Same as interpreter |
| output-contract | 1 text | `rhizomatic.command.outcome/1` |
| effect | 1 text | `admission` / `none` |
| replay | 1 text | `re-evaluate/1` |
| dependencies | 1 text | `explicit-support/1` |

Declaration decoding MUST verify these combinations at installation. A runtime does not trust an arbitrary `effect: none` claim about executable code. Profile 1 maps these exact intrinsic contracts to known behavior. Unknown interpreters cannot be installed in profile 1; a request selecting an uninstalled ID returns `unsupported-operation` without invoking a handler.

**R-11 — Catalog.** The catalog source is the delta set containing the selected configuration and its two installed declarations. It is not a scan of all persisted operation-shaped deltas. Its membership digest is computed as in section 8. Ordinary evaluate commands can read it using ordinary HyperSchemas and resolution Schemas. No command-discovery-only JSON schema or native reflection API may be necessary to recover its public descriptions. Catalog evaluation does not require opening the admitted source; admitted-source unavailability must not prevent supported catalog reads.

## 6. Attempt semantics, validation and failure

**R-12 — Explicit execution context.** Capture one finite `receivedAt` observation per attempt, obtained through a host clock capability. Use it for request/configuration/declaration validity, admission arrival time, and response claims timestamp/validFrom. Requested evaluation time is a separate input. Caller timestamps do not set the receiver clock. A request is authorized only if its verified author is in the selected caller set, receiver/configuration references match, and all selected descriptions are currently valid. The request author is not an authenticated sending peer: profile 1 records ordinary remote arrival as `unattributed`, not as the payload author or a claimed peer. Local administrative use does not silently change this wire profile's semantics.

**R-13 — Validation order.** Stop at the first failing stage: transport shape and limits; supplied appearance validity; entry presence and common grammar; request validity; receiver/configuration match and caller authorization; installed operation selection; operation-specific shape and support closure; source acquisition and preconditions; program/registry validity; execution. Resource-limit has priority over per-appearance signature failures when the count/size bound can already be established. Within a stage, return its stable category code rather than whichever detailed native exception happens first. Receiver/configuration mismatch precedes unauthorized. Operation-specific shape/support validation prioritizes invalid-arguments, then missing-support, then unexpected-support. Check appearance count first, decode every appearance before computing total canonical size, then check the canonical byte limit, then IDs and signatures; an undecodable appearance is invalid-appearance because its size is undefined. This order is independent of appearance enumeration. Multiple signature failures yield one `invalid-appearance` code. Malformed operation arguments yield `invalid-arguments`. Definition/registry subcategories are specified in section 9. Native exception strings are not wire-stable error codes.

Shape/decode failure before canonical sizes can be computed is `invalid-appearance`; a transport may separately enforce a raw byte cap before invoking this API. Request validity is `validFrom <= receivedAt < validUntil`, with absent upper bound unbounded. Expired repeat invocations are refused normally; there is no successful-response cache that bypasses new authorization checks.

**R-14 — Outcomes.** Status is exactly `completed`, `refused`, or `indeterminate`. `refused` means this attempt performed no semantic effect. `indeterminate` means an admission attempt may have committed but the receiver cannot confirm its durable outcome. A conflict or known pre-commit rejection is refused. Existing `committed-unconfirmed` is indeterminate. Unknown errors after dispatch to storage MUST NOT be represented as known refusal. Signing or transport failure after a commit can prevent delivery of any response; lack of a response says nothing about commitment. Read-only failures can be refused because they have no semantic effects.

Implementation faults MUST remain visible to tests and host diagnostics. Do not blanket-catch a programming defect and make it a normal successful command. Portable refusals use stable categories; host diagnostic strings stay outside canonical outcomes.

**R-15 — Repetition.** Every attempt validates current authority, captures current source state, and runs again. Identical request IDs do not imply identical execution instances or outcomes. Retain deduplicates payload through durable journal membership, not a request-ID table. Duplicate-only retain creates no new arrival/frame. Repeating evaluate reads the newly captured source unless a precondition refuses it. Configuration changes, expiry, erasure/refusal history, or changed input can change a repeat's answer. Profile 1 promises neither cached responses nor exactly-once invocation. No new persistent invocation journal is required.

## 7. Retain and the durable peer

**R-16 — Admission binding.** Retain offers the distinct named payload deltas, sorted by ID, as one atomic signed-loose transfer to the existing ordinary journal facade. Preserve original claims, IDs, and signatures. The caller's signature cannot substitute for payload signatures. The request and support descriptions enter durable admitted membership only if explicitly named as payload. No parallel raw write path is permitted.

All payload is inert ordinary testimony in this operation. No payload shape triggers installation, function execution, effective erasure, or bundle authorization. Signed manifest-shaped testimony may be stored, but cannot authorize unsigned members. The ordinary facade's erasure classifier for this explicitly inert profile is always false; an effective erasure needs a separately supported command/profile. Existing permanent-refusal history still prevents re-entry. This choice concerns the new command profile, not a change to the existing erasure API.

Use no application guards in this profile. Compute ordinary capacity as `max(0, configuration.quota - durableState.quotaUsed)`, subject to the existing safe-integer domain. The quota value is a declared endpoint policy. Existing signed-loose quota ordering and negation closure still apply. In atomic mode any non-admitted/non-duplicate candidate causes refusal of the entire offer; prospective `admitted` planner classifications are not reported as completed admissions.

**R-17 — Commit and recovery.** The journal remains authoritative for admission, arrivals, refusals, erasures, and purge state. A completed retain outcome is emitted only after the facade confirms durable commitment or a confirmed duplicate-only no-op. Report before/after heads and source membership digests, sorted admitted IDs, and sorted duplicate IDs. On conflict or uncertain commit, discard/reopen the invalidated facade before another attempt. Do not silently retry against a different head within the same attempt. Caller retries start a new attempt under R-15.

Boot MUST preserve the existing refusal of rows without a journal. No migration, import-from-raw-rows, or state reconstruction from a reactor is part of this delivery. Crash tests cover before append, successful durable append before reply, failed/uncertain acknowledgment, reopen, duplicate retry, and refusal after an intervening erase.

## 8. Source capture, preconditions and evaluation arguments

**R-18 — Coherent source.** Admitted-source evaluation MUST capture one complete, verified journal-authorized delta set and its journal head. It MUST NOT read from a stale independent reactor, raw storage scan, or union of current and excluded rows. Concurrent in-process attempts must be serialized around state capture/admission; external writers remain protected by journal CAS. The first implementation may open a fresh facade for each attempt and use bracketed head reads: read verified journal/state/rows, verify the head still matches, or refuse `source-changed`. An optimized retained facade must prove the same behavior. A changed head during acquisition is not silently repaired by combining snapshots.

A read is defined at its captured basis, not at response delivery. A later commit can coexist with a valid reading of the earlier captured snapshot. No retroactive revocation of an already captured result is promised. Any unavailable admitted row produces `source-unavailable`; returning a silently incomplete source is forbidden in profile 1. Retain also requires complete captured state in this first profile; this narrower command contract does not remove the facade's existing writable-degraded API. A successful query has no admission, installation, or registration effects; read caches are permissible.

**R-19 — Preconditions and composition.** If `expected-head` is present, an admitted-source read or retain MUST compare it with the captured head before execution. A mismatch is `precondition-failed`. Retain's final CAS must still use that same head. Catalog requests MUST NOT include expected-head. No historical head lookup or ancestor test is implied. Head changes from rebase also invalidate the precondition even if membership is unchanged.

The supported composition is: retain completes at head H; a subsequent evaluate carries `expected-head = H`. If nothing intervenes, it reads that committed state; otherwise it refuses. The receiver checks its own authoritative head, not a supplied receipt's claim. This requires no persistence of the first invocation. Independent callers may coordinate using H, but possession of H does not grant access.

**R-20 — Evaluate grammar.** Evaluate adds:

| Role | Cardinality/type | Meaning |
| --- | --- | --- |
| source | 1 text | `admitted` or `catalog` |
| expected-digest | ? text | Expected captured source membership digest |
| root | 1 entity | Entity root of this evaluation |
| at | 1 number | Evaluation time, always explicit |
| interpretation | 1 text | `core/1`, `principal-sameAuthor/1`, or `principal-rootOrSameAuthor/1` |
| hyperschema | 1 ref | Supplied top-level HyperSchema definition act |
| hyperschema-pin | 1 text | Exact canonical term content address |
| schema | 1 ref | Supplied top-level resolution Schema definition act |
| schema-pin | 1 text | Exact canonical Schema content address |
| definition | zero or more refs | Additional complete-closure definition acts, distinct from top-level refs |
| bindings | 1 bytes | `application/cbor`; canonical string-to-Primitive map, including explicit empty map |

The common fields precede these fields when constructing a request; ordering here is the canonical writer order. `root` cannot also appear as a variable key in bindings. All variables other than the explicit root MUST be bound; unbound variables are `invalid-program`. No ambient session variables exist. Support definitions do not enter the source data set unless independently present there through admission. Supplied data overlays are unsupported.

**R-21 — Basis identity.** A source membership digest is `contentAddress(canonical CBOR array of sorted distinct delta IDs)`, matching the current `DeltaSet.digest` helper. Give it the explicit profile name `delta-membership/1`; do not confuse it with another peer/pack digest. A catalog has a digest but no journal head. Expected-digest mismatch is `precondition-failed`. A digest identifies membership; it does not ensure source retrieval or bind detached signature bytes. Every source appearance must still verify under the selected signed-source profile.

Evaluation outcomes MUST identify source kind, digest, and admitted head where applicable; selected configuration and operation IDs; evaluation time and interpretation; root and bindings via the referenced request; top program pins; and a definition membership digest of the exact distinct definition acts used to build the registry. Another witness reproduces an answer from the request, context, and available source/definition deltas. The result description alone is not a copy of the source database.

## 9. Definition closure and interpretation

**R-22 — Definition loading.** Each selected support definition MUST be a signed, currently valid-at-`at` canonical HyperSchema or resolution Schema definition using existing SPEC-3 vocabulary, `alg = 1`, and exactly its required definition fields. Load the exact named act, not the latest ambient entity definition. Foreign authors are allowed: the authorized request explicitly selects a program; its selection does not make that author's other claims trusted. Validate its canonical blob using the existing parser and re-encoding rules. Preserve the original signed act and content pins.

Construct the registry from the top-level definitions and all explicit `definition` refs, in delta-ID order. Both named and pinned references follow existing registry semantics. Conflicting duplicate names within a definition kind are refused, including same-name duplicate publications; duplicate signed IDs already deduplicated in framing are not separate definitions. Distinct names may share canonical content under existing registry rules. Name resolution uses only this supplied registry. It never consults globally registered names. Reject missing references, unsupported algebra versions, illegal program sorts, and schema-reference cycles under SPEC-3. Reject extra unreachable definitions rather than allowing unrelated input to alter registry selection. Include all references in nested terms, predicates, orders, embedded resolution Schemas, and expansion Schemas; a top-level-only walk is insufficient.

Validation order within this stage is: individual definition shape/canonicality/version/time; top pin mismatch; duplicate names; missing or unreachable dependencies; illegal reference cycles; unsupported/unbound program features. Stable codes respectively: `invalid-definition`, `pin-mismatch`, `ambiguous-definition`, `definition-closure`, `definition-cycle`, `invalid-program`. Within one category do not expose enumeration-dependent native messages. Reference discovery and registry validation belong to their semantic owners, not an intake copy of the evaluator.

**R-23 — Interpretation profiles.** `core/1` uses existing core algebra/resolution and refuses a program containing `actsFor` anywhere in its executable closure. `principal-sameAuthor/1` and `principal-rootOrSameAuthor/1` use the existing principal resolver with that exact suppression policy, the captured source set, and both principal time inputs set to request `at`. `actsFor` roots, exact/prefix scope rules, and scopes remain explicit in the signed programs. A principal profile does not grant command permission; endpoint caller authorization remains R-12.

Lower predicates throughout top-level gather, top-level resolution Schema, and all dependency programs, including predicates in orders and nested terms. Preserve original registry pins while evaluating lowered bodies. The policy must not change the meaning of standard non-principal predicates or use private user/account state. The native adapter is an implementation of this named profile, not an extra semantic input. Tests MUST distinguish the two suppression profiles on the same evidence and exercise nested references.

**R-24 — Evaluation.** Evaluate the selected gather to an HView at the supplied root/time, then resolve through the selected resolution Schema. Keep existing term, validity, negation, ordering, expansion, and resolution semantics unchanged. A top-level definition of the wrong sort is refused. No hidden filesystem/network access, clock read, key lookup, or additional store read may occur during interpretation. Physical limits may abort execution as `resource-exhausted`; they cannot substitute a truncated successful answer. Such aborts are host observations, not deterministic semantic outputs claimed across unequal resource budgets.

## 10. Outcome grammar and result codec

**R-25 — Outcome delta.** The endpoint signs one delta whose claims timestamp and validFrom are `receivedAt`, with no validUntil. Its author is the endpoint key. Pointer order is:

| Role | Cardinality/type | Meaning |
| --- | --- | --- |
| kind | 1 text | `outcome/1` |
| receiver | 1 entity | Actual endpoint PeerId |
| configuration | 1 ref | Selected endpoint configuration |
| request | 1 ref | Canonical addressed entry ID, even for refusal |
| status | 1 text | `completed`, `refused`, or `indeterminate` |
| result | 1 bytes | MIME `application/cbor`; canonical outcome map below |

The referenced request carries operation and arguments. Outcomes are receiver testimony; they do not impersonate original payload authors. Return them without automatically admitting them. Outcomes cannot install state or establish that a foreign peer committed locally.

**R-26 — Outcome body.** Encode using existing deterministic CBOR rules, maps with string keys, finite numbers under the existing numeric profile, no null values, no duplicate/unknown keys, and exact re-encoding validation on read. Required maps by status:

- Completed retain: `{kind: "retain", beforeHead: text, head: text, beforeDigest: text, digest: text, admitted: [ID...], duplicate: [ID...]}`. Both ID arrays sort lexically and partition the distinct offered IDs. No implied partial commit.
- Completed evaluate: `{kind: "evaluate", source: text, digest: text, definitionDigest: text, at: number, interpretation: text, hyperschemaPin: text, schemaPin: text, value: bstr}` plus `head: text` for admitted source only. `value` contains canonical View bytes, not JSON or a second base64 encoding. A complete result reader MUST decode them through R-27.
- Refused: `{code: text}`. No fabricated head, prospective admissions, partial value, or native error message. Codes are the stage categories in this spec, plus `entry-missing`, `invalid-request`, `request-outside-validity`, `configuration-mismatch`, `unauthorized`, `unsupported-operation`, `missing-support`, `unexpected-support`, `admission-rejected`, `write-conflict`, `source-changed`, `source-unavailable`, `precondition-failed`, `resource-limit`, and `resource-exhausted`. Transport shape errors without a canonical entry ID remain local errors.
- Indeterminate: `{code: "commit-unconfirmed"}`. Do not claim a committed head without confirmation. Recovery follows reopen and a new attempt; no outcome lookup command is invented.

Wrong receiver or configuration references produce `configuration-mismatch`; a valid caller absent from the allowed set produces `unauthorized`. Invalid common role/cardinality/target shape is `invalid-request`. Invalid selected configuration/declaration at invocation time is `configuration-mismatch`; invalid boot configuration prevents endpoint startup.

Request validity failure, including a request whose validFrom is still in the future, is `request-outside-validity`.

Outcome readers enforce these exact status/body combinations, field domains and sorted/distinct ID arrays. Admitted and duplicate arrays MUST be disjoint. Given the request, validate their union against offered IDs; without the request a reader can validate structure but cannot attest that partition's completeness. A receiver signature establishes who issued the outcome, not independent proof that the peer performed its claimed transition.

**R-27 — View readback.** Implement a strict reader for the EXISTING canonical View encoding in resolve-kernel, with no change to existing canonical bytes. Preserve strings, finite numbers, booleans, arrays, object maps, and bytes leaves. A bytes leaf is exactly a map with text `mime` and byte-string `value`; a similarly spelled ordinary object whose value is text remains an ordinary object. Reject null, unrecognized CBOR types, duplicate map keys, malformed bytes leaves, invalid numeric values, and noncanonical representations. Re-encoding the decoded View MUST reproduce the original bytes. Tests include nested bytes leaves, empty maps/arrays, reserved-looking object keys, and negative zero according to the existing canonical number rules. JSON debug rendering is not a lossless replacement for this reader.

Keep two reader stages explicit: command-data validates the outer outcome description and returns an opaque `value` byte string; the complete result reader in command composes that reader with resolve-kernel's View decoder. Do not make command-data import resolve-kernel or duplicate its value semantics. A successfully decoded outer description alone is not a successfully validated evaluation result.

This closes a bounded View transport contract. It does not close full HyperView reconstruction or structural queryability of embedded bytes. Those remain separate, visible library obligations.

## 11. Package boundaries

**R-28 — Ownership.** Preserve the existing twelve semantic packages. Add a `command-data` source boundary for shape/description codecs, depending only on delta. Add `command` above command-data, schema-load, schema, resolve, resolve-kernel, principal, syntax, delta, and federation. It binds existing capabilities; it does not own their internal algorithms. No existing lower package may import command or command-data merely to learn about callers. View decoding belongs in resolve-kernel. Definition reference analysis belongs in syntax/schema as appropriate. Coherent journal source acquisition belongs in federation. No new npm distributions or Rust crates are required.

Rust may retain its module layout; the boundary manifest maps modules to the same semantic owners. Type-only dependencies count. Capability parameters are permitted for host effects, but semantic policy callbacks in a portable profile MUST resolve to named declared profiles and supplied data. Existing general native APIs can remain available with an explicit native-extension classification; their mere existence does not establish portable conformance.

**R-29 — Boundary cards.** Each library MUST have a card covering: responsibility; allowed downward dependencies; lower data/semantics it binds; upper operations/results/refusals; intrinsic semantics and host capabilities; observable state and reconstruction; forbidden application semantics; vector/parity/composition evidence. Each exported semantic API MUST map to a card contract or an explicit native-only/compatibility classification. Helpers do not each need a new delta encoding. Classification cannot hide a semantic choice exercised by the portable command profile.

The manifest distinguishes immediate delivery requirements from later target obligations. A library with deferred HView/derivation/materialization binding work cannot be reported as completely portable merely because its import graph passes. No percentage-ready score or single global “architecture green” badge is authorized by these checks.

## 12. Conformance and completion

**R-30 — Shared evidence.** Materialize every scenario in ACCEPTANCE.json as shared concrete vectors or explicitly named executable integration tests before declaring its milestone complete. A test specification is not an executable vector. Both TS and Rust load the same semantic fixtures and compare canonical output bytes where specified. Expected values MUST be independently reasoned and reviewed; copying one witness's output to expected files does not establish correctness. Property and hostile-input tests complement fixed fixtures.

**R-31 — Mixed witnesses.** Run TS construction → Rust execution → TS outcome readback, and Rust construction → TS execution → Rust readback. Exchange serialized deltas only; do not share native objects or fixture-construction closures. Include retain/evaluate sequencing, catalog discovery, nested definition closure, principal suppression, bytes results, and explicit refusal. For matching receiver identities, configurations, observations, and durable initial state, canonical outputs MUST match; real peers with different signing keys are compared by validated semantic results and attribution, not by impossible whole-signature equality.

**R-32 — Enforcement.** CI validates package edges, contract inventory, scenario coverage, witness capability declarations, canonical conformance, composition, and durable fault tests. Test discovery must fail closed for a missing/renamed vector or skipped required case. Negative fixtures must demonstrate that the boundary/coverage checkers reject forbidden edges, missing contracts, unsupported claims of capability, and changed semantics. Existing checks and vector/doc freshness remain required. CI cannot prove that every abstraction is tasteful; independent review examines native-policy classification, bootstrap sufficiency, and whether contracts merely rename host-specific behavior.

**R-33 — Compatibility and completion.** Add this profile without changing existing Delta/term/Schema/View bytes or silently changing established evaluator/admission semantics. Existing APIs remain unless a separately documented break is necessary. Preserve the established witness-level declarations and add explicit intake profile capability metadata; do not infer intake support from L4. The implementation is complete only after all M0–M4 requirements in HANDOFF.md pass in both required witnesses, existing gates pass, and an independent review assesses the frozen implementation against this spec. No Loam migration, release, or deployment is part of that completion claim.

**R-34 — Randomized mixed-language towers.** In addition to fixed conformance and the two fixed mixed-witness routes, CI MUST execute three seeded language assignments over each selected end-to-end scenario. A tower is an assignment of a conforming witness to each executable semantic stage in the scenario's dependency graph. It need not be a linear stack: repeated calls, callback adapters and shared dependencies follow the declared graph. All three towers receive the same initial state, signed inputs and explicit host observations, execute in isolated state, and must produce the specified semantic/canonical outcomes.

Selection MUST respect per-contract, per-version capabilities, not infer support from a language name or conformance level. Each crossed boundary MUST have a declared lossless/reconstructible wire contract. No native object handles, shared registries or undisclosed test-only payloads may carry meaning across it. Unsupported boundaries remain visible gaps; a runner cannot silently substitute the same-language implementation or omit a stage and claim it crossed that boundary. At least one language switch is required where a supported mixed route exists. Across runs, report exercised library/contract/witness edges rather than an exhaustive-coverage claim.

The first delivery starts at the boundaries it actually standardizes: request construction, description reading/validation, command execution, and complete outcome readback. Internal evaluator/HView/registry ownership is reported as an unsplit execution region until the relevant transport contracts are supplied. This initial randomized pipeline is not a proof that every internal library is interchangeable. As the ledger's bindings and the four target witnesses mature, add their executable stages without changing the harness's capability/contract rules. Elixir and Haskell may participate only in stages for which they independently advertise and pass the exact required contract; they need not gain upper-layer support in this delivery.

CI MUST retain the seed, planner version, concrete assignment graph, input/state/observation artifacts, capability manifest, witness build identities and failure output. Replaying the stored plan must require no random choice. Three agreeing towers are not sufficient evidence if all disagree with a fixed expected result. Randomized composition complements fixed vectors and review; it does not prove exhaustive substitutability.
