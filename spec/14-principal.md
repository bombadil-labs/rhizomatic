# Rhizomatic Specification — SPEC-14: Principal Evidence

**Status:** Draft for step 5 conformance vectors
**Depends on:** SPEC-1, SPEC-4

## 1. Questions kept separate

A delta's `author` and verified signature establish its **signer**. They do not establish which
person or organization controls the key, nor whether the signer may act for another key. A
principal read answers three separate questions over a caller-supplied delta set:

1. Which keys have held, signed **association** evidence for a pinned principal root?
2. Which keys have an effective **delegation** path from that root at a stated time and scope?
3. What evidence was present in the supplied set when the caller made the read?

The caller pins an Ed25519 root author id (`ed25519:` followed by the lowercase public-key hex)
outside this principal read. Its exact bytes are the principal id. The principal tier MUST NOT
select its own governor from an unpinned name, registry result, or claim in the input set. An
application MAY select the root through a separate governed read whose governing key or root was
already pinned independently. That read is the application's explicit trust decision; an
untrusted principal claim cannot appoint its own root. For example, a store can pin its operator
key locally, then use an operator-governed user record to select a user's principal root. The
root is associated with itself and can
authorize its own acts without a declaration. A self-signed root declaration can provide
discoverable evidence, but cannot make an unpinned root govern another principal.

All principal evidence is an ordinary signed delta. No new field or encoding is added to
SPEC-1. Its id and signed creation time remain content claims; neither proves when another peer
received the delta. A principal reader MUST verify the signature before using an evidence delta,
even if the input delta set permits unsigned data. An erased or missing evidence delta cannot
establish association or authority from an index entry alone.

## 2. Evidence records

This step reserves `rhizomatic.principal` as the context on the root entity pointer and the
following exact profile. Every evidence record has exactly one pointer with role `principal`,
targeting `{ id: root, context: "rhizomatic.principal" }`, and exactly one `kind` primitive
pointer. The role names below are literal, case-sensitive strings. Each listed role appears
exactly once; an unlisted role makes the record ineligible as principal evidence. A malformed
record remains a valid ordinary delta and MUST NOT be repaired into evidence by dropping fields.

| `kind` | Other pointers | Signature rule | Meaning |
| --- | --- | --- | --- |
| `root` | none | `author = root` | Discoverable self-declaration. |
| `binding` | `key`: author-id string | `author = root` | Associate the key with the root. Grants no authority. |
| `succession` | `previous`: author-id string; `key`: author-id string | `author = root` | Root-authorized continuity from previous to key. Grants no authority. |
| `delegation` | `key`: author-id string; `scope`: nonempty string; `delegable`: boolean | Author must have an effective delegable path from the root, or be the root. | Permit the key to act within the stated scope. `delegable` controls whether that key may sign a further delegation. |
| `locator` | `address`: nonempty string | `author = root` | Reachability hint. Grants no authority. |

Every `key` and `previous` value MUST be a well-formed Ed25519 author id; `previous` and `key`
MUST differ. The root, binding, succession, and locator records are accepted as evidence only
when signed by the pinned root. A non-root claim with the same shape is an unrooted claim,
which MUST be reported as `claimed` evidence for its named key when queried, but MUST NOT create
a rooted path. An optional
old-key signature on a succession is separate corroborating testimony; it is not required and
cannot replace the root's signature. This step does not define an old-key attestation record.

Association follows root-signed bindings and successions. A succession whose `previous` key has
no rooted association does not create one for `key`. Two live successions from the same
`previous` key to different keys are **disputed**; readers return both paths in delta-id order.
Neither claimed creation time, ingestion order, nor registry freshness chooses a winner.
Succession is continuity only. A reader MUST NOT infer authority from a binding or succession.

## 3. Effective authority

An authority read takes an explicit finite `at` and a scope request. A delegation edge is
effective only if its bytes are held, its signature verifies, its own interval contains `at`,
and no effective, caller-honored negation suppresses it at `at` (SPEC-4 §3.1). The same interval
and negation rule applies to root declarations, bindings, successions, and locators when asking
whether they stand at `at`; a history query can include records outside that window.

The root is the starting authority and may delegate. A delegation signed by the root extends
authority to its `key`. A delegation signed by another key extends authority only if that signer
already has an effective path from the root for the requested scope whose final edge has
`delegable: true`. A key whose only effective paths end in `delegable: false` may act, but MUST
NOT extend authority. The right to delegate is checked at every link; a later link cannot turn a
non-delegable path into a delegable one. Every edge of a path MUST permit the requested scope.
Cycles without a path from the root grant nothing. A key's authority can end when any
edge in its path expires or is effectively negated. An expired negation stops suppressing its
target at its `validUntil`, so a still-valid delegation can become effective again.

