# Step 5: principal contract for review

Status: design draft. This records the decisions needed before the principal vocabulary, API,
and shared vectors become normative. Step 4 reads already accept a caller supplied author set or
predicate; the principal tier will supply those inputs. Loam's `principal.*` recordings in #590
are evidence of present behavior, not the desired answers.

## Boundary and dependency

The principal package reads verified deltas, the reactor's indexes, and the step 4 negation
reader. It does not import federation, a network registry, a host clock, or Loam roles. Federation
may use principal output to make an admission decision; that dependency goes one way. The package
exports through the existing `@bombadil/rhizomatic` barrel.

`actsFor` must not make the lower algebra or reactor packages import principal. Its JSON syntax
and canonical bytes live with other predicates in `syntax`. Evaluation receives an explicit
`PrincipalAuthorResolver` interface, as it already receives other external evaluation inputs;
the principal package supplies the adapter above the lower evaluator. A missing resolver for a
term containing `actsFor` is an explicit evaluation error, not an empty author set. Reactor
materialization receives the same adapter as a constructor/registration input, so time changes
can refresh principal membership without a dependency cycle. The package graph checker must
prove these edges before the runtime implementation lands.

The `author` field remains the signing key. Principal resolution does not rewrite a delta, its
content address, or its signature. Equal entity ids still merge. An application that reads a
governed anchor supplies an explicit pinned principal root or governing key choice; the delta set
alone cannot appoint its own governor.

## Proposed vocabulary and evidence grades

A principal root is a self-certifying Ed25519 public key. Its stable `PrincipalId` is that key,
not a person name or a registry entry. A root declaration is signed by the root and names the
principal; it proves control of the key, not that a human-readable name is unique. A reader may
pin the root key directly even when the declaration is unavailable.

A key binding says that key K acts for principal P. A delegation says that a currently authorized
key permits another key to act for P, optionally within a declared scope. The scope is an opaque
string or entity id carried as evidence; the application interprets its meaning. The principal
package compares it under a caller-supplied, explicit scope policy and does not impose Loam's
container or role vocabulary. A succession claim says
that a later key continues a previous key's principal association. Each is an ordinary signed
delta with `validFrom` and optional `validUntil`; any negation of it is evaluated at an explicit
read time. A locator claim gives an address at which a principal might be reached. It is a hint,
never a source of signing authority. Registries may index these claims but may not be required
for a local or offline resolution.

The reader reports evidence rather than silently selecting a key:

| Grade | What is established |
| --- | --- |
| unresolved | No verified path from the key to the pinned root is held. |
| claimed | A relevant assertion is held, but its signer is not yet authorized by a path to the root. |
| rooted | A verified, valid, non-negated chain reaches the pinned root at the explicit read time. |
| disputed | More than one incompatible live path or successor is held; every path is returned. |

`rooted` is relative to the supplied root and read time. It does not establish a global person
identity or guarantee that an unseen conflicting claim does not exist. A disconnected reader
can still return `rooted` from its held evidence; it must not pretend a registry was checked.

## Read contracts

The core query shape is `resolvePrincipal(input, root, key, { at, now, policy })`. `at` is the
effective time whose authority is in question; `now` is the caller's observation time. The
caller supplies the evidence set available at `now`. Step 6 may construct that set from arrival
testimony when it asks what authority existed at an earlier act. This API must not silently use
the author's signed creation time as the act time. The result contains a grade, the held evidence
paths, and the set of keys that the supplied policy accepts for the root. A convenience
`authorsForPrincipal` supplies that set to governed reads. All inputs are explicit. A caller
chooses whether its policy accepts delegation, succession, disputed paths, and a scope; the
library must not resolve a dispute by arrival order, claimed creation time, or registry
freshness. Paths and conflicts are sorted by delta id for deterministic output.

`associatedKeys(input, root, now)` is a separate history query for every key ever associated
with the root in the supplied evidence. It returns each key with its binding intervals, current
negation state, evidence grade, and path ids, sorted by key then path id. It includes negated
bindings so a rotated user can find claims signed under an old key for a retract-your-own read.
This history answer does not itself authorize the old key to sign today.

Principal membership must also be usable in a serializable L2 predicate. The proposed shape is
`actsFor: { root, policy }`, evaluated at the term's explicit `now` and lowered to a set of
authors by `authorsForPrincipal`. `policy` must be a portable, closed JSON profile or a pinned
principal-policy reference, never an ambient callback hidden inside a term. A container membership
term can then follow key rotation without being rewritten for each new key. Step 6 admission
guards can use the same predicate with their own explicit policy. A host callback remains
available for local decisions that are not shipped as terms. The lowering result is tied to the
input delta set, explicit time, pinned root, and policy; a materialization refreshes it when any
of those inputs changes. It cannot cache a key set solely by term hash.

Signer provenance and present authority are separate questions. `delta.author` plus signature
verification proves which key signed it. A historical association query can show the held
binding evidence even if that binding was later negated. A present-authority query uses the
binding's and every delegation edge's validity and negation state at `now`. A later revocation
must not erase the fact that an earlier signed act exists. It may remove authority for new acts.
An author's signed `timestamp` alone cannot prove when an act arrived or whether the key had
authority when it was made; that needs the peer's separate arrival testimony in step 6.

The package accepts a suppression predicate for binding and delegation negations, as step 4
does. A missing or purged binding cannot authorize a key. A binding whose bytes were erased
cannot be reconstructed from an index entry. A caller can instead report the surviving testimony
that a binding used to exist.

## Cases to pin before implementation

1. Pinned root with its self-signed declaration: the root resolves offline; a second unrelated
   self-signed root in the same set does not change that answer.
2. Unknown key and unverifiable binding: unresolved or claimed, never rooted.
3. Root delegates to A, A delegates to B: B has a two-edge path; removing either edge removes
   present authority, while the signed acts remain attributed to their actual keys.
4. A binding starts at T or ends at T: the present-authority answer changes exactly at T. A
   negation with its own interval changes the answer only while that negation is valid.
5. A succeeds to B; two incompatible successors are held: return both paths and a dispute,
   independent of ingest order. No automatic winner.
6. The reader is offline from a registry: its answer over held signed evidence is unchanged.
7. A locator changes: the principal and author set do not change.
8. Two peers file at the same governed anchor: the pinned root/key choice separates their
   governed reads; an ordinary entity read still sees the union.
9. A binding is purged but an index reference remains: it cannot authorize the delegated key.
10. Container membership `actsFor(P)` includes K2 after a valid rotation/delegation from K1,
    without changing the serialized Term; a raw `author == K1` predicate does not.
11. The history query lists K1 and K2 with their intervals after K1's binding is negated,
    while present authority may include only K2.
12. Two reads over the same held evidence with different `at` values can differ; changing `now`
    alone cannot fabricate a signed arrival time or a previously unseen edge.

The TypeScript and Rust witnesses must agree on these vectors before a prerelease. Elixir and
Haskell continue to declare their supported level in `witness.json`; the shared Level 0 bytes
are not changed by this package.

## Decision to settle with Myk

**Succession authority.** Does a succession claim itself authorize the successor to sign for
the principal, or does it only record continuity while a separate delegation grants authority?
The latter keeps attribution and authority distinct and is the proposed default. The related
choice is whether a successor must be acknowledged by the pinned root, by the old key, or by
both. These choices determine the disputed-succession vectors and Loam's rotated-key behavior.
The package API should expose all verified paths in either case.
