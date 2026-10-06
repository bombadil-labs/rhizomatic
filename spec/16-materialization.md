# Portable evidence and maintained reads

Status: **Accepted contract and independently accepted M1 codecs; M2 batch implementation
awaits independent review. M3–M5 remain specified, not implemented or certified by this document.** Baseline:
Rhizomatic `21b209ed1b14e749a5e7cf84fd9eef4f8e592fb0`, Loam `ae0e4e21`.
This contract defines a new profile, `rhizomatic.materialization/1`. It does not amend
`rhizomatic.command/1`, its installed operations, or SPEC-1–15. Requirement IDs MR-01–MR-24
are stable. Acceptance is indexed once in [ACCEPTANCE.json](../contracts/materialization/ACCEPTANCE.json); milestone
allocation is independently frozen in [MILESTONES.json](../contracts/materialization/MILESTONES.json).

## 1. Scope, authority and compatibility

**MR-01.** TS and Rust MUST implement this profile in lockstep. Existing Delta, term,
Schema, HView and View canonical bytes and hashes MUST remain unchanged, except the bounded
previously lossy TS reserved-key bridge correction in MR-04/E23; all unaffected inputs retain
their existing bytes and hashes. Elixir and Haskell
retain L0 and MUST NOT advertise these upper ports without independent evidence. M0 produces
contracts only; M1–M5 proceed against the accepted contract and an explicit supervisor handoff. The
end of this span is
the bounded Loam trial in HANDOFF, not arbitrary functions, subscriptions or remote sources.

**MR-02.** Retaining any declaration, snapshot, request, state or outcome is inert. Only an
explicit authorized invocation of an installed intrinsic can change maintained state. Native
boot selection, key custody, source grants, clocks and atomic durable storage are trust roots,
enumerated in bootstrap.json. A signature establishes attribution; neither a structurally
verified envelope nor a receiver-signed result proves that gathering, authorization or a
storage transition actually occurred. A reviewer/oracle checks execution separately.

**MR-03.** Definition provenance and operand authority are different. Foreign signed
definition acts MAY be selected explicitly without granting their author authority over other
rows. Source authority is supplied by a configured host capture grant, never inferred from
definition names, namespaces, entity names, the request author, an envelope or a claimed URL.
The first profile uses only `core/1`; it refuses `actsFor` anywhere in the full executable
closure, including reading orders, alias trust predicates and reflected subterms. The existing
profile-1 principal modes and native Loam lowering APIs remain intact. No account-lowering
callback is smuggled into core. Gather predicates retain existing alias/reflection semantics.
Reading-order predicates (top, child and embedded resolve Schemas) must be ordinary pure
delta predicates after explicit hole substitution. Native-valid actsFor and aliased string matches
there are invalid-program after higher-priority definition/pin/closure checks, since the pure
policy kernel cannot acquire their input context. Native grammar-illegal reading-order inView
is invalid-definition at stage 7 under the existing exact reader, subject to earlier stages and
known syntax-limit precedence. A wrong pin cannot override this parsing refusal; a wrong pin
with a native-valid unsupported feature instead returns pin-mismatch. Generic M1 may preserve those native syntax shapes; new portable resolution cannot
pretend they execute. This is a new-profile support boundary, not an evaluator/hash amendment. One
root per batch gather; registrations have a finite explicit
root set. No automatic root discovery, registry lookup, name-based latest selection or network I/O.

## 2. Canonical primitives and finite limits

**MR-04.** `C(x)` is the existing deterministic CBOR encoder; `H(bytes)` is the existing
`contentAddress` (`1e20` plus 64 lowercase hex digits). Maps have text keys sorted by the bytewise lexicographic order of their COMPLETE encoded
CBOR key bytes (SPEC-1 §4.1/D4), not by raw UTF-8 text; duplicate keys, unknown keys, tags, null, undefined, indefinite lengths, integer
CBOR encodings in place of existing float numbers, non-finite numbers, ill-formed Unicode and
noncanonical re-encodings are refused. Arrays preserve order except sets explicitly sorted
below. `N` is an integral float in [0, 2^53−1]; times are finite float milliseconds, not N.
IDs/pins/digests use H spelling; keys use `ed25519:` plus 64 lowercase hex digits. Omitted
optional fields have no null/empty substitute. Text identifiers described as nonempty must be
nonempty. An absent source/control revision is represented by the empty text only where stated.

The following absolute maxima apply before allocating/recursing. Boot MAY lower them using
the exact limit names, never raise them. Count repeated occurrences, not just distinct values.

| Limit | Maximum | Counting rule |
| --- | ---: | --- |
| artifactBytes | 16,777,216 | each complete canonical envelope, snapshot, capture basis, control image or result body; also each embedded program/support artifact |
| deliveryAppearances | 8,192 | every delivered Delta appearance before dedup |
| deliveryBytes | 33,554,432 | canonical claims + decoded sig bytes per delivered appearance |
| appearances | 4,096 | selected appearance records per snapshot; distinct full appearances per envelope |
| entries | 16,384 | HVEntry occurrences across all nested nodes |
| nodes | 4,096 | root and every embedded child occurrence |
| depth | 32 | root depth 1, child depth parent+1 |
| pointers | 256 | per Delta appearance decoded by this profile, including every delivered request/support/carrier; nested originals at their assigned decode phase |
| buckets | 256 | per node, including empty buckets |
| readings | 256 | distinct full Schema appearances per envelope |
| definitions | 256 | exact signed acts per program closure |
| syntaxDepth | 64 | root syntax node depth 1; predicates/orders/terms/policies all count |
| syntaxNodes | 16,384 | all nodes in one complete program closure |
| roots | 64 | per registration |
| registrations | 64 | active plus retired entries: lifetime bound per receiver/configuration |
| components | 64 | contributing peers in one capture |
| inventoryIds | 16,384 | distinct raw/exclusion membership IDs per capture |

Strings and byte payloads are bounded by artifactBytes as well as enclosing limits. No
truncated successful result is allowed. appearances/entries/nodes/depth/pointers/buckets/readings
apply independently to EACH envelope; never sum these structural counters across roots.
artifactBytes applies to the entire result body, including all root envelopes/Views and the one
shared basis/definition closure. definitions and syntax counters apply to one complete program
closure, not once per root; roots counts the complete root partition. Snapshot appearance and
inventory counters apply to that snapshot, including the full authorized source rather than the
facts a particular root happens to use. MR-21 pins the first decode/produce stage of each limit.
A profile deliberately starts with full snapshots and full results; performance
work cannot replace these with patches or relax validation. Physical execution exhaustion is
`resource-exhausted`, distinguished from deterministic input `resource-limit`.

Syntax budgets count semantic AST occurrences in these families: Schema, Term, Policy, Order,
Pred, PPred, StrMatch, ValMatch, EntityMatch, Hole, MaskPolicy, GroupKey, SchemaRefT,
InViewExtract, and actsFor's exact/prefix policy. Root depth is 1; each semantic child adds 1.
Props/bindings maps and list containers add no node/depth; scalar constants, identifiers, metadata,
enum fields and primitive list members add zero. Leaf variants count even when serialized as
scalar shorthand (input, lexById, true/false predicates, root, drop/annotate masks, byRole/group).
A Hole in EntityMatch position is ONE node. Inline resolve.schema counts as Schema. prune.keep
'all' is an enum, but its StrMatch alternatives count. Each repeated inline occurrence counts,
independent of native object sharing; cycles reject invalid-evidence. Referenced definitions start
at depth 1 and each distinct body counts once per selected closure; reference nodes count without
inlining target bodies. M1 counts its reading's own Schema subtree. A Schema with empty props and
default pick(lexById) is 3 nodes/depth 3. Raw CBOR parser depth/safety is separate from this budget.

