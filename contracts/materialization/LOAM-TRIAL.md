# Selected M5 trial: ordinary named PRIMARY reads

Supervisor selection from merged Loam `ae0e4e21`, same tree as reviewed `c32909b4`.
Copied and made checkout-relative from the supervisor's selection evidence; this packet has
no runtime/CI dependency on the external audit workspace. This is an implementation target,
not evidence that extraction or migration has been executed.

## Actual door and eligible subset

Ordinary named GraphQL reads reach Loam `src/gateway/reads.ts:resolvedNodeImpl` (line484 at
the selected baseline), then gatherImpl (line159), resolveView, decorateChildren/applyResolvers
(line493 onward), then annotateImpl with existing View/HView digests and historical marks.
Migrate the statically eligible PRIMARY subset of that production path:

- Selected registration is root/local, not channel-origin; definition-source identity remains
  distinct from operand-source identity. The exact current selected registration must be named.
- No bound connection, separate pinned-version door or subscription. No whole admitted-source
  read is added for bound users; unbound channel reads keep their own peer source.
- Complete original HyperSchema/reading closure and exact pins are available from admitted law.
  No minting a receiver-authored replacement for a foreign definition, inline reading or lost act.
- Full gather, nested references, reflected subterms, alias-trust predicates AND top/child/embedded
  reading orders pass both portable core support and Loam's no-governed-lowering conditions.
  `needsLowering` alone traverses only part of that obligation. No implicit core interpretation
  of Loam account/user predicates or native lowering capability.
- Host preparation captures the primary source under current read closure and the requested
  historical cutoff using existing source rules. Captured revision covers actual membership,
  represented authority, closure parameters and contributing peer identity. No count/head shortcut.
- Operand at, current definition-selection definition-at and present serving-at are explicitly
  retained per invocation. Current source/time reads use maintained registration; historical
  reads use portable batch gather with the same evidence envelope format.

Eligibility is a full static dispatch decision before execution, not a catch after source,
authority, pin, decoder or execution errors. A registration that promises eligible support but
loses an act fails visibly; it does not silently choose native evaluation or different source.
Native in-process-only `register()` fixtures without original published acts remain outside this
subset; required migrated fixtures publish originals through the actual production journal door.

## Concrete implementation constraints and evidence

- gatherImpl selects bound/channel/primary before warm materialization. Current readClosedIds
  demotes old warm state; historical asOfGroundImpl applies timestamp cutoff then current closure.
  Preserve both current readGround and historical narrowing, including unrelated bystanders.
- `src/gateway/governed-trust.ts:needsLowering` traverses referenced gather definitions;
  governedProgram builds overlays from native account evidence. Portable eligibility must inspect
  readings/orders too. A private `user:` author pattern or unsupported feature cannot be renamed
  core merely because its AST parser accepts it. No new portable Loam lowering profile is needed
  for the actually eligible subset; unsupported closures are declared bystanders.
- `src/gateway/registration.ts:registrationDeltaClaims` (line643) publishes living/frozen Schema
  acts and bindings naming gather, living reading and snapshot. `publishRegistrationImpl` publishes
  original signed gather acts. Extract the exact selected acts and reachable dependencies under
  current law; deduplicate redundant living/frozen copies by selected act identity, not signature
  substitution or packet order. Compare extracted body pins/metadata to current Registered values.
- Definition validity must use definition-at independently from historical operand time. Loam's
  current registered program can have been signed after the requested past time; program content
  pin does not establish historical selection. A lifecycle descriptor pins its definition-at.
  Changed current law/selected acts/definition-at require explicit retire/new install, not an alias
  rebinding behind an existing descriptor. Descriptor choice remains Loam-owned and sayable.
- `test/gateway/fixtures.ts` defines Plant and named PLANT_READING; genesis.test.ts contains a
  durable BedWithPlants fixture. read.test.ts, reading-refs.test.ts and resolvers.test.ts exercise
  real queries, child policies, authors/time and bucket evidence. Adapt real published variants,
  rather than assuming their native-only registrations already satisfy signed-closure extraction.
- resolvedNodeImpl is synchronous. Durable source/control work is async. Prepare at the async
  query door or introduce an explicit async read path, propagating its public API changes through
  the existing API/Peer boundary gates. Each invocation retains its own basis/envelope/result.
  No effectful synchronous getter, global current-source slot or context rebinding on resume.
- Source final check and metadata control CAS are separate. A just-selected basis may become stale;
  next read checks/refuses. Control has no operand payload copies/WAL surface. Host read preparation
  reacquires/reconstructs the exact snapshot from current rows plus committed metadata and signs a
  fresh carrier, independently checking present permission. Lost source ⇒ unavailable, not cache.
- Existing decorateChildren/readingResolversOf (reading NAME), applyResolvers (full bucket),
  resolver memo and annotateImpl remain Loam-owned. Full names and original deltas are restored
  from envelope; no “picked View equals evidence” shortcut. Current closure confession/forgotten
  marks are still computed using the invocation's present basis, not a fresh implicit clock read.

## Ten required actual-door schedules

The single machine-readable allocation is ACCEPTANCE M5; these descriptions explain its scope.

1. Actual GraphQL Plant read matches prior View/HView digests, including bytes and negation.
2. Durable Bed→Plant survives fresh-process evidence decode and close/reopen.
3. Bucket-count resolver receives all original evidence; values7/9 must still give count2.
4. Current closure hides a target in both present/historical reads; named unrelated row survives.
5. External SQLite deletion and equal-count replacement invalidate/rebuild selected source state.
6. Explicit validity advance changes answer without ingest; same bytes/different authority never
   reuses an old authorized answer.
7. Drop runtime registrations/caches and reconstruct declarations; retired stays retired;
   unavailable source never produces old current output.
8. Bound/channel/governed/pinned/subscription and malformed/private PRIMARY bystanders stay green.
9. Concurrent async preparations/source replacement retain per-invocation basis; errors do not
   switch source/time or fall back to native evaluation.
10. Eligible production branch calls published package contracts; delete its obsolete duplicated
    mechanism while preserving machinery used by excluded paths.

Use real journal-backed stores for removal/restart/authority tests. Full snapshots and correctness
come before incremental performance. M5 proves one supported subset, not portable account lowering,
all GraphQL reads or composed subscriptions. If original signed closure extraction fails for the
selected durable Plant/Bed path, return that concrete blocker to supervisor; do not substitute
unsigned schemas or invent a feasibility claim. Source inspection supports this choice, not yet
an executed extraction/consumer trial.
