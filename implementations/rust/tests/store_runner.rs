//! Rails for the conformance runner's own rules (vectors/store/README.md §3). The runner is
//! what holds a consumer's store to the contract, so each rule it applies needs a store that
//! breaks exactly that rule, and a store that sits on the legal side of it.
//!
//! The memory store is class `unprovable`, so half of the purge rules never run against it.
//! `Standin` relabels the memory store as class `proven`: it takes a peer of either posture,
//! and its purge reports say `proven` with every surface absent. It proves nothing; it exists
//! so that the runner's rules for a proven store are exercised.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use rhizomatic::memory_store::MemoryStore;
use rhizomatic::store::{
    Admission, AppendResult, ArrivalRecord, ErasureClaim, ErasureClass, ErasurePosture, Exporter,
    PeerErasure, PeerStore, PurgeReport, Revision, ScopeRequest, ScopeResult, Snapshot, Store,
    StoreError, StoreErrorCode, StoreProfile, SurfaceState,
};
use rhizomatic::store_conformance::{run_store_conformance, StoreConformanceError, StoreVectors};
use rhizomatic::types::Delta;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Quirk {
    /// A faithful class-`proven` store.
    None,
    /// Says `unproven` where it could say `proven`. Legal: a store may claim less.
    ClaimsLess,
    /// Claims `proven` and declares no surface.
    ProvenWithoutSurfaces,
    /// Claims `proven` beside a surface it reports `unprovable`.
    ProvenWithAnUnprovableSurface,
    /// Says `unproven` when it removed nothing.
    UnprovenForNothing,
    /// Refuses a query on a moved snapshot with a code that is not `snapshot-moved`.
    WrongCodeWhenMoved,
    /// A scope member carries an arrival record the peer did not admit.
    AnotherArrivalInScope,
    /// A `conflict` moves the revision.
    MovesOnConflict,
    /// A refused append moves the revision.
    MovesOnRefusal,
}

type Shared<T> = Rc<RefCell<BTreeMap<String, T>>>;

struct Standin {
    inner: MemoryStore,
    quirk: Quirk,
    profile: StoreProfile,
    postures: Shared<ErasurePosture>,
    /// How far each peer's reported revision runs ahead of the memory store's.
    ahead: Shared<u64>,
}

impl Standin {
    fn new(quirk: Quirk) -> Self {
        let inner = MemoryStore::new();
        let mut profile = inner.profile().clone();
        profile.capabilities.erasure = ErasureClass::Proven;
        profile.format_version = "rhizomatic.test.proven-standin/1".into();
        Self {
            inner,
            quirk,
            profile,
            postures: Shared::default(),
            ahead: Shared::default(),
        }
    }

    fn handle(&self, id: &str, inner: Box<dyn PeerStore>) -> Box<dyn PeerStore> {
        Box::new(StandinPeer {
            inner,
            quirk: self.quirk,
            id: id.to_string(),
            posture: self.postures.borrow()[id],
            ahead: self.ahead.clone(),
        })
    }
}

impl Store for Standin {
    fn profile(&self) -> &StoreProfile {
        &self.profile
    }
    fn create_peer(&self, id: &str, e: ErasurePosture) -> Result<Box<dyn PeerStore>, StoreError> {
        // The memory store takes no peer that promises proof; the stand-in records the promise.
        let inner = self.inner.create_peer(id, ErasurePosture::Unproven)?;
        self.postures.borrow_mut().insert(id.to_string(), e);
        Ok(self.handle(id, inner))
    }
    fn peer(&self, id: &str) -> Result<Box<dyn PeerStore>, StoreError> {
        Ok(self.handle(id, self.inner.peer(id)?))
    }
    fn open_admin(&self) -> Box<dyn Exporter> {
        self.inner.open_admin()
    }
    fn close(&self) {
        self.inner.close()
    }
}

struct StandinPeer {
    inner: Box<dyn PeerStore>,
    quirk: Quirk,
    id: String,
    posture: ErasurePosture,
    ahead: Shared<u64>,
}

impl StandinPeer {
    fn ahead(&self) -> u64 {
        self.ahead.borrow().get(&self.id).copied().unwrap_or(0)
    }
    fn revision(&self, inner: Revision) -> Revision {
        Revision(inner.0 + self.ahead())
    }
    fn move_revision(&self) {
        *self.ahead.borrow_mut().entry(self.id.clone()).or_default() += 1;
    }
}