The following child-position table is normative and language independent. Each listed child is
visited at parent depth + 1; the JSON/native wrapper between them costs zero. “optional” visits
only a present child. Variants not listed have no semantic children. Counts and maximum depth do not depend on property map insertion order. Arrays retain authored
occurrences. No definition body is implicitly traversed through a reference.

| Family / variant | Semantic children |
|---|---|
| Schema | default Policy; each props Policy |
| Policy pick/all/conflicts; absentAs | Order; then Policy respectively |
| Order byPred; chain | Pred, then Order; each Order respectively |
| Pred match | Hole only when const is a hole (primitive/list constants cost zero) |
| Pred hasPointer; and/or; not | PPred; left Pred, right Pred; Pred respectively |
| Pred actsFor; inView | exact/prefix PrincipalPolicy; Term, InViewExtract respectively |
| PPred | optional role StrMatch, context StrMatch, targetEntity EntityMatch, targetValue ValMatch |
| StrMatch aliased | optional trust Pred |
| ValMatch vcmp | Hole only when value is a hole |
| EntityMatch, Hole, PrincipalPolicy, SchemaRefT, GroupKey, InViewExtract | none; EntityMatch hole is one node |
| MaskPolicy trust | Pred |
| Term select; union/intersect; difference | Pred, of Term; left/right Term; of/without Term respectively |
| Term mask; group; prune | MaskPolicy, of Term; GroupKey, of Term; StrMatch unless keep=all, of Term respectively |
| Term expand; fix; resolve | role StrMatch, SchemaRefT, optional reading SchemaRefT, of Term; SchemaRefT; inline Schema, of Term respectively |

This traversal counts syntax positions; it does not widen the native parser's valid grammar.
For example, inline resolve Schema nodes inside an inView policy can be budget-probed, but the
existing policy grammar still refuses reflective predicates. Raw CBOR allocation and parser
safety have separate bounds; syntax budgets are checked before native AST construction, and
native budgets before recursive serialization. A native shared object is counted at every
occurrence. Safe Rust HView/AST values contain owned children and cannot represent an object
cycle; TS must detect cycles explicitly.

Compatibility correction: TS previously lost legal '__proto__' keys by assigning them to ordinary
object prototypes in schema/CBOR JSON bridges (including nested fix bindings). Own data-property
construction preserves these keys without mutating prototypes. Previously lossy TS inputs now
match SPEC-1/SPEC-2 and Rust; their broken prior hashes are the explicit compatibility exception.
All unaffected Delta/term/Schema/HView/View canonical bytes and hashes remain unchanged.

## 3. M1: lossless HView evidence

### Materialization evaluation operational bounds (M2 amendment)

The materialization profile bounds EVERY logical HView operator result under the existing
bottom-up term semantics, including intermediates later discarded by prune. This is an
operational limit of this profile; native/default evaluation and profile1 are unchanged.
Logical result summaries carry total node and entry OCCURRENCES and maximum depth; buckets
are bounded PER NODE (including empty buckets), never summed against the bucket cap. Repeated
expansion paths count separately regardless of shared objects, memoization or optimization.

Group reserves each new bucket/entry before allocating it. Expansion evaluates children
sequentially and checks active path depth before descent. Each child operator has the global
per-result node/entry bound, not a parent's remaining allowance: an in-bound100-node child
intermediate pruned to1 may fit the parent's1 remaining slot. Before attachment, reserve the
combined parent summary including every child descendant; replacement subtracts exactly the
replaced occurrence subtree. Identity prune/fix wrappers do not accumulate charges. An
oversized logical child fails even when an enclosing prune would discard it.

At most one pending independently bounded child exists PER active evaluator frame; ancestor
partial trees and bounded child temporaries may coexist. No absence of temporary allocation
or total CPU/work quota is claimed. Known structural overflow refuses resource-limit at
stage8 before the next over-budget group allocation, descent or parent attachment. Pure input
preflight never executes this evaluator and may pass these inputs; no fallback follows the
invocation refusal. Deterministic traversal/allocation probes, not timings, check early stop.

**MR-05.** Define `rhizomatic.hview-envelope/1` as C of this exact map:

```
{format: "rhizomatic.hview-envelope/1",
 appearances: [{key: ID, value: bstr}...],
 readings: [{key: ID, value: bstr}...],
 root: Node}
Node = {id: text, props: {propertyText: [Entry...]...}}
Entry = {appearance: ID, negated: bool,
         expanded: [{index: N, child: Node}...],
         readings: [{index: N, reading: ID}...]}
Appearance = {id: ID, claims: bstr, sig?: bstr}
ReadingAppearance = {body: bstr, name?: text, alg?: finiteFloat}
```

Appearance.value is C(Appearance); claims is the ORIGINAL canonical signed claims bytes
including validFrom and optional validUntil. sig is the original detached 64-byte signature,
or absent. key = H(value), not Delta.id. ID MUST equal computeId(decoded claims). Preserve
all authored pointer roles, targets, contexts, pointer order, author, timestamp, validity and
the exact signature presence/bytes. Two signatures or signed/unsigned forms of the same ID
are separate appearances; never choose a replacement appearance or re-sign an entry. Generic
M1 permits valid unsigned native evidence with any legal native author string. When sig is
present the native encode domain requires TS `verifyCanonicalDelta(delta) === "verified"`
or Rust `verify_canonical_delta(delta) == Verification::Verified`, including lowercase author
AND native signature text. Uppercase spellings that legacy verifyDelta accepts return
`invalid-evidence`; never normalize then claim native HView byte preservation. Envelope decode
reconstructs lowercase signature text from bytes and applies the same canonical verification.
M2/M3 separately
require all source/definition/command appearances to be signed. Generic decode grants no trust.

ReadingAppearance.body is existing `schemaCanonicalHex` decoded to bytes (props/default only).
Preserve optional name and alg independently, including absence. Decode using syntax, attach
metadata, and demand exact body re-encoding. key = H(C(ReadingAppearance)). Its semantic
pin is schemaHash(decoded Schema) = H(body), which deliberately excludes name/alg. Thus
same-body/different-name readings have equal semantic pins but distinct transport keys.
Entry.readings[].reading is this full transport key, NEVER schemaHash. This
preserves Loam child resolver lookup by reading name. Same-name/different-body readings also
remain distinct in M1; the table is NOT a name registry. M2 registry ambiguity is separate.

**MR-06.** Tables sort by key, contain distinct keys, and MUST be exactly the transitive
references from root. Empty tables are legal. Entries remain in their original array order,
including repeated entries and the same appearance in different buckets/children. Empty buckets
remain present. Property map insertion order and native empty-map/absent-map representation
are not semantic: decoded maps use canonical order; expanded/readings absent natively normalize
to the explicit empty arrays above. Do not sort/deduplicate entry arrays. Native gather already
files once per delta ID per bucket and emits ID-sorted entries; transport MUST NOT change
either that evaluated behavior or valid hand-constructed array order.

Expansion and reading maps are independent index-sorted arrays with distinct indices per map;
each index must be within the original pointer array. Every expansion index must address an
EntityRef. Preserve child.id independently: a referenced body may use fix to choose a
different root, so child.id need not equal the authored target ID. Decoder does not replay
the gather program to decide that root. A reading without an expansion
at the same index is invalid. A child expansion with no reading remains valid legacy evidence;
pure envelope decode preserves it. Portable resolve refuses `missing-reading`, with no parent
reading fallback. M2 program validation refuses legacy missing-reading programs earlier as
`invalid-program`. This resolves the proposal's blanket “missing child readings” shorthand
without changing native legal gathering.

Nodes are embedded tree occurrences, not shared handles; repeated native child objects encode
repeated trees. Cyclic native objects cannot encode and return `invalid-evidence`. Missing
appearance/reading references, unused table records, conflicting keys, malformed Schema bodies,
invalid annotations/indices and non-EntityRef expansion positions return `invalid-evidence`.
Decoders enforce
limits and recursive exact re-encoding. No primitive/byte/delta pointer can be expanded by repair.

