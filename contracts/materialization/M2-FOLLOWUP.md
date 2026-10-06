# M2 bounded review follow-up

This follow-up is separate from release A at 198b6ea. It addresses Fable's P1/A1/A2
advisories without changing wire bytes, refusal categories, source authorization, or M3 scope.
The supervisor owns integration/publication and independent Fable diff review.

## Changes and trust boundary

- **P1:** the federation owner strictly decodes raw snapshot bytes once and privately computes
  its exact metadata basis/commitment. Command input and contextual result readback use that
  invocation-local checker at the original validation point. TS's leaf-only
  `decodeMaterializationSnapshotEvidence` export is an implementation helper, not a root export
  or new serialized port. Every `snapshot` access returns a defensive owned copy; the private
  verified value and expected basis bytes cannot be mutated through that copy. Neither command
  nor readback accepts an externally supplied handle. Host callbacks receive only the existing
  scalar basis and owned support IDs, never the handle or decoded rows. Rust's factory/checker
  are crate-only with private owned commitment bytes and no externally constructible proof.
- Raw public snapshot/basis codecs retain their existing validation behavior and priority.
  Basis checking remains explicit after source-context checks in command input; readback retains
  its own prior ordering. Preflight, invoke and independent readback each create fresh factories.
  No cross-call cache, Delta-ID cache, mutable identity proof, skip flag or permissions cache.
  Generated/supplied envelope verification and resolve's verification remain unchanged.
- **A1:** shared `capture_authority_pointer_shape` pins the stage-4 `unexpected-support` refusal
  for a correctly signed capture whose authority role is an entity instead of a Delta reference.
  Every pre-existing complete command vector remains deeply equal to the accepted corpus.
- **A2:** fresh-process fixture hosts take opaque snapshot testimony. Their native source basis
  comes from separately constructed fixture `source` metadata and raw `rows`, never expected
  outcomes or endpoint decoder output. Their currentness checks compare against this host basis
  and its initial raw membership. Oversized snapshots reach actual TS/Rust gather and preflight.
  Optional measurement input records source/boot preparation separately from endpoint time;
  ordinary tower outputs remain unchanged. Expected signed refusal bytes stay outside the host.

## Deterministic and semantic checks

TS native probes mutate returned nested rows, CBOR byte buffers and component inventories,
original artifact bytes and limits. Later snapshot access and the detached basis checker remain
bound to the original evidence. A forged structural handle cannot enter the raw-byte factory.
Fresh factories verify independently; basis checks add no signature verification. Same-ID
unsigned and different-signature artifacts are rejected, rather than reusing earlier evidence.
Rust checks the private commitment after mutation of its separately owned native data and
original bytes. Shared malformed basis/signature, authority and source/support refusal-priority
schedules remain in the unchanged corpus and run in both witnesses.

The measurement runner instruments the **real strict verifier** in disposable builds. For the
unchanged source-N fixtures it asserts measured counts (not substituted counters):

| Phase | Accepted baseline fbd3df8 | This follow-up |
| --- | --- | --- |
| capture fixture host | 2N+3 | 2N+3 |
| boot | 4 | 4 |
| gather | 3N+11 | 2N+11 |
| gather readback | 3N+24 | 2N+24 |
| resolve | N+15 | N+15 |
| resolve readback | 3N+25 | 2N+25 |

Complete signed output/body goldens are still asserted. The source4097 serialized adapter probe
runs both actual endpoints with expected outcomes removed from host inputs, requires the exact
signed `resource-limit` refusal and preflight `over-input-limit`, and checks zero currentness
callbacks. It records native source/boot preparation and endpoint refusal separately. These are
fixture-native capabilities, not claims about a production host or Loam performance.

## Evidence and limits

Ignored `artifacts/materialization-followup` holds retained clean fbd3df8 baseline measurements,
new measurements, gate logs, assertion receipts, fixed crossings and towers/replay. The exact
follow-up SHA and executed counts are reported after freeze. No wall-time CI threshold exists.
Whole-process RSS includes parsed fixtures/goldens/carriers, runtime/GC, retained phase data and
instrumentation; it is neither per-phase attribution nor a causal memory comparison. The TS
factory's defensive copying is explicit extra work, and the remaining envelope/resolve
verification passes are outside this bounded repair. This introduces no total CPU/work quota.