impl PeerStore for StandinPeer {
    fn id(&self) -> &str {
        &self.id
    }
    fn erasure(&self) -> PeerErasure {
        PeerErasure {
            posture: self.posture,
            store_class: ErasureClass::Proven,
        }
    }
    fn read(&self) -> Result<Box<dyn Snapshot>, StoreError> {
        let inner = self.inner.read()?;
        Ok(Box::new(StandinSnapshot {
            revision: self.revision(inner.revision()),
            inner,
            quirk: self.quirk,
        }))
    }
    fn append(&self, batch: &Admission) -> Result<AppendResult, StoreError> {
        match self.inner.append(batch) {
            Ok(AppendResult::Committed { revision, added }) => Ok(AppendResult::Committed {
                revision: self.revision(revision),
                added,
            }),
            Ok(other) => {
                if self.quirk == Quirk::MovesOnConflict {
                    self.move_revision();
                }
                Ok(other)
            }
            Err(refusal) => {
                if self.quirk == Quirk::MovesOnRefusal {
                    self.move_revision();
                }
                Err(refusal)
            }
        }
    }
    fn purge(&self, ids: &[String]) -> Result<PurgeReport, StoreError> {
        let mut report = self.inner.purge(ids)?;
        report.revision = self.revision(report.revision);
        let removed = report.claim == ErasureClaim::Unproven;
        if self.quirk != Quirk::ProvenWithAnUnprovableSurface {
            for surface in &mut report.surfaces {
                surface.state = SurfaceState::Absent;
            }
        }
        report.claim = match (removed, self.quirk) {
            (true, Quirk::ClaimsLess) => ErasureClaim::Unproven,
            (true, _) => ErasureClaim::Proven,
            (false, Quirk::UnprovenForNothing) => ErasureClaim::Unproven,
            (false, _) => ErasureClaim::NothingRemoved,
        };
        if removed && self.quirk == Quirk::ProvenWithoutSurfaces {
            report.surfaces.clear();
        }
        Ok(report)
    }
}

struct StandinSnapshot {
    inner: Box<dyn Snapshot>,
    revision: Revision,
    quirk: Quirk,
}

impl StandinSnapshot {
    fn answer<T>(&self, result: Result<T, StoreError>) -> Result<T, StoreError> {
        result.map_err(|mut refusal| {
            if self.quirk == Quirk::WrongCodeWhenMoved
                && refusal.code == StoreErrorCode::SnapshotMoved
            {
                refusal.code = StoreErrorCode::PeerAbsent;
            }
            refusal
        })
    }
}

impl Snapshot for StandinSnapshot {
    fn revision(&self) -> Revision {
        self.revision
    }
    fn head(&self) -> Option<&str> {
        self.inner.head()
    }
    fn count(&self) -> u64 {
        self.inner.count()
    }
    fn get(&self, ids: &[String]) -> Result<Vec<Delta>, StoreError> {
        self.answer(self.inner.get(ids))
    }
    fn arrivals(&self, ids: &[String]) -> Result<Vec<ArrivalRecord>, StoreError> {
        self.answer(self.inner.arrivals(ids))
    }
    fn targets(&self, entities: &[String]) -> Result<Vec<String>, StoreError> {
        self.answer(self.inner.targets(entities))
    }
    fn negators(&self, ids: &[String]) -> Result<Vec<String>, StoreError> {
        self.answer(self.inner.negators(ids))
    }
    fn scope(&self, request: &ScopeRequest) -> Result<ScopeResult, StoreError> {
        let mut answer = self.answer(self.inner.scope(request))?;
        if self.quirk == Quirk::AnotherArrivalInScope {
            for member in &mut answer.deltas {
                member.arrival.at += 1.0;
            }
        }
        Ok(answer)
    }
    fn release(&mut self) {
        self.inner.release()
    }
}

fn vectors() -> StoreVectors {
    let load = |file: &str| -> Value {
        let path = format!("{}/../../vectors/store/{file}", env!("CARGO_MANIFEST_DIR"));
        serde_json::from_str(&std::fs::read_to_string(path).expect("read store vectors")).unwrap()
    };
    StoreVectors {
        scripts: load("scripts.json"),
        scope: load("scope.json"),
    }
}