Every delegation MUST name a scope. The literal `*` is the explicit universal scope; omission
does not mean universal authority. Every authority request also names a nonempty scope, using
`*` only when asking for universal authority. For both portable policies, an edge with scope
`*` permits any requested scope. Under `exact`, every other edge permits only an equal scope.
Under `prefix`, an edge scoped `S` permits a request `R` when `R = S` or `R` begins with
`S + ":"`. The colon is the portable separator; `user:ada` permits `user:ada:journal` but not
`user:adam`. A request for `*` is permitted only by `*`. The rule applies at every edge, so a
parent edge must permit the narrower scope a child delegates. These are comparisons of opaque
strings; the principal tier assigns no meaning to a segment. An application MAY provide another
explicit scope policy, but its decisions are outside portable conformance.

The caller chooses which negations have authority through an explicit suppression predicate, as
in SPEC-4. Principal resolution MUST NOT silently treat a negation by any signer as binding.
The portable `sameAuthor` profile honors a negation only when its signer is the target record's
signer. The portable `rootOrSameAuthor` profile also lets the pinned root negate any delegation
under that root, including a delegation signed by another key. The same rule applies to
counter-negations: a delegate cannot undo a root-signed revocation merely by negating it. A
suppression callback MUST NOT recursively invoke the same negation reader.

## 4. Read results and time axes

`resolvePrincipal(input, root, key, { at, now, scope, scopePolicy, suppression })` reports association and
authority separately, with the supporting delta-id paths sorted by id. `now` is the caller's
observation time: the input set is the evidence the caller has chosen to make available at
that time. The principal tier MUST NOT synthesize arrival testimony from `timestamp` or
`validFrom`, and changing `now` alone MUST NOT fabricate an unseen edge. `at` is the effective
time used for validity and negation. Both are explicit finite numbers. No library clock is read.
`scope`, `scopePolicy`, and `suppression` are also required inputs; a reader MUST NOT silently
choose a universal scope or a revocation policy.

The association grade is `unresolved` when no relevant effective evidence is held, `claimed` for
an unrooted relevant claim, `rooted` for an effective path to the pinned root, and `disputed`
when incompatible rooted succession paths are effective at `at`. The root itself is always
`rooted`. A record outside its validity window or effectively negated at `at` does not provide
a present association path; the history query below still reports it. Authority is a separate
boolean plus its evidence paths.
Dispute does not authorize an otherwise unauthorized key, and does not erase a valid delegation
path. All output paths are deterministic and independent of input iteration order.

`associatedKeys(input, root, now, suppression)` is a history query. Its suppression policy is
explicit because the current negation state depends on that policy. It lists one row per root-associated key
and supporting path, including keys whose supporting records are now negated or outside their
validity interval. The root has an empty evidence path. Each other row carries the path's delta
ids, the intervals on those deltas, and whether any edge in that path is effectively negated at
`now`. Rows sort by key author id, then lexicographically by the path's sequence of delta ids.
The history query MUST NOT turn historical association into current authority.
`authorsForPrincipal` returns keys with an effective delegation path at `at`, plus
the root itself; a governed read can pass that set as its explicit author selection.

An application may choose to judge an earlier signed act using present authority (`at = now`).
That is Loam's interim rule. A historical authority judgment at the time an act reached a peer
requires step 6 arrival testimony; the author's signed `timestamp` cannot supply it.

## 5. Predicate use

The serializable predicate
`{ "actsFor": { "root": "ed25519:…", "policy": { "kind": "prefix", "scope": "user:ada:journal" } } }`
matches a delta whose `author` is in `authorsForPrincipal` at the evaluation's explicit time.
The policy `kind` is `exact` or `prefix`, and `scope` is required. `scope: "*"` is an explicit
request for universal authority, not a default.
The predicate's bytes live with SPEC-2 syntax. Evaluation MUST receive an explicit principal
resolver over the same input set and time. Without it, evaluation fails loudly instead of
silently matching no authors. The lower syntax, algebra, resolve, and reactor packages MUST NOT
import the principal package. The principal package provides the resolver adapter, so
materializations can refresh when a relevant membership or validity boundary changes.

The predicate does not infer a scope from a container. An application must put its requested
scope in the serialized term, or explicitly supply an application policy to the resolver.

## 6. No external authority

Locators and optional registries help find evidence. They do not add an authority edge. A
reader disconnected from every registry returns the same answer for the same pinned root,
held deltas, read time, scope, and suppression rule. Two stores' equal entity strings still
co-refer; a governed read supplies its root explicitly rather than changing delta identity.