**MR-07.** H(envelopeBytes) is **transport identity**, not the existing HView evaluation
digest H(existing hview canonical bytes). For native inputs within MR-05's stated encode domain,
reconstructing an envelope MUST reproduce the original
existing HView canonical bytes and preserve all additional native evidence above. Evaluation
hash equality alone does not imply envelope equality (e.g. child reading name/alg metadata may differ).
The envelope does not independently certify the negated annotation, reading choice, input
membership or program execution. It permits a fresh witness to inspect and resolve the claimed
evidence without a private registry.

## 4. M2: sources, definitions and invocation grammar

**MR-08.** New roles use `VOCAB_PREFIX + ".materialization."`; profile 1 keeps its
existing prefix and closed grammar. All new descriptions are signed existing Deltas.
Install/replace-source/advance-time/retire
and restore require an administrator; gather/resolve/read require a caller. Tables
list writer pointer order; readers accept permutations. `ref` is context-free canonical
DeltaRef, `entity` is context-free EntityRef, `bytes` has MIME `application/cbor`, `key` is text
PeerId. Unknown roles/kinds/contexts/cardinalities/enums refuse. Set-valued repeated refs sort
by ID and are distinct; duplicate arguments are malformed. The new endpoint is independent
of profile-1 endpoint boot and MUST NOT broaden profile-1 authorization.

| endpoint/1 roles | Cardinality and exact value |
| --- | --- |
| kind, receiver | 1 text `endpoint/1`; 1 entity canonical PeerId |
| caller, administrator | caller + key; administrator + key, subset of caller |
| installed | + ref; exact gather/resolve (release A); all eight operations (release B) |
| source-binding | zero or more distinct refs; exact selected host bindings |
| limits | 1 bytes; exact MR-04 limit map, every field positive N no higher than maximum |

Boot configuration and installed declarations MUST be signed by receiver. Boot explicitly
selects configuration, signing capability, source grants and optional control store; selected
descriptions are copied and immutable for the endpoint lifetime. Configuration and selected
operation must be valid at each attempt's receivedAt (stage 3). A required source binding is
checked at stage 6 only after arguments/control identify it; unrelated boot bindings never
block retire/restore. Retire/restore require no source grant. Invalid
boot refuses startup. Installed
operation descriptions have roles `kind`, `name`, `interpreter`, `input-contract`,
`output-contract`, `effect`, `replay`, `dependencies` (all 1 text except name: entity).
kind = `operation/1`; name = `rhizomatic.materialization.<verb>`; interpreter and input-contract
= `rhizomatic.materialization.<verb>/1`; output-contract = `rhizomatic.materialization.outcome/1`;
replay = `re-evaluate/1`; dependencies = `explicit-support/1`. Effect is `none` for gather,
resolve, read, restore; `control` for install, replace-source, advance-time, retire. Exactly
one declaration per available verb. Release A MUST refuse the six unfinished verbs as
unsupported-operation. Release B installs all eight; no arbitrary handler declarations.

All request/1 descriptions start with roles: `kind` (1 text request/1), `receiver` (1 entity),
`configuration` (1 ref), `operation` (1 ref). Add only these operation-specific roles:

| Verb | Required roles after common fields | Optional roles |
| --- | --- | --- |
| gather | capture ref; snapshot ref; root nonempty entity; at finite number; serving-at finite number; interpretation text core/1; hyperschema ref; hyperschema-pin text ID; schema ref; schema-pin text ID; bindings bytes; definition-at finite number | definition refs; historical-cutoff finite number |
| resolve | evidence ref | none |
| install | expected-control text revision; registration ref; capture ref; snapshot ref; at finite number; serving-at finite number | none |
| replace-source | expected-control text revision; registration ref; expected-source text ID; capture ref; snapshot ref; serving-at finite number | none |
| advance-time | expected-control text revision; registration ref; expected-source text ID; snapshot ref; at finite number; serving-at finite number | none |
| retire | expected-control text revision; registration ref | none |
| read | expected-control text revision; registration ref; expected-source text ID; snapshot ref; serving-at finite number | none |
| restore | expected-control text revision | none |

`registration` names its descriptor delta ID, never an alias. Empty expected-control means
initialized empty control state only; expected-source is never empty. Read requires exact
preconditions; it does not auto-refresh or reinstall. Install and read return all descriptor
roots. A historical gather requires at = historical-cutoff; absent cutoff is current mode.
Historical mode cannot install; registration time policy is explicitly live-time/1.
The new native endpoint API is boot(config,installed,bindings,signer,sourceGrant,
controlStore?,diagnostics), then invoke(entryId,debugAppearances,receivedAt). receivedAt is a
finite native HOST observation, sampled once before async preparation and explicitly handed to
invoke; there is no independent endpoint clock and no ambient attempt slot. A nonfinite native
argument is a local transport error without an outcome. A wire request cannot choose/override it.
serving-at must equal this receivedAt exactly; mismatch is invalid-arguments at stage 4.
Each new attempt samples its own observation. Request author timestamps never set either clock.
Any finite at is legal, including after servingAt; historical at still equals cutoff and maintained
advance must be nondecreasing. live-time/1 means explicit time advancement, not proof of wall-clock
freshness. Loam's selected present reads explicitly use their observed now for at.

`evidence/1` roles are `kind` 1 text, `result` 1 bytes containing the completed gather body in
section 6. Its signature attests who carried the evidence, not who ran the program. Resolve
accepts supplied evidence including foreign carrier authors; access to these bytes is already
explicit. It neither acquires a source nor grants access to other source rows. Its delivery is
exactly request plus evidence, with boot descriptions already installed.
Basis.definitions is its ONLY definition source: the complete deduplicated signed closure,
INCLUDING both top HyperSchema and Schema acts, in delta-ID order. Additionally delivered
acts are unexpected-support. Missing embedded top/closure acts are definition-closure at stage 7;
malformed embedded acts are invalid-definition. It validates the
complete basis, envelope and closure independently, with no ambient registry. A gather outcome
may be wrapped by a caller as evidence without claiming receiver execution authenticity.

**MR-09.** A source-binding/1 delta has `kind`, `receiver` (entity), `spec` (bytes), all 1.
spec is exactly `{sourceId: nonemptyText, capturer: PeerId, authorityRoot: ID,
selection: {profile: "host-authorized-snapshot/1", parameters: bstr}}`.
parameters contains a canonical CBOR text-key map describing every membership parameter;
keys/values are host-defined inert data, never a serialized executable callback. The host boot
grant pins the entire binding ID and implements its selection. Bindings are receiver-signed,
explicitly selected at boot, and sourceId uniqueness is enforced. No name parses as a grant.

The explicit source capability has three operations: capture(bindingId, servingAt, cutoff?),
checkCurrent(bindingId, revision, authority, servingAt, cutoff, requiredSupport), and
reacquireSnapshot(bindingId, exactCaptureDelta, servingAt). Capture returns the exact signed
capture/authority and snapshot carrier; checkCurrent returns current; reacquireSnapshot returns
exact committed snapshotBytes reconstructed/read under that grant (no new capture signature).
Each may instead return stable unauthorized, source-changed or source-unavailable. A fresh
caller/receiver may sign a new snapshot carrier; its author is not the original capture author.
It runs host policy (e.g. Loam read closure) outside algebra. A current check must observe
physical membership as well as journal head; count equality or unchanged head cannot certify
absence. Its final successful check defines the captured authorization basis. Control CAS atomically
selects THAT basis, not necessarily the latest basis at commit. There is explicitly no atomic
source+control transaction, lock across independent peers or lease requirement. Changes before
the final check refuse; changes after it and before/after CAS may leave a newly selected basis
stale. Completed output describes that checked captured basis; the next read checks/refuses.
No unbounded retry or hidden recapture is permitted. The host must detect changes during its
local coherent capture/check; source mutation after the check is the documented race below.