fn run(quirk: Quirk) -> Result<usize, StoreConformanceError> {
    let factory = || Ok(Box::new(Standin::new(quirk)) as Box<dyn Store>);
    run_store_conformance(&factory, &vectors()).map(|report| {
        assert_eq!(report.skipped, vec![], "{quirk:?}");
        report.passed.len()
    })
}

/// The failed names. Every failure message must carry the intended reason.
fn failed(quirk: Quirk, reason: &str) -> Vec<String> {
    let error = run(quirk).expect_err("the runner must fail this store");
    for failure in &error.failures {
        assert!(
            failure.message.contains(reason),
            "{quirk:?} failed {} for another reason: {}",
            failure.name,
            failure.message
        );
    }
    error.failures.into_iter().map(|f| f.name).collect()
}

const PURGES_THAT_REMOVE: [&str; 5] = [
    "scripts/purge",
    "scripts/purge-clears-a-debt-on-append",
    "scripts/a-snapshot-across-a-purge",
    "scripts/the-last-sequence-survives-a-purge",
    "scripts/the-last-sequence-survives-an-empty-peer",
];

/// §3.1: with `unlessStoreErasure: proven`, a proven store creates the peer that an unprovable
/// store refuses. §3.4: where a target is removed, a proven store's claim is `proven`.
#[test]
fn a_proven_store_passes_and_creates_the_peer_that_promises_proof() {
    assert_eq!(run(Quirk::None).unwrap(), 21 + 15);
}

/// §3.4: "where E is `proven`, `unproven` also conforms."
#[test]
fn a_proven_store_may_claim_less() {
    assert_eq!(run(Quirk::ClaimsLess).unwrap(), 21 + 15);
}

/// §3.4: "If `claim` is `proven`: the surface list is not empty and every state is `absent`."
#[test]
fn proven_needs_a_surface_and_every_surface_absent() {
    let reason = "claims `proven` without a surface, or with one that is not absent";
    assert_eq!(
        failed(Quirk::ProvenWithoutSurfaces, reason),
        PURGES_THAT_REMOVE
    );
    assert_eq!(
        failed(Quirk::ProvenWithAnUnprovableSurface, reason),
        PURGES_THAT_REMOVE
    );
}

/// §3.4: "`unproven` never conforms where E is `nothing-removed`."
#[test]
fn unproven_does_not_stand_in_for_nothing_removed() {
    let reason = "expected claim `nothing-removed`, the store claimed `unproven`";
    let names = failed(Quirk::UnprovenForNothing, reason);
    assert_eq!(
        names,
        ["scripts/purge", "scripts/purge-clears-a-debt-on-append"]
    );
}

/// §3.7: with `orError`, only that one refusal conforms. "Any other answer or refusal fails."
#[test]
fn or_error_accepts_one_code_only() {
    let names = failed(Quirk::WrongCodeWhenMoved, "the store refused `peer-absent`");
    assert_eq!(
        names,
        [
            "scripts/snapshots",
            "scripts/a-snapshot-across-a-purge",
            "scripts/an-older-handle-stays-valid",
        ]
    );
}

/// §3.7: every scope member "carries that peer's arrival record".
#[test]
fn a_scope_member_carries_the_arrival_record_the_peer_admitted() {
    let names = failed(
        Quirk::AnotherArrivalInScope,
        "does not carry the arrival record",
    );
    assert!(
        names.contains(&"scripts/negation-chains".to_string()),
        "{names:?}"
    );
    assert!(
        names.contains(&"scope/no-selection".to_string()),
        "{names:?}"
    );
}

/// §3.3: `{"status": "conflict"}`. "The revision does not change."
#[test]
fn a_conflict_does_not_move_the_revision() {
    let names = failed(Quirk::MovesOnConflict, "the revision changed");
    assert_eq!(
        names,
        [
            "scripts/head-compare-and-set",
            "scripts/an-older-handle-stays-valid",
            "scripts/append-checks-before-and-after-the-head",
        ]
    );
}

/// §3.3: `{"error": …}`. "The revision does not change."
#[test]
fn a_refused_append_does_not_move_the_revision() {
    let names = failed(Quirk::MovesOnRefusal, "the revision changed");
    for script in [
        "scripts/a-refused-append-leaves-nothing",
        "scripts/requests-a-store-refuses",
        "scripts/a-frame-needs-the-journal",
    ] {
        assert!(names.contains(&script.to_string()), "{names:?}");
    }
}
