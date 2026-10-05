# Portable evidence and maintained reads — proposed normative contract

Status: **M0 draft for independent review; no runtime capability is certified.** Baseline:
Rhizomatic `21b209ed1b14e749a5e7cf84fd9eef4f8e592fb0`, Loam `ae0e4e21`.
This packet proposes a new profile, `rhizomatic.materialization/1`. It does not amend
`rhizomatic.command/1`, its installed operations, or SPEC-1–15. Requirement IDs MR-01–MR-24
are stable. Acceptance is indexed once in [ACCEPTANCE.json](ACCEPTANCE.json); milestone
allocation is independently frozen in [MILESTONES.json](MILESTONES.json).

## 1. Scope, authority and compatibility

**MR-01.** TS and Rust MUST implement this profile in lockstep. Existing Delta, term,
Schema, HView and View canonical bytes and hashes MUST remain unchanged. Elixir and Haskell
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
delta predicates after explicit hole substitution: actsFor, inView and aliased string matches
there are invalid-program, since the current pure policy kernel cannot acquire their input
context. Generic M1 may preserve those native syntax shapes; new portable resolution cannot
pretend they execute. This is a new-profile support boundary, not an evaluator/hash amendment. One
root per batch gather; registrations have a finite explicit
root set. No automatic root discovery, registry lookup, name-based latest selection or network I/O.

## 2. Canonical primitives and finite limits

**MR-04.** `C(x)` is the existing deterministic CBOR encoder; `H(bytes)` is the existing
`contentAddress` (`1e20` plus 64 lowercase hex digits). Maps have text keys in existing canonical
UTF-8 order; duplicate keys, unknown keys, tags, null, undefined, indefinite lengths, integer
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
| artifactBytes | 16,777,216 | each complete canonical envelope, capture, control image or result |
| deliveryAppearances | 8,192 | every delivered Delta appearance before dedup |
| deliveryBytes | 33,554,432 | canonical claims + decoded sig bytes per delivered appearance |
| appearances | 4,096 | distinct full appearances in one envelope/capture |
| entries | 16,384 | HVEntry occurrences across all nested nodes |
| nodes | 4,096 | root and every embedded child occurrence |
| depth | 32 | root depth 1, child depth parent+1 |
| pointers | 256 | per original Delta |
| buckets | 256 | per node, including empty buckets |
| readings | 256 | distinct full Schema appearances per envelope |
| definitions | 256 | exact signed acts per program closure |
| syntaxDepth | 64 | root syntax node depth 1; predicates/orders/terms/policies all count |
| syntaxNodes | 16,384 | all nodes in one complete program closure |
| roots | 64 | per registration |
| registrations | 64 | active plus retired entries per control image |
| components | 64 | contributing peers in one capture |
| inventoryIds | 16,384 | distinct raw/exclusion membership IDs per capture |

Strings and byte payloads are bounded by artifactBytes as well as enclosing limits. No
truncated successful result is allowed. Limits are cumulative where a result contains many
root envelopes. A profile deliberately starts with full snapshots and full results; performance
work cannot replace these with patches or relax validation. Physical execution exhaustion is
`resource-exhausted`, distinguished from deterministic input `resource-limit`.

## 3. M1: lossless HView evidence

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
present require canonical Ed25519 author and successful existing verification. M2/M3 separately
require all source/definition/command appearances to be signed. Generic decode grants no trust.

ReadingAppearance.body is existing `schemaCanonicalHex` decoded to bytes (props/default only).
Preserve optional name and alg independently, including absence. Decode using syntax, attach
metadata, and demand exact body re-encoding. key = H(C(ReadingAppearance)). Its semantic
pin is schemaHash(decoded Schema) = H(body), which deliberately excludes name/alg. Thus
same-body/different-name readings have equal semantic pins but distinct transport keys. This
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
digest H(existing hview canonical bytes). Reconstructing an envelope MUST reproduce the original
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
operation must be valid at each attempt's receivedAt;
a required source binding must also be valid then. Retire/restore require no source grant. Invalid
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
serving-at must equal the host receivedAt captured once for that invocation; at is independent.
An async preparer may capture receivedAt first and invoke with that frozen attempt observation;
it cannot reuse it for a later attempt. Request author timestamps never set either clock.

`evidence/1` roles are `kind` 1 text, `result` 1 bytes containing the completed gather body in
section 6. Its signature attests who carried the evidence, not who ran the program. Resolve
accepts supplied evidence including foreign carrier authors; access to these bytes is already
explicit. It neither acquires a source nor grants access to other source rows. It validates the
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
checkCurrent(bindingId, revision, authority, servingAt, cutoff?), and
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