requiredSupport is an explicit sorted distinct Delta-ID array, never ambient context: the exact
selected top acts plus complete original definition closure, and the descriptor ID for maintained
operations. cutoff is an explicit optional native value (not a wire null); requiredSupport is always
supplied. At stage 6, gather/install use syntactically available top/definition-role IDs (plus supplied
descriptor for install); controls use validated stored active closure/descriptor IDs. Stage 7 proves
exact reachable closure: missing/extraneous supports cannot succeed. The final check after
precomputation uses the IDENTICAL sorted/deduplicated set, never repairs it by silently adding or
removing IDs. A mismatch is definition-closure before execution; no omitted/extraneous ID can
reach a successful final check/CAS.
The host checks its existing permanent-refusal facts for these IDs; any refused selected support
returns unauthorized. It does not decode or implement erasure law in this profile. Different
programs sharing one binding/revision may thus be checked independently; unrelated support stays
usable. Equal source bytes/revision do not suppress these per-attempt checks. Permanently refused
support appearing between initial and final checks returns unauthorized with no result/CAS, even
if source revision stays equal. This support check is independent of source-revision computation,
though a real operand membership or source authority change still changes source revision. Capture/reacquisition alone
never authorize program execution. Retire/restore and structural resolve require no such check.

**MR-10.** A capture/1 delta has `kind`, `source-binding` ref, `authority` ref, `basis` bytes, all 1.
The exact authority/1 support delta has `kind`, `source-binding` ref and `spec` bytes, all 1;
spec is `{root: ID, epoch: N, context: bstr}`. root equals binding.authorityRoot; context is
a canonical text-key map containing the host's complete authorization-selection context.
Its author is the binding capturer. Its ID equals snapshot.authority. The host creates this
original authority act when its epoch/context/claim interval is selected: timestamp and validFrom
are finite host-selected epoch times, validUntil is absent or finite and greater than validFrom.
These claims, including timestamp and validity, remain byte-for-byte stable across captures of
an unchanged authority basis. Reuse that original act; do not stamp it at each observation.
Changed epoch, context, or claim interval requires a new authority ID and source revision.
Current source use validates authority at the invocation servingAt: expiry is invalid-source
at stage 6; revoked host permission is unauthorized. An authority valid at original
capture that is expired now cannot authorize a current read. This representation
is inert attributed context, not a portable execution of account law or a self-grant.
basis is C of the snapshot map below with appearances omitted, format replaced by
`rhizomatic.source-basis/1`, and one added `snapshot` ID = H(full snapshotBytes). Thus its
signature commits to payload bytes without embedding them. A snapshot/1 carrier delta has
`kind` 1 text and `data` 1 bytes containing the full snapshot. Any verified canonical signer
may carry it; its author is not the capture authority. Requests explicitly supply both refs.
Host capture yields both artifacts; each is verified independently, and their metadata and
H(snapshotBytes) must agree exactly. Control stores only capture/1, never the snapshot carrier.
Its author MUST be the installed binding's capturer; claims timestamp/validFrom equal the
capture observation servingAt; validUntil is absent or finite and greater than validFrom.
Validate capture testimony at that ORIGINAL observation, not the new invocation time:
outside its interval is invalid-source at stage 6. Malformed claim intervals instead fail existing
Delta validation: invalid-appearance at stage 1 for delivered acts, or invalid-control at stage 5
for acts embedded in a control image. On a later read a
capture may be past its interval now and still validate its original observation, but current
binding, authority and host permission checks remain mandatory. A fresh snapshot carrier is
inert data support; its signature/shape is checked, not used as a current source grant.
This is trusted testimony under a host grant, not proof of
account policy. Fresh command invocations require a current host check; serialized capture
signatures alone confer no serving authority. Remote capture acquisition and capability
delegation are excluded. Cross-language conformance supplies the same local host grant and
serialized capture to fresh independent endpoints, not a remote authentication protocol.

snapshot is the exact canonical map:

```
{format: "rhizomatic.source-snapshot/1", binding: ID,
 authority: ID, selection: ID, revision: ID,
 servingAt: finiteFloat, historicalCutoff?: finiteFloat,
 components: [{peer: PeerId, revision: ID, capturedAt: finiteFloat,
               rawIds: [ID...], operandIds: [ID...]}...],
 appearances: [{key: ID, value: bstr}...],
 operands: [{id: ID, appearance: ID, peers: [PeerId...]}...],
 exclusions: [{id: ID, peers: [PeerId...], reason: nonemptyText}...],
 membership: ID, appearanceDigest: ID}
```

appearance records use MR-05 but are all signed and verified. Components sort by peer, one
per peer; operand/raw IDs sort distinct. Operands sort by ID and select exactly one appearance
per ID: select the lexically least valid signature bytes across offered component appearances,
as SPEC-15 does. All original delivered appearances verify BEFORE dedup and limits count every
appearance. appearances is exactly the selected operand appearances; excluded bytes need not
cross the boundary. Peer sets sort distinct and must match component inventories. Union rawIds
= disjoint union of operand IDs and exclusion IDs. An ID contributed by several peers may be
an operand only from an eligible peer; the exclusions table contains only globally excluded IDs,
with exactly their raw contributing peers and one host-defined explanatory reason. Component
operandIds and operand peers say exactly which peer granted contribution. Raw-only peers never
become contributors merely because another peer supplies the same ID.

membership = existing delta-membership/1 digest of operand IDs. appearanceDigest = H(C(sorted
selected appearance keys)). selection = H(C(binding selection)); authority is an exact
delta-representable host authority-basis identity. Component revision is a host-attested,
delta-representable identity covering inventory and authority changes, not a count. revision =
H(C({binding,authority,selection,components: ComponentBases,membership,appearanceDigest,exclusions})),
where ComponentBases copies each component except capturedAt. Observation time alone does not
change revision; otherwise every currentness check would invalidate an unchanged source.
Capture transport identity still covers capturedAt/servingAt/cutoff. Same bytes under different
authority or a changed host component revision MUST have a different revision. Capture is a full
authorized snapshot, not an overlay.

Components are observed sequentially in peer order, each with its own capturedAt and revision;
there is no claim of an atomic cross-peer instant. The final host check validates that exact
component vector and authority before use. For gather, snapshot.historicalCutoff presence/value must
equal the request; M3 captures
are current-mode and must omit it. A capture may have an older servingAt than a later read;
that observation remains distinct from the new per-attempt servingAt. Components must be
nonempty and cover every contributing peer named by the binding's selection; a temporarily
unavailable peer cannot be silently omitted. The selection's host policy is responsible for
present suppression, historically eligible negations and withholding closure; exclusion IDs
are bookkeeping only and MUST NOT be fed to evalTerm as fabricated facts. A generic decoder
checks structure/digests/signatures; it cannot prove the host performed those selections.

**MR-11.** Gather's hyperschema/schema/definition roles supply exact original signed
SPEC-3 acts and complete closure, never receiver-authored substitutes. Use existing exact-act
readers and complete reference analysis, including nested predicates, aliases, orders, embedded
Schemas, fix bindings and expansion readings. At-validation, pin, duplicate-name, closure,
cycle and feature priorities match SPEC-15 R-22. Bindings is canonical existing string→Primitive
map; root cannot be a key. Definitions are loaded in delta-ID order. Definition acts must be
valid at explicit definition-at, which is independent of operand at and servingAt;
request/config/grant validity uses receivedAt. A historical read may select today's exact
definitions at servingAt while evaluating past operand validity at at, as Loam does. Identical
body/different names follow current hash semantics; duplicate names per kind remain ambiguous.

