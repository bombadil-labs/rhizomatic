# Selected M5 trial: ordinary named PRIMARY batch reads

Supervisor selection from merged Loam `ae0e4e21`, same source tree as reviewed `c32909b4`.
This repo-local selection and repair decisions are the handoff; no runtime/CI dependency on an
audit workspace. Source inspection supports the target; original signed closure extraction and
actual count/byte measurements remain M5 execution evidence, not established feasibility.

## Actual door and route

Loam `src/gateway/reads.ts:resolvedNodeImpl` (577 at `c32909b4`) calls `gatherImpl` (159),
`resolveView`, then `decorateChildren` (587)/`applyResolvers`, finally `annotateImpl`.
Migrate the selected ordinary named PRIMARY branch to portable **batch gather then resolve for
BOTH present and historical reads**. The arbitrary requested entity is one batch root; registered
and nonregistered entities both work. No portable install/advance/replace CAS occurs at this door.
M3/M4 still deliver and prove maintained substrate lifecycle, not Loam maintained-state adoption.
Loam pins reviewed published release B, even though this branch consumes M2.

Present operand at is this invocation's explicit host-observed now; historical operand at equals
asOf and historical-cutoff. Current selected definition-at and present serving-at/authority stay
independent. Loam's present warm wall-clock route is not mapped onto a stored maintained at.
Each door call makes ONE attempt; changed source/authority is a visible typed read failure.
No automatic recapture/retry or catch-to-native after portable invocation begins.

## Eligibility and capacity classification before dispatch

- Selected registration is root/local, not channel-origin. Definition-source identity is distinct
  from operand-source identity; select exact original acts rather than name-only latest lookup.
- No bound connection, pinned-version door, watch or subscription. Bound users gain no PRIMARY
  access; channel reads retain their own peer source and authority.
- Complete original HyperSchema/reading closure and pins must be available from admitted law.
  Native-only register() fixtures without published original acts are declared bystanders.
  A registration promising portable support whose original law is missing fails visibly, rather
  than being reclassified for capacity or re-signed by the receiver.
- Inspect ALL gather terms/references/reflection/alias predicates AND top/child/embedded reading
  orders for core and no-governed-lowering support. `needsLowering` alone is insufficient.
  No account/user/principal callback or new portable Loam lowering profile is introduced.
- After static classification, preflight the exact full authorized per-invocation source basis
  and constructed program/request/carriers against every applicable INPUT limit. Count selected
  appearances, components/inventory, syntax, snapshot/capture bytes, delivered appearances and
  total canonical claims plus signature bytes INCLUDING carrier overhead. Never drop members to
  fit a root; capture is the whole authorized PRIMARY source at that time/closure.
- Freeze route, original source/definition selection and time in an explicit invocation value.
  Outside input capacity selects the existing native branch BEFORE portable dispatch, preserving
  its answers at that same basis. This is declared exclusion, not portable large-source support.
  Unexpected source changes after classification fail visibly on either route. Do not reroute or
  silently resample time. Within input bounds can still exceed output/expansion limits; once
  dispatched such resource/auth/closure/pin/decoder/execution errors surface, never native fallback.

## Application-owned semantics and async feasibility

- `gatherImpl` selects bound/channel/primary before warm materialization. Current `readGround` /
  `readClosedIds` demotes closed warm state; historical `asOfGroundImpl` applies cutoff then
  current closure. Preserve both narrowings, including unrelated bystanders and current authority.
- `src/gateway/governed-trust.ts:needsLowering` traverses gather references, while governedProgram
  builds overlays from native account evidence. Full eligibility checks readings/orders too;
  private user patterns cannot be renamed core merely because their AST parses.
- `src/gateway/registration.ts:registrationDeltaClaims` (643) publishes living/frozen Schema acts
  and bindings naming gather, living reading and snapshot. `publishRegistrationImpl` publishes
  original gather acts. Extract exact selected acts/dependencies under current law; select one
  living/frozen copy by act identity. Compare pins/metadata to current Registered values.