**MR-10.** A capture/1 delta has `kind`, `source-binding` ref, `authority` ref, `basis` bytes, all 1.
The exact authority/1 support delta has `kind`, `source-binding` ref and `spec` bytes, all 1;
spec is `{root: ID, epoch: N, context: bstr}`. root equals binding.authorityRoot; context is
a canonical text-key map containing the host's complete authorization-selection context.
Its author is the binding capturer. Its ID equals snapshot.authority. This representation
is inert attributed context, not a portable execution of account law or a self-grant.
basis is C of the snapshot map below with appearances omitted, format replaced by
`rhizomatic.source-basis/1`, and one added `snapshot` ID = H(full snapshotBytes). Thus its
signature commits to payload bytes without embedding them. A snapshot/1 carrier delta has
`kind` 1 text and `data` 1 bytes containing the full snapshot. Any verified canonical signer
may carry it; its author is not the capture authority. Requests explicitly supply both refs.
Host capture yields both artifacts; each is verified independently, and their metadata and
H(snapshotBytes) must agree exactly. Control stores only capture/1, never the snapshot carrier.
Its author MUST be the installed binding's capturer; claims timestamp/validFrom equal the
capture observation servingAt. This is trusted testimony under a host grant, not proof of
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
unbound/actsFor features in evaluated reading bodies too, so an envelope cannot request native
principal callbacks. Loam-specific custom resolvers remain outside portable resolution.

**MR-12.** Delivery is `(entryId, signed debug Delta appearances)`, copied before awaits.
Verify every appearance, then dedup as SPEC-15 R-08. Support closure is explicit: common config
and operations come only from boot; direct request refs reach evidence, registration, capture, snapshot,
top definitions and definition support. Capture reaches its authority support; registration may
reach its definitions; evidence reaches
definitions named in its gather body. Snapshot carriers are direct support only, never implicit
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
 authority: ID, at: finiteFloat, capture?: ID}...],
 deltas: [AppearanceBytes...]}
```

Entries sort by registration ID. deltas contains exactly referenced signed descriptors, their
complete signed definition closure, selected metadata-only capture and authority deltas for active
entries and latest
transition delta per entry, sorted by full appearance key, exactly one selected appearance per
support Delta.id; boot configuration and binding
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
`capture` optional ref (required active; absent retired). Its timestamp/validFrom = receivedAt;
no validUntil. It describes an accepted selection, not a new operand fact. Its prior-control
references the pre-transition image; never include the resulting image's own digest (no hash
cycle). The image itself is sayable as an inert control-image/1 delta with roles kind (1 text) and
data (1 application/cbor bytes) containing the exact image. Such a retained carrier cannot
select a new store head or activate state. Current state is verifiable structure and local trusted
durable selection, not an
immutable history proof. State deltas may be retained as ordinary inert testimony elsewhere.

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
Definition bytes are retained explicitly as selected program support, not a duplicate operand
database. If a definition itself becomes an erasure target, existing host erasure obligations
include that support; a current source check cannot authorize serving a permanently refused act.

**MR-16.** install/replacement/time transitions first validate, acquire/check source authority
and exact capture basis, compute COMPLETE batch HView+View for every root, bound-check full
result/image, perform the final current
source check, sign transition, then CAS. This precomputation avoids a known semantic error after
commit; caches may still fail to build after commit. Results/indexes are disposable. Rebuild
MUST use the same original definitions, explicit full snapshot matching accepted capture metadata,
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
current read likewise refuses outside-validity instead of serving old output. Definition
validity remains at the represented definition-at; source validity advances at the new at.

| Operation | Precondition beyond common validation | Durable effect | Result |
| --- | --- | --- | --- |
| install | descriptor absent; valid full support; current live capture/binding | create active entry and increment generation | committed transition + complete results |
| replace-source | active exact registration; expected-source matches; proposed capture current and same binding | replace capture metadata/basis; increment generation even equal bytes | committed transition + complete results |
| advance-time | active; explicit committed snapshot; expected-source matches; at >= stored at; source current | set at; increment generation even equal time | committed transition + complete results |
| retire | active exact registration; admin; no source availability needed | terminal retired entry; remove capture metadata; increment generation | committed transition only |
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
agreement, capture revision/binding, descriptor pins/closure, and active source selection. It
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
| rebuild/index fault after durable CAS | new | indeterminate result-unavailable with confirmed control revision; cannot claim refusal |
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
Basis = {binding: ID, revision: ID, authority: ID, selection: ID,
 membership: ID, appearanceDigest: ID, components: ComponentRecords,
 at: finiteFloat, servingAt: finiteFloat, historicalCutoff?: finiteFloat,
 root: nonemptyText, bindings: bstr, definitionAt: finiteFloat, interpretation: "core/1",
 hyperschema: ID, hyperschemaPin: ID, schema: ID, schemaPin: ID,
 definitions: [SignedAppearanceBytes...], definitionDigest: ID}
GatherBody = {kind: "gather", basis: Basis, envelope: bstr, transport: ID, hview: ID}
ResolveBody = {kind: "resolve", basis: Basis, transport: ID, hview: ID,
 value: bstr, view: ID}
RootResult = {root: nonemptyText, gather: GatherBody, value: bstr, view: ID}
MaintainedBody = {kind: "install"|"replace-source"|"advance-time"|"read",
 registration: ID, control: ID, generation: N, sourceRevision: ID,
 authority: ID, at: finiteFloat, results: [RootResult...]}
RetireBody = {kind: "retire", registration: ID, control: ID, generation: N}
RestoreBody = {kind: "restore", control: ID|emptyText, generation: N,
 selections: [{registration: ID, status: "active"|"retired",
               sourceRevision: ID, authority: ID, at: finiteFloat,
               definitionAt: finiteFloat, hyperschemaPin: ID, schemaPin: ID, availability: "unchecked"|"retired"}...]}
RefusedBody = {code: StableCode}
IndeterminateBody = {code: "commit-unconfirmed"}
                 | {code: "result-unavailable", control: ID}
```