The gather body pins both halves of the program so resolve needs no newly selected reading.
Bound child readings preserve the actual fix-local environment and metadata, distinct from
original signed definition pins. Envelope schemas are claimed evaluated readings, not new
definition publications. Complete-result validation verifies signed definition closure and
pins and strictly decodes the envelope; it does not re-run gathering to prove each annotation
or child reading choice. Resolution operates on that explicit evidence. M2 core checks reject
unbound/native-valid unsupported features in supplied evaluated reading bodies too, so an envelope
cannot request native principal callbacks. These checks occur at stage 8 only after strict supplied
envelope bounds/decode and structural/contextual validation; structural invalid-evidence and
known envelope resource-limit precede the evaluated-reading feature check. Original signed
definition/program features remain stage 7 and precede all supplied envelope defects. Loam-specific custom resolvers remain outside portable resolution.

**MR-12.** Delivery is `(entryId, signed debug Delta appearances)`, copied before awaits.
Verify every appearance, then dedup as SPEC-15 R-08. Support closure is explicit: common config
and operations come only from boot; direct request refs reach evidence, registration, capture, snapshot,
top definitions and definition support. Capture reaches its authority support; registration may
reach its definitions. Resolve's embedded Basis.definitions is validated internally and does NOT
add delivered support refs: delivery is exactly request plus evidence, even when those embedded
acts are also referenced by top IDs in the body. Snapshot carriers are direct support only, never implicit
storage retention. Source-binding
comes only from boot. Nested referenced
original operands are embedded appearances, not extra delivered supports. No arbitrary payload
pointer traversal. A current control state's exact descriptor/definitions/capture/authority are omitted for
read/replace/advance/retire except the explicit new capture/authority for replace-source;
the other support comes from verified durable control, and explicitly supplying
them again is unexpected-support. Install must supply the complete descriptor closure. Missing
then extra supports refuse; no ambient registry/database lookup repairs a missing support act.

## 5. M3: represented durable control state

**MR-13.** registration/1 delta roles in order: `kind` 1 text; `source-binding` 1 ref;
`hyperschema` 1 ref; `hyperschema-pin` 1 ID text; `schema` 1 ref; `schema-pin` 1 ID text;
`definition` zero or more refs; `roots` + distinct nonempty entities sorted UTF-8;
`bindings` 1 bytes; `definition-at` 1 finite number; `interpretation` 1 text core/1; `result-kind` 1
text hview-and-view/1;
`time-policy` 1 text live-time/1; `alias` zero or more distinct nonempty texts sorted UTF-8.
Descriptor ID is its existing signed Delta.id; aliases never select, activate or route it and
may collide. Author may be foreign; install must be administrator-authorized. Roots/bindings,
selected acts, pins, source binding, interpretation and policies are immutable. Replacement
definition/program/source binding means retire the old descriptor then install a new descriptor;
no mutation behind an old identity. Descriptor validity is checked at invocation servingAt. Every
exact definition interval
is checked at the descriptor's immutable definition-at; operand validity is checked at at.
Updating the definition-selection instant requires a new descriptor, even for the same pins. Install
state is scoped to one receiver.

**MR-14.** `rhizomatic.materialization-control/1` is canonical full-state C map:

```
{format: "rhizomatic.materialization-control/1", receiver: PeerId,
 configuration: ID, generation: N, entries: [{registration: ID,
 status: "active"|"retired", transition: ID, sourceRevision: ID,
 authority: ID, at: finiteFloat, definitionAt: finiteFloat,
 hyperschemaPin: ID, schemaPin: ID, capture?: ID}...],
 deltas: [AppearanceBytes...]}
```

Entries sort by registration ID. ACTIVE entries require capture and deltas contains their exact
signed descriptors, complete signed definition closure, selected metadata-only capture/authority
and latest transition. RETIRED entries forbid capture and require ONLY their latest receiver-signed
retire transition: registration/source/authority IDs, time, definitionAt and scalar pins remain,
not descriptor/definition/capture/authority payload. Shared support remains only while reachable
from an active entry. deltas is the distinct union of those reachable supports, sorted by full
appearance key, exactly one selected appearance per support Delta.id; boot configuration and binding
descriptions are supplied by boot and not copied. No operand snapshot/carrier, old transition, index
or result persists in this control image.
Capture metadata includes inventories/appearance commitments but no operand payloads. Source
bytes are explicit disposable invocation input; a restore/read must reacquire the exact
committed snapshot through the host grant, or report source-unavailable/source-changed. A host
may reconstruct its original snapshot bytes from the signed basis metadata plus currently
available verified original rows, but MUST match the committed snapshot hash and independently
check current authority/revision. This is reconstruction, not a newly backdated capture. Every
AppearanceBytes is C(Appearance).
revision = H(imageBytes), except initialized empty generation-0 state is externally named empty
text `""`. Empty state is explicit host initialization, never lazy creation on read/restore.
Generation increments once per committed transition; overflow refuses resource-limit.
Control generation/revision is distinct from all source revisions and from the peer journal head.
The control-store key is receiver/configuration; a different configuration cannot inherit active
state implicitly. Export/restore bytes are the same canonical image, not native objects.

Each latest transition is a receiver-signed state/1 delta with roles `kind` 1 text;
`registration` 1 ref; `generation` 1 N; `prior-control` 1 text ID or empty;
`prior-transition` 1 text ID or empty; `verb` 1 text install/replace-source/advance-time/retire;
`source-revision` 1 ID text; `authority` 1 ID text; `at` 1 finite number;
`definition-at` 1 finite number; `hyperschema-pin` 1 ID text; `schema-pin` 1 ID text;
`capture` optional ref (required active; absent retired). Its timestamp/validFrom = receivedAt;
no validUntil. It describes an accepted selection, not a new operand fact. Its prior-control
references the pre-transition image; never include the resulting image's own digest (no hash
cycle). The image itself is sayable as an inert control-image/1 delta with roles kind (1 text) and
data (1 application/cbor bytes) containing the exact image. Such a retained carrier cannot
select a new store head or activate state. Current state is verifiable structure and local trusted
durable selection, not an
immutable history proof. Retired scalar fields agree with the signed terminal transition, so
restore/read/reinstall can keep retirement terminal without retrieving erased original support.
State deltas may be retained as ordinary inert testimony elsewhere.

The 64-entry bound is a finite configuration lifetime: the 65th distinct install refuses
resource-limit before CAS, known no write. Retirement never frees a slot. An administrator may
rotate using the native configuration-selection root: create a new receiver-signed configuration
ID, initialize its separate empty control scope, explicitly install only selected still-active
descriptors with complete support, fresh source checks and explicit time, then durably select that
configuration for boot and disable old endpoint serving. No retired IDs or activation are copied
implicitly. Same descriptor installed explicitly in a genuinely new scope is a new install, not
restoration of old activation. Retained old requests refuse configuration-mismatch at the new
endpoint. The old scope keeps terminal retirement on reopen.

Host activation is NOT a portable cross-configuration transaction. During preparation only the
old selected endpoint serves; the prepared endpoint is disabled. Failure/crash before durable
activation leaves the old configuration selected; new prepared state remains inert for serving.
Once the host durably selects the new configuration, old serving is disabled and restart boots
only the new one, even if the process exits before response or serving starts. The host MUST
prevent simultaneous serving endpoints around activation; its explicit durable selection is the
restart authority. Failed preparation may be inspected/reused by explicit admin attempts, never
silently replayed/copied. The selected Loam batch path does not need rotation.