- Current definitions can be published after historical operand at. Explicit definition-at binds
  this selection independently; changing current selected acts/definition-at changes the next
  batch Basis. No Loam lifecycle descriptor, implicit retirement or durable CAS is needed here.
- Plant/PLANT_READING in `test/gateway/fixtures.ts` and durable BedWithPlants in genesis.test.ts
  supply real targets. Adapt published variants of reading-refs/resolvers/read suites rather than
  assuming native-only schemas already support exact signed closure extraction.
- `resolvedNodeImpl` is synchronous; preparation/capture and portable invocation are async. Prepare
  at the async query door or propagate an explicit async read path through API/Peer gates. The host
  samples finite receivedAt ONCE before preparation, freezes it in that invocation value, and calls
  invoke(entryId,debugAppearances,receivedAt). Signed serving-at must match (stage-4 invalid-arguments
  otherwise). No independent endpoint clock, effectful synchronous getter or global attempt slot.
- Each invocation has original acts, source/capture/snapshot, time and returned envelope/Basis.
  Resolve takes only request+evidence containing the complete signed closure, not redelivered acts.
  Per-invocation source final check describes captured basis, not atomic multi-peer/latest serving.
- `decorateChildren`/`readingResolversOf` (reading NAME), `applyResolvers` (full buckets), memo and
  annotations remain application-owned. Restore full names/original entries from envelope;
  a picked View alone cannot replace evidence. Current closure/historical marks use this
  invocation's explicit present basis rather than another clock read.

## Ten required actual-door schedules

ACCEPTANCE M5 freezes these ten IDs and their exact schedules, including capacity probes in #8.

1. Actual Plant query matches prior View/HView bytes/digests, including bytes/negation; both
   registered and arbitrary nonregistered entities use package batch gather/resolve.
2. Durable Bed→Plant survives fresh-process envelope decode and close/reopen with original acts.
3. Bucket resolver sees full evidence: values7/9 give count2, retaining child reading names.
4. Present closure hides a target in both present/historical reads; unrelated row survives and
   definition-at can follow the historical operand instant.
5. External SQLite deletion/equal-count replacement: old in-flight basis refuses, next new batch
   capture reflects physical inventory, unrelated rows survive. No maintained reconciliation CAS.
6. Distinct explicit now values cross validity without ingest; same bytes/different authority
   never reuse authorization. Present/historical batch contexts remain independent.
7. Close/reopen, discard all native registrations/caches, reconstruct original published acts,
   run new batch reads; unavailable source refuses. Portable retirement is an M3 gate only.
8. Bound/channel/governed/pinned/subscription/private bystanders remain green. Capacity probes:
   4096/4097 total selected appearances (definitions included if members), plus exact/over encoded
   INPUT byte limits with carrier overhead counted. Exact boundary is portable when all other
   limits fit; over boundary explicitly native with unchanged answers. Output overflow after
   valid input is visible. Missing promised act is an error. Classification is observable to tests.
9. Two concurrent async preparations for distinct arbitrary roots retain separate source/time/
   authority; paused stale one fails once, new-basis one succeeds. No retry/global context/fallback.
10. Pin published B; ingest then ordinary read uses a new batch basis without admin CAS. Prove real
    production package calls, remove obsolete eligible duplication, preserve excluded consumers.

Use real journal-backed stores for removal/restart/authority tests. Record total selected
appearances, snapshot/capture/delivery/envelope/result byte sizes INCLUDING carriers for actual
Plant/Bed fixtures before M5 acceptance. Full source snapshots/results and correctness come before
optimization. This is one bounded subset, not whole-Loam migration. If exact signed closure
extraction or frozen native capacity classification cannot preserve the actual selected door,
report the concrete counterexample to supervisor; do not invent a fallback or unsigned law.