Basis.components copies the exact capture component records; definitions includes exactly full
signed definition appearances in delta-ID order; definitionDigest is delta-membership/1 of
these distinct acts. Gather hview/view fields are H(existing canonical bytes), not hex encodings
of payloads. Root results sort by root and must contain every descriptor root, no extras.
MaintainedBody.control is always nonempty because an active entry requires a transition. Read
returns its current invocation servingAt while keeping the accepted source capture component
observations and at distinct; resolve preserves the evidence's basis rather than rewriting it
with its own receivedAt. Restore definitionAt/pins are derived from and must match the exact
retained descriptor.
A successful restore deliberately returns unchecked availability and
no results: an ensuing read must check source currentness and authority. Whole-signature equality
requires identical keys/config/request/receivedAt; otherwise compare attribution and semantics.

**MR-20.** Complete readback composes outer Delta/body validation, strict HView envelope,
signed definition closure/pins/bindings, and existing strict View decoder. Check all declared
digests, status/body pairing, request argument/basis agreement, source binding/revision and
complete root partition when the request/descriptor is provided. Without these, report only
verified structure, not a verified contextual answer. DefinitionDigest/membership do not bind
signatures; full appearance transport keys do. Verification and receiver testimony are labelled
separately from replay/oracle execution evidence. No partial JSON inspection qualifies as readback.

**MR-21.** Fail at the first stage below, independent of delivery order. Within a stage
return one stable category, not native exception text. Count limits precede decode; undecodable
appearance precedes canonical-size checking because its size is unknown; then canonical-size
limit precedes ID/signature checks. This follows SPEC-15's established ordering.

1. Framing/canonical entry ID (local transport error without outcome), input limits, appearance
   decode and full ID/signature verification: resource-limit or invalid-appearance.
2. Entry presence/common grammar/validity: entry-missing, invalid-request, request-outside-validity.
3. Receiver/configuration/installed validity, then caller/admin authorization: configuration-mismatch,
   unauthorized. Lack of administrator rights for a control verb is unauthorized.
4. Installed verb selection, argument grammar, support: unsupported-operation, invalid-arguments,
   missing-support, unexpected-support. resolve's evidence support shape is invalid-evidence. Snapshot carrier integrity/matching is invalid-source.
5. Control existence/decoding/preconditions, then registration state: control-unavailable,
   invalid-control, precondition-failed, registration-missing, retired, already-installed,
   time-regression. Control image defects precede preconditions. No control image is required for
   gather/resolve. Retire is independent of source, definitions' present validity and data availability.
6. Source binding/current authority, capture integrity/currentness (gather/install/replace/advance/read
   only; resolve verifies evidence basis structurally without a source grant/current check): unauthorized, invalid-source,
   source-unavailable, source-changed, precondition-failed. capture revision mismatch to arguments is
   precondition-failed; unsigned/changed embedded rows are invalid-source. An unknown boot binding
   is unauthorized. Expired source grant/config is configuration-mismatch at stage 3.
7. Definitions/program: invalid-definition, pin-mismatch, ambiguous-definition, definition-closure,
   definition-cycle, invalid-program, in that priority. Invalid descriptor/capture core fields are
   already invalid-arguments/invalid-source. Active descriptor outside servingAt validity is invalid-definition.
8. Evidence and execution: invalid-evidence, missing-reading, resource-exhausted, execution-failed.
   An invalid reading feature is invalid-program before resolution. Visible programming defects
   remain host faults; execution-failed is a known read-only semantic failure, not a blanket catch.
9. Durable CAS: write-conflict, control-rejected (refused); commit-unconfirmed (indeterminate).
   Post-commit rebuild is result-unavailable (indeterminate); signer/transport defects may have no
   response. Never mint a refused response after a possibly performed effect.

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
documented in LOAM-TRIAL.md. Eligibility is static/full-closure; execution errors cannot route
to an alternative native source/time. Existing Loam authority, current closure, asOf narrowing,
child decoration and custom bucket resolvers remain application-owned. All ten real-door
schedules are mandatory, along with negative bystanders and removal of eligible obsolete code.
Release A/B numbers are selected by supervisor at release time. The supervisor
freezes this packet for independent Fable review before implementation.