**MR-15.** Control store capability: initialize(receiver,configuration,emptyBytes),
read(receiver,configuration), compareAndSet(expectedRevision,newImageBytes).
Initialize checks actual absence, returns existing exact image or durable new empty image;
cannot overwrite unknown data. Read returns one consistent complete image+revision or unavailable.
CAS atomically stores the entire metadata image; outcomes exactly:
`durable {revision}`, `conflict`, `rejected` (known no write), `committed-unconfirmed` (may
have stored either prior or new complete image). Unknown post-dispatch exceptions are uncertain,
not rejected. No partial image/descriptor/capture exposure. A native sqlite/file adapter may
implement this seam. No atomic source+control guarantee
is claimed. Do not create a second ordinary peer journal or persist operand payload copies.
The source/result cache is disposable memory; filesystem spill or retention of full snapshots
is outside this profile and would introduce separately specified erasure surfaces. Metadata
keeps IDs/commitments legitimately; this is not evidence that operand plaintext remains.
ACTIVE descriptor/definition bytes are retained explicitly as selected program support. This IS
a real host erasure surface, although control never copies operand snapshots. If a selected
act/descriptor is an erasure target, the host refuses every affected active registration's explicit requiredSupport current check, retires each through an authorized
exact-control attempt, and removes support now
unreachable from ALL active entries. Unrelated active selections remain usable. It then purges
historical control images, temp files, sqlite free pages/WAL and retained support copies on every
declared host surface under existing host purge obligations before reporting physical settlement.
No generic erasure interpreter or second peer journal is added by this profile. Shared support
cannot be settled until every active consumer is durably retired and every payload copy is gone.

A crash before retire CAS leaves active selection but serving blocked and purge owed. After durable
retire CAS, terminal state restores without targeted payload; pending historical-copy cleanup is
still owed. Uncertain retire requires reopen: absent branch stays active/blocked, present branch
retired/cleanup owed; retry uses actual observed control, never blindly deletes active support.
Payload removal before all affected retire commits would corrupt active control and is forbidden.
Host purge proof covers all physical program-support copies; terminal IDs/scalar pins legitimately
name the erased act and are not plaintext payload. A retired reopen requires no original descriptor
or definition bytes and must not repair them from retained testimony.

**MR-16.** install/replacement/time transitions first validate, acquire/check source authority
and exact capture basis, compute COMPLETE batch HView+View for every root, sign the prospective
transition, encode/bound-check the exact prospective result/image, perform the final current source
check with the identical requiredSupport set, then CAS. Prospective signed state is private/inert
until CAS selects it; a refusal never reports it as committed. Signing before final size checks
lets exact proposed image/result bytes be checked before a known effect. This precomputation avoids a known semantic error after commit; caches may still fail to build
after commit. Results/indexes are disposable. The named fault point `post-CAS-result-materialization`
occurs after confirmed durable CAS and before a successful result is materialized/signed. Even
an implementation still holding precomputed results MUST honor that point: known injected failure
returns indeterminate result-unavailable with confirmed control, never an old or completed result.
Rebuild MUST use the same original definitions, explicit full snapshot matching accepted capture metadata,
bindings and explicit at; native
incremental indexes are allowed only when batch-equivalent. A failed rebuild never rolls back
control implicitly or reports old cached output as current. Changing source replaces the selected
full snapshot basis and runtime source set, removing absent rows even if count or journal head is
unchanged. advance-time receives an explicit snapshot matching stored capture metadata; it leaves
source
revision/capture unchanged but checks its current authority and membership at servingAt. Read
also requires an explicit snapshot carrier matching the stored capture commitment. Snapshot carriers
may be freshly signed by any verified author at the new invocation time;
their original committed payload/metadata and capture signature remain unchanged. No old
native signing object is needed. A preparer that cannot reconstruct/acquire it cannot invoke a
successful read with an old result cache.
Time may stay equal or increase, never decrease (time-regression); historical batch gather remains
available independently. Registration expiry at servingAt refuses before CAS, leaving selection unchanged; a
current read likewise refuses invalid-definition at stage 7 instead of serving old output. Definition
validity remains at the represented definition-at; source validity advances at the new at.

| Operation | Precondition beyond common validation | Durable effect | Result |
| --- | --- | --- | --- |
| install | descriptor absent; valid full support; current live capture/binding | create active entry and increment generation | committed transition + complete results |
| replace-source | active exact registration; expected-source matches; proposed capture current and same binding | replace capture metadata/basis; increment generation even equal bytes | committed transition + complete results |
| advance-time | active; explicit committed snapshot; expected-source matches; at >= stored at; source current | set at; increment generation even equal time | committed transition + complete results |
| retire | active exact registration; admin; no source availability needed | terminal retired metadata; remove now-unreachable descriptor/definition/capture support; increment generation | committed transition only |
| read | active; exact control/source; explicit committed snapshot; current source grant and basis; valid at | none | full recomputed or batch-equivalent results |
| restore | exact control; consistent validated full image; no source acquisition | none | sorted restored active/retired selections and per-active availability |

Install of an existing active ID returns already-installed; install of a retired ID returns
retired. Retire of a retired ID returns retired and no new transition. Idempotence is not silently
inferred from request ID. A new descriptor ID is required for reactivation. Read of unknown ID
returns registration-missing; of retired ID returns retired. Multiwriter conflicts require
reopen/re-read, reauthorize and explicit new expected revision; no hidden rebasing or blind retry.
Capture failures do not alter state. Multiple registrations sharing a source are independent;
one registration's replacement cannot silently replace another's capture or time.

**MR-17.** Restore validates bytes, receiver/configuration, revision, signatures, exact
reachable supports, unique entries, generations (distinct nonzero latest generations <= image
generation, with exactly one
latest transition at image generation when nonempty; generation0 has no entries/deltas), transition/entry
agreement including scalar pins/definitionAt, and (ACTIVE entries only) capture revision/binding,
descriptor pins/closure and active source selection. RETIRED entries verify only receiver-signed
terminal metadata and require no erased descriptor/definition payload. It
does not fabricate missing declarations, replay ordinary retained state into activation or fetch
the latest named definitions. Restore does not treat an expired active descriptor as image
corruption; read checks its
current validity independently. Boot then marks each active entry unavailable until a fresh host
current-source/authority check succeeds. Restore reports selections even when sources are
unavailable; it never calls stale cached output current. Retired entries remain retired. Destroying
all native caches/registration objects cannot lose these selections. After uncertain CAS the
endpoint discards native state, requires reopen and reports whichever complete image is durable.
This is conditional durable state, not exactly-once execution or a request receipt journal.

**MR-18.** Failure states are observable and fixed:

| Scheduled failure | Durable image | Attempt status / next action |
| --- | --- | --- |
| capture/source check, validation, batch compute or transition signing before CAS | prior | refused stable category; host signing defect may yield no response |
| storage rejected or conflict before write | prior | refused control-rejected/write-conflict; invalidate prospective caches |
| process exits before CAS dispatch | prior | no response; restore prior |
| CAS committed-unconfirmed, physically absent | prior on reopen | indeterminate commit-unconfirmed; reopen before new attempt |
| CAS committed-unconfirmed, physically persisted | new on reopen | same indeterminate; reopen reveals new selection |
| process exits after durable CAS before rebuild | new | no response; restore new and rebuild when source available |
| post-CAS-result-materialization fault (including rebuild/index), even with precomputed results held | new | indeterminate result-unavailable with confirmed control revision; cannot claim refusal |
| response signing/delivery fault after durable CAS | new | no reliable response; reopen; cannot infer noncommit |
| source replacement during precompute before final check | prior | refused source-changed, no blind recomputation on a new source |
| source replacement after final source check, before CAS or next read | new selection, now stale | completed transition describes captured selection, not latest-at-commit; next read source-changed |
| restore/rebuild source unavailable | prior or new verified selected image | selection preserved; source-unavailable, no current value |

Read-only faults refuse with no effect. Control-store unknown outcome cannot be converted into
known refusal. Time/retirement failures follow the same before/after-CAS schedules. Request-ID
repetition revalidates authority and all preconditions and creates a new attempt; a successful
install repeated at a new expected revision is already-installed, not a cached outcome.

## 6. Complete results, errors and readback

**MR-19.** Outcome/1 roles are `kind`, `receiver`, `configuration`, `request`, `status`,
`result` in that order, matching SPEC-15 types but using the new prefix. status is completed,
refused or indeterminate. Receiver signs exact requested claims with timestamp/validFrom =
receivedAt, no validUntil. Do not auto-admit outcomes. result is canonical CBOR with exactly
one of the following shapes; all array/set sorting rules apply.

