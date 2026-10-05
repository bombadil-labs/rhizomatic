# Serialized ports and fixture transport

This framing adds no alternate semantics. Production contracts are SPEC; adapters exchange
canonical bytes and signed existing debug Deltas. One JSON object on stdin, one JSON object
on stdout, diagnostics only on stderr. Bytes in framing are lowercase even-length hex;
debug byte targets use the existing Delta JSON profile. No JSON substitute for semantic CBOR.

Input is `{mode, scenario, artifact, context}`. artifact is
`{format:"rhizomatic.materialization-artifact/1", entryId?, deltas?, bytesHex?}`.
Unknown framing keys/modes fail locally. Semantic objects are immutable snapshots before awaits.

| Mode | Artifact input | Artifact output / boundary |
| --- | --- | --- |
| envelope-write | signed/unsigned debug appearances plus structural HView fixture with appearance keys, metadata and pointer indices | envelope bytes; codec construction fixture, no source permission |
| envelope-read | envelope bytes | identical canonical bytes and independently decoded inspection; original appearance bytes, reading names/pins, node/entry order; no native registry |
| construct | explicitly authored request/support claims and public test seeds in fixture context | entryId + signed original debug deltas |
| gather | signed request/support, full signed capture basis and separate snapshot carrier | signed gather outcome with envelope and bound context |
| resolve | exactly independent signed request + evidence wrapper of gather body (complete signed closure embedded, including top acts); no delivered definition support | signed resolve outcome; source capability is absent in this stage |
| control-execute | install/replace/advance/retire/read/restore request and explicit support | signed outcome plus separately observed reopened control image/revision |
| control-export | exact receiver/configuration in context, no implicit source capture | strict canonical control image bytes |
| control-restore | prior canonical image installed by fixture host into fresh receiver/configuration storage; explicit restore request | selection metadata only; read is another invocation with explicit snapshot |
| read-result | original request/descriptor plus signed outcome | fully validated contextual result; opaque-envelope-only/outer-body-only passes are insufficient |

context fixes `receiverSeed`, `callerSeed`, `capturerSeed`, exact signed boot configuration,
installed operation/binding descriptions, granted source fixtures, `receivedAt`, independently
isolated `controlPath`, sourcePath/inventory, canonical initial control bytes, explicit schedule
and fault point. receivedAt is a finite trusted native invoke argument sampled ONCE before
preparation, not parsed from the request or independently sampled by the endpoint. A changed
signed serving-at returns stage-4 invalid-arguments; wire context cannot override host observation.
Seeds are public TEST ONLY. All executable support appears as signed Deltas
or canonical port bytes. Native paths and fault schedules are host fixture capabilities, not
serialized grants. The host adapter MUST implement coherent physical-inventory capture/check,
not simply return the declared expected answer. Current checks receive the explicit sorted selected
program/descriptor requiredSupport IDs and consult existing host refusal facts; fixture programs
sharing one source binding must be distinguishable without ambient request state. Both initial
and final-after-precompute checks take the IDENTICAL sorted/deduplicated support IDs, including
both top acts and descriptor where applicable. Equal source revision cannot suppress them. Its exact grant maps binding ID to selected
source authority; changing a context field cannot override a signed argument.

`sourceFixtures` consist of original signed rows, raw/exclusion inventories, canonical represented
authority context, contributing peers' explicit revisions and observations. Capture adapters
exercise independent actual source reads/mutations. A read/advance snapshot carrier may be
freshly signed while retaining identical committed snapshotBytes and metadata. It carries data,
not new source testimony. The old metadata-only capture signature remains in control. Its
commitment can be rebuilt from current rows without retrieving an old native signer. Current
permission/revision must still be checked for this attempt. Original authority claim times and
interval remain stable across unchanged captures; capture validity uses its original observation.
The resolve port accepts exactly request+evidence and reads embedded Basis.definitions; public
Basis.components contains only peer/revision/capturedAt. Inventory IDs/exclusions must not escape
into outcome/evidence bodies. Multi-root output shares one Basis/closure, with root-local envelopes.
Fixture inspection distinguishes source commitments from digests recomputed from result bytes.

Durable tests use atomic file or sqlite control adapters capable of real process termination,
reopen and CAS. File adapter writes a same-directory temp file, syncs file, renames, syncs parent;
sqlite adapter uses one transaction for control CAS only. Adapters never persist operand snapshots
in control. Active program support is a real retained host erasure surface: tests retire all consumers, remove
unreachable support and historical copies, then observe physical absence before settlement. Retired
reopen has only signed terminal scalars, no original payload. Program-purge fixtures distinguish
pre-CAS crash, uncertain absent/present retirement, durable retire and unfinished physical cleanup.
Artifact logs deliberately contain public test payloads and are not production stores.

Rotation fixtures durably select one host configuration independently from control CAS. New-scope
preparation never serves before activation; crash before/after activation restarts old/new selected
configuration respectively. Loam route fixtures record static eligibility, exact source/input byte
classification INCLUDING carriers and delivery overhead, frozen native receivedAt and source basis.
An over-input-limit source is explicitly native before dispatch; portable output-limit errors do
not change route.

Each stage receives only serialized output from its predecessor, plus the same explicitly granted
host fixture context where effects require it. No compiled program, private registry, callback,
running reactor, opaque authority object, cache or implicit global source crosses a port. Source
grant is configured independently at each executing witness. Validation does not confer it.

Replay includes exact stage artifacts, semantic bytes, initial durable state, source artifacts,
build identities, capability snapshot, explicit time/fault/mutation schedule and expected oracle.
Replay verifies hashes and executes the stored assignment graph; it never rerolls or substitutes
a newer build/contract. Failure logs identify the producer/consumer port and expected violation.