```
ComponentCommitment = {peer: PeerId, revision: ID, capturedAt: finiteFloat}
Basis = {binding: ID, revision: ID, authority: ID, selection: ID,
 membership: ID, appearanceDigest: ID, components: [ComponentCommitment...],
 at: finiteFloat, servingAt: finiteFloat, historicalCutoff?: finiteFloat,
 bindings: bstr, definitionAt: finiteFloat, interpretation: "core/1",
 hyperschema: ID, hyperschemaPin: ID, schema: ID, schemaPin: ID,
 definitions: [SignedAppearanceBytes...], definitionDigest: ID}
GatherBody = {kind: "gather", root: nonemptyText, basis: Basis,
 envelope: bstr, transport: ID, hview: ID}
ResolveBody = {kind: "resolve", root: nonemptyText, basis: Basis,
 transport: ID, hview: ID, value: bstr, view: ID}
RootResult = {root: nonemptyText, envelope: bstr, transport: ID, hview: ID,
 value: bstr, view: ID}
TransitionBody = {kind: "install"|"replace-source"|"advance-time",
 registration: ID, transition: ID, control: ID, generation: N,
 basis: Basis, results: [RootResult...]}
ReadBody = {kind: "read", registration: ID, control: ID, generation: N,
 basis: Basis, results: [RootResult...]}
RetireBody = {kind: "retire", registration: ID, transition: ID, control: ID, generation: N}
RestoreBody = {kind: "restore", control: ID|emptyText, generation: N,
 selections: [{registration: ID, status: "active"|"retired",
               sourceRevision: ID, authority: ID, at: finiteFloat,
               definitionAt: finiteFloat, hyperschemaPin: ID, schemaPin: ID,
               availability: "unchecked"|"retired"}...]}
RefusedBody = {code: StableCode}
IndeterminateBody = {code: "commit-unconfirmed"}
                 | {code: "result-unavailable", control: ID}
```

Basis.components projects only peer/revision/capturedAt from the exact capture, sorted by peer.
It NEVER carries rawIds, operandIds or exclusions. Those private inventories remain capture/
snapshot/control metadata, not public result/evidence. Basis.definitions contains the complete
deduplicated signed closure INCLUDING both top acts, in delta-ID order; definitionDigest is
existing delta-membership/1 of those distinct acts. One shared Basis appears once per body,
including once per multi-root maintained result. Batch root is adjacent to Basis; root-specific
results do not duplicate Basis/definitions. Byte totals count that actual complete body.
transport = H(envelopeBytes), hview = H(existing HView canonical bytes), view = H(existing View
canonical bytes). Root results sort by root and contain every descriptor root, no extras.
TransitionBody.transition/RetireBody.transition is the exact latest receiver-signed state Delta ID
selected by that CAS. Strict contextual readback given a control image verifies that linkage.
ReadBody has no new transition ID: it creates no effect. TransitionBody/ReadBody.control is always
nonempty because active state requires a transition. Read returns its invocation servingAt while
keeping accepted source observations and at distinct; resolve preserves gather's root/Basis rather
than rewriting them with resolve's own receivedAt. Restore scalars match active descriptor/latest
transition or retired terminal transition, respectively.
A successful restore deliberately returns unchecked availability and
no results: an ensuing read must check source currentness and authority. Whole-signature equality
requires identical keys/config/request/receivedAt; otherwise compare attribution and semantics.

**MR-20.** Complete readback composes outer Delta/body validation, strict HView envelope,
signed definition closure/pins/bindings, and existing strict View decoder. Recompute transport,
existing HView/View digests, definitionDigest and definition pins from
provided evidence bytes. Source membership/appearanceDigest, binding selection, component revisions
and source revision are receiver/host-ATTESTED commitments: result envelopes are evaluated subsets
and compact components cannot reconstruct full source inventory/exclusions. Do not claim to
recompute them from an outcome alone. When a caller supplies capture/snapshot, recompute its
commitments and compare them to Basis; otherwise contextual expected binding/revision/authority
must still match exactly but the check remains commitment equality, not source execution proof.
Check status/body pairing, request root/argument/basis agreement, control/transition linkage when
provided, and complete descriptor root partition. Without these, report only
verified structure, not a verified contextual answer. DefinitionDigest/membership do not bind
signatures; full appearance transport keys do. Verification and receiver testimony are labelled
separately from replay/oracle execution evidence. No partial JSON inspection qualifies as readback.

**MR-21.** Fail at the first stage below, independent of delivery order. Within each listed
phase, known count/byte bounds precede allocation and semantic checks; malformed data whose
canonical size cannot be obtained refuses its stage's malformed category, not an invented size.
Nested artifacts are checked at the first stage that decodes/produces them, never eagerly in an
earlier phase. After stage 8 precomputation/size checks, gather and control serving operations
repeat ONLY the stage-6 current check with identical requiredSupport, before result delivery or
stage-9 CAS; its explicit source categories still apply. New refusal/authority facts can be observed
then even if the initial check passed. No recapture/recompute occurs on that failure. Structural
per-envelope counters are separate from aggregate result bytes (MR-04).
Known deterministic limit failures are resource-limit; physical execution exhaustion is
resource-exhausted. No blanket native exception catch can substitute either.

1. Framing/canonical entry ID and finite native receivedAt (local transport errors without
   outcome); then delivered count; scan all delivered debug claims.pointers array counts without
   decoding targets or opening embedded bytes; bound each known per-appearance pointers count;
   appearance decode; canonical deliveryBytes bounds;
   full ID/signature verification: resource-limit or invalid-appearance. Count includes repeats
   before dedup. An undecodable appearance is invalid-appearance before its unknown canonical
   byte size. Unknown pointer counts (missing/malformed claims.pointers containers) are
   invalid-appearance after delivered count and before per-pointer/canonical-byte bounds; this
   scan order is independent of delivery enumeration. For known containers, any over-pointer
   appearance is resource-limit before target parsing/signature verification, even alongside a
   bad signature; repeats count before dedup. Directly delivered definition/carrier outer pointers
   are bounded here; their embedded originals still wait for their assigned phases. A lower cap
   may make a verb uncallable; reserved descriptions have no exemption. This stage does not open embedded snapshot/evidence/program/control bodies.
2. Entry presence/common grammar/validity: entry-missing, invalid-request, request-outside-validity.
3. Receiver/configuration/installed validity, then caller/admin authorization:
   configuration-mismatch, unauthorized. Only configuration and chosen operation validity are
   checked here; source bindings wait until stage 6. Lack of admin rights is unauthorized.
4. Installed verb selection, argument grammar (including serving-at/receivedAt equality), then
   missing delivered supports, then extra supports: unsupported-operation, invalid-arguments,
   missing-support, unexpected-support. Next bound-check and decode resolve's outer evidence body
   or the supplied snapshot carrier's data bytes: resource-limit before invalid-evidence or
   invalid-source when size is known. Embedded definition acts/envelopes wait until stages 7/8;
   snapshot decoding here checks only the byte bound, canonical CBOR well-formedness and format
   text. Snapshot map shape, counts and digests wait until stage 6. Resolve requires no separately delivered
   definitions. Bad arguments beat expired source bindings and missing embedded closure.
5. Required control read, image byte/count limits and decode, preconditions, registration state,
   then proposed entry-count/generation bounds: control-unavailable; resource-limit or
   invalid-control; precondition-failed; registration-missing, retired, already-installed,
   time-regression; resource-limit. A 65th distinct install or generation overflow refuses here
   before source/precompute/CAS, known no write. Malformed image beats wrong expected control.
   gather/resolve require no control. Retire needs no current source/definition validity.
6. For gather/install/replace/advance/read only: identify required binding and check native grant
   (unauthorized), then binding validity at receivedAt (configuration-mismatch); bound-check and
   decode capture basis/snapshot (resource-limit before invalid-source when bounds are known),
   validate signatures, capture/snapshot agreement, original capture interval and current authority
   interval (invalid-source); compare expected-source IF PRESENT (precondition-failed); run host
   current check with explicit requiredSupport IDs (unauthorized for refused selected support;
   otherwise unauthorized, source-unavailable or source-changed according to its explicit
   response). Supplied gather/install IDs are available syntactically here; other active controls
   use validated stored closure. Stage 7 proves exactness before the repeated final check.
   Unknown boot binding is unauthorized. Internal capture/snapshot revision mismatch
   in gather/install is invalid-source, never a nonexistent expected-source precondition. Unsigned
   embedded rows are invalid-source. Expired unrelated bindings cannot block retire/restore.
   Resolve validates compact source commitments as evidence structure in stage 8, without a grant
   or current-source/authority check; it does not certify present permission.
7. Required original definitions/program: bound-check embedded definition artifact bytes and
   bounded syntax at first decode (resource-limit; malformed syntax invalid-definition), then
   invalid-definition, pin-mismatch, ambiguous-definition, definition-closure, definition-cycle,
   invalid-program in that priority. Missing embedded top/closure acts in resolve is
   definition-closure. Active descriptor expired at servingAt is invalid-definition. Definition
   intervals use definition-at; retired restore needs only terminal metadata, not original acts.
8. Evidence/execution: first bound-check/decode supplied envelope (resource-limit before
   invalid-evidence when known), then structural/contextual evidence checks (invalid-evidence),
   resolution (missing-reading, resource-exhausted, execution-failed), then produced envelope/View/
   complete body/proposed control-image bounds (resource-limit BEFORE CAS). Gather/control
   envelope generation checks per-envelope structural limits as it produces each tree; malformed
   generated native evidence is invalid-evidence. Original signed definition features were checked
   at stage 7; supplied evaluated readings are checked here only after envelope bounds/decode
   and structural/contextual evidence validation, before resolution, with native-valid unsupported
   or unbound features returning invalid-program. Multiple root results share one Basis; aggregate bytes alone sum
   across roots. A too-large computed result is a known refusal with prior control intact.
9. Durable CAS: write-conflict, control-rejected (refused); commit-unconfirmed (indeterminate).
   After confirmed commit, post-CAS-result-materialization failure is result-unavailable with
   confirmed control (indeterminate), even if precomputed results remain held. Signer/transport
   defects may have no response. Never mint refusal after a possibly performed effect.

### Pure input-capacity preflight (release A)

`preflightMaterializationInput` / `preflight_materialization_input` is owned by command and
implements `rhizomatic.materialization/1/input-preflight`. It receives explicit copied signed
boot configuration, installed catalog and bindings, entry ID, all delivered debug appearances
and the finite trusted receivedAt. It receives no source capability, clock, signer or store.
Native malformed framing/nonfinite receivedAt produces a local transport error as invoke does.
Its exact projected result is one of:

```
{status: "input-valid"}
{status: "over-input-limit", code: "resource-limit"}
{status: "invalid-input", code: StableCode}
```

Input-valid means all supplied-input checks passed. It grants NO permission/currentness/source
access, output-capacity guarantee, execution proof or dispatch guarantee. Over-input-limit is
the only capacity exclusion; semantic refusals are errors, never native capacity fallback.
The projection visits invocation stages 1, 2, 3 (signed configuration/selected operation validity
and caller authorization), 4, 6 (supplied source structure only), 7, then 8 (supplied evidence
structure only). Stage 5/control and stage 9 are unsupported in release A. In stage 6 omit
native grant lookup and host current checks; check explicit signed binding presence/validity and
all capture/authority/snapshot evidence using supplied boot only. Stage 8 resolve uses the M1
decoder and the same contextual evidence validation, including every supplied-envelope bound;
it performs no policy resolution or gather execution and checks no produced output bounds.
No native current check runs at either initial or final positions. This is a pure validation
projection; it MUST NOT move invoke's stage-8 checks into invoke's earlier stages.
Known deterministic bounds beat malformed input within the same projected phase, matching
MR-21. Returned semantic code need not be invoke's first refusal: an omitted native grant or
currentness check could win earlier there. In particular absent grant, refused required support
and stale source can all preflight input-valid yet invoke unauthorized/source-changed; malformed
source evidence with missing grant can preflight invalid-source but invoke unauthorized.
Supplied resolve envelope overflow preflights over-input-limit and invokes resource-limit at
stage 8; in-bounds gather input with excessive produced expansion preflights input-valid but
invokes resource-limit. These paired schedules are mandatory M2 evidence. Applications retaining
snapshots, evidence, outcomes or definition payloads own every retained erasure surface; these
pure ports neither persist nor purge those copies. Host diagnostics may distinguish refused
support from revoked permission while both remain wire unauthorized.

**MR-22.** Portable semantics belong to their existing owners; ownership/API manifests
freeze new seams. HView codec lives in algebra, full reading appearance primitives in syntax,
complete definition walk in schema, exact acts in schema-load, resolution in resolve-kernel,
evaluation in resolve, durable maintained-state machine in reactor, host capture/storage seam
in federation/storage, pure command shapes in command-data and orchestration in command. Lower
owners cannot import command; no duplicate resolver, registry or Loam selection implementation.
Command reaches reactor/storage through the existing federation dependency: a thin native
federation facade/reexport delegates their codecs/planner/CAS without duplicating them. It
passes verified normalized input from command; no reactor import of command-data/federation/
schema-load or command import of reactor/storage is introduced. Native reactor registration/callback
APIs are explicitly native extensions, not an installed
portable profile. API inventory must classify every new exported declaration and preserve old ones.

## 7. Acceptance and stopping boundary

**MR-23.** Each implemented milestone MUST deliver shared positive/hostile vectors,
fixed TS→Rust and Rust→TS routes, and the milestone's three seeded towers with exact replay.
M3 install→export→fresh-other-witness restore→read crosses canonical control image bytes,
never shared native state. Oracles include direct independently specified batch results,
not agreement of two implementations. Corruption and common-wrong-answer probes must fail.
Keep existing four-witness gates, graph/API/coverage and profile-1 conformance green. Only
exact version capability evidence permits a tower stage; pending profiles cannot self-certify.

**MR-24.** M5 migrates only the supervisor-selected ordinary named PRIMARY read subset
documented in LOAM-TRIAL.md. Both present and historical reads use M2 batch gather then resolve,
one arbitrary requested
entity per invocation (registered or nonregistered); present at = host observed now, historical
at = asOf, definition-at/current authority remain independently bound. This production branch
performs NO maintained install/advance/replace CAS. M3/M4 lifecycle remains required substrate
work, not a claimed Loam maintained-state migration.

Dispatch requires full static executable-closure eligibility AND exact input-capacity preflight
on the authorized per-invocation source/program/request/carriers, including all signed carrier
claims/signatures and deliveryBytes. Classify before portable invocation; freeze route, source
basis and time for that attempt. Out-of-input-bounds is an explicit excluded native branch with
unchanged answers, never a caught portable error. Never filter/truncate membership to fit; missing
promised original law is a visible error, not size exclusion. Any unexpected source change after
classification is visible failure, including on the excluded native branch; no context reroute.
Within input capacity does not promise output/expansion capacity or successful execution. Errors
once portable invocation starts surface with their typed category. One attempt per door call:
no automatic retry, native fallback, durable selection mutation or global current-source slot.
Existing Loam authority, current closure, asOf narrowing,
child decoration and custom bucket resolvers remain application-owned. All ten real-door
schedules are mandatory, along with negative bystanders and removal of eligible obsolete code.
Release A/B numbers are selected by supervisor at release time. The supervisor
freezes this packet for independent Fable review before implementation.
