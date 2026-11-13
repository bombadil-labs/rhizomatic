//! Broken-store rails for the conformance runner (SPEC-18 proposal §8). Each store below is the
//! memory store with one deliberate fault. The runner must fail it, in the scripts and for the
//! reason the fault names. A faithful wrapper passes, so the faults alone cause the failures.
//! These stores declare their own format version: the runner holds them to the general rules,
//! not to the memory reference rules.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use rhizomatic::memory_store::MemoryStore;
use rhizomatic::store::{
    Admission, Anchor, AppendResult, ArrivalRecord, ChangePage, ErasureClaim, ErasurePosture,
    Exporter, Listing, PeerErasure, PeerExporter, PeerStore, PurgeReport, PushdownFields, Revision,
    ScopeRequest, ScopeResult, Snapshot, Store, StoreError, StoreProfile,
};
use rhizomatic::store_conformance::{run_store_conformance, StoreConformanceError, StoreVectors};
use rhizomatic::types::Delta;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Fault {
    None,
    /// `scope` leaves out every negation.
    DropsNegators,
    /// `scope` also returns what points at an entity nobody asked for.
    ReturnsOutsideTheScope,
    /// `scope` reports every requested pushdown field applied and applies none.
    ClaimsPushdown,
    /// `scope` walks the chains over every holding and applies the selection afterwards.
    FiltersAfterTheWalk,
    /// A peer's export lists every id the store keeps.
    ListsOtherPeers,
    /// `append` commits whatever the expected head is.
    IgnoresHead,
    /// A second append of a held id replaces its arrival record.
    KeepsLastArrival,
    /// `append` reports held ids as newly added.
    ReportsHeldAsAdded,
    /// `purge` claims `proven` whatever it did, on a store that cannot prove absence.
    ClaimsProven,
}

type Latest = Rc<RefCell<BTreeMap<(String, String), ArrivalRecord>>>;

struct Faulty {
    inner: Rc<MemoryStore>,
    fault: Fault,
    profile: StoreProfile,
    latest: Latest,
}

impl Faulty {
    fn new(fault: Fault) -> Self {
        let inner = MemoryStore::new();
        let mut profile = inner.profile().clone();
        profile.format_version = "rhizomatic.test.faulty/1".into();
        Self {
            inner: Rc::new(inner),
            fault,
            profile,
            latest: Latest::default(),
        }
    }

    fn wrap(&self, id: &str, peer: Box<dyn PeerStore>) -> Box<dyn PeerStore> {
        Box::new(FaultyPeer {
            inner: peer,
            fault: self.fault,
            id: id.to_string(),
            latest: self.latest.clone(),
        })
    }
}

impl Store for Faulty {
    fn profile(&self) -> &StoreProfile {
        &self.profile
    }
    fn create_peer(&self, id: &str, e: ErasurePosture) -> Result<Box<dyn PeerStore>, StoreError> {
        Ok(self.wrap(id, self.inner.create_peer(id, e)?))
    }
    fn peer(&self, id: &str) -> Result<Box<dyn PeerStore>, StoreError> {
        Ok(self.wrap(id, self.inner.peer(id)?))
    }
    fn open_admin(&self) -> Box<dyn Exporter> {
        Box::new(FaultyExporter {
            inner: self.inner.clone(),
            fault: self.fault,
        })
    }
    fn close(&self) {
        self.inner.close()
    }
}

struct FaultyPeer {
    inner: Box<dyn PeerStore>,
    fault: Fault,
    id: String,
    latest: Latest,
}

impl PeerStore for FaultyPeer {
    fn id(&self) -> &str {
        &self.id
    }
    fn erasure(&self) -> PeerErasure {
        self.inner.erasure()
    }
    fn read(&self) -> Result<Box<dyn Snapshot>, StoreError> {
        Ok(Box::new(FaultySnapshot {
            inner: self.inner.read()?,
            fault: self.fault,
            peer: self.id.clone(),
            latest: self.latest.clone(),
        }))
    }
    fn append(&self, batch: &Admission) -> Result<AppendResult, StoreError> {
        let mut batch = batch.clone();
        if self.fault == Fault::IgnoresHead {
            batch.expected_head = self.inner.read()?.head().map(str::to_string);
        }
        let result = self.inner.append(&batch)?;
        let AppendResult::Committed { revision, added } = result else {
            return Ok(result);
        };
        for entry in &batch.added {
            let key = (self.id.clone(), entry.delta.id.clone());
            self.latest.borrow_mut().insert(key, entry.arrival.clone());
        }
        let added = match self.fault {
            Fault::ReportsHeldAsAdded => {
                let mut all: Vec<String> = batch.added.iter().map(|e| e.delta.id.clone()).collect();
                all.sort();
                all.dedup();
                all
            }
            _ => added,
        };
        Ok(AppendResult::Committed { revision, added })
    }
    fn purge(&self, ids: &[String]) -> Result<PurgeReport, StoreError> {
        let mut report = self.inner.purge(ids)?;
        if self.fault == Fault::ClaimsProven {
            report.claim = ErasureClaim::Proven;
        }
        Ok(report)
    }
    fn changes(&self, from: Revision, to: Option<Revision>) -> Result<ChangePage, StoreError> {
        self.inner.changes(from, to)
    }
}

struct FaultySnapshot {
    inner: Box<dyn Snapshot>,
    fault: Fault,
    peer: String,
    latest: Latest,
}

impl FaultySnapshot {
    fn arrival(&self, first: ArrivalRecord) -> ArrivalRecord {
        if self.fault != Fault::KeepsLastArrival {
            return first;
        }
        let key = (self.peer.clone(), first.id.clone());
        self.latest.borrow().get(&key).cloned().unwrap_or(first)
    }
}

impl Snapshot for FaultySnapshot {
    fn revision(&self) -> Revision {
        self.inner.revision()
    }
    fn head(&self) -> Option<&str> {
        self.inner.head()
    }
    fn count(&self) -> u64 {
        self.inner.count()
    }
    fn get(&self, ids: &[String]) -> Result<Vec<Delta>, StoreError> {
        self.inner.get(ids)
    }
    fn arrivals(&self, ids: &[String]) -> Result<Vec<ArrivalRecord>, StoreError> {
        let records = self.inner.arrivals(ids)?;
        Ok(records.into_iter().map(|r| self.arrival(r)).collect())
    }
    fn targets(&self, entities: &[String]) -> Result<Vec<String>, StoreError> {
        self.inner.targets(entities)
    }
    fn negators(&self, ids: &[String]) -> Result<Vec<String>, StoreError> {
        self.inner.negators(ids)
    }
    fn scope(&self, request: &ScopeRequest) -> Result<ScopeResult, StoreError> {
        let mut asked = request.clone();
        match self.fault {
            Fault::ReturnsOutsideTheScope => asked.anchors.push(Anchor::Entity {
                entity: "elsewhere".into(),
            }),
            Fault::ClaimsPushdown | Fault::FiltersAfterTheWalk => {
                // An illegal bound is still refused; a legal one is dropped.
                self.inner.scope(request)?;
                asked.pushdown = None
            }
            _ => {}
        }
        let mut answer = self.inner.scope(&asked)?;
        match self.fault {
            Fault::DropsNegators => answer.deltas.retain(|member| {
                let mut pointers = member.delta.claims.pointers.iter();
                !pointers.any(|p| p.role == "negates")
            }),
            Fault::ClaimsPushdown | Fault::FiltersAfterTheWalk => {
                let requested = request.pushdown.clone().unwrap_or_default();
                if self.fault == Fault::FiltersAfterTheWalk {
                    answer.deltas.retain(|member| {
                        let dropped = requested.exclude_ids.iter().flatten();
                        requested
                            .timestamp_at_most
                            .is_none_or(|t| member.delta.claims.timestamp <= t)
                            && requested
                                .arrival_at_most
                                .is_none_or(|n| member.arrival.sequence <= n)
                            && !dropped.into_iter().any(|id| *id == member.delta.id)
                    });
                }
                answer.applied = PushdownFields {
                    timestamp_at_most: requested.timestamp_at_most.is_some(),
                    arrival_at_most: requested.arrival_at_most.is_some(),
                    exclude_ids: requested.exclude_ids.is_some(),
                };
            }
            _ => {}
        }
        for member in &mut answer.deltas {
            member.arrival = self.arrival(member.arrival.clone());
        }
        Ok(answer)
    }
    fn release(&mut self) {
        self.inner.release()
    }
}

struct FaultyExporter {
    inner: Rc<MemoryStore>,
    fault: Fault,
}

impl Exporter for FaultyExporter {
    fn peers(&self) -> Listing<'_, String> {
        Box::new(
            self.inner
                .open_admin()
                .peers()
                .collect::<Vec<_>>()
                .into_iter(),
        )
    }
    fn peer(&self, id: &str) -> Result<Box<dyn PeerExporter>, StoreError> {
        Ok(Box::new(FaultyPeerExporter {
            inner: self.inner.open_admin().peer(id)?,
            store: self.inner.clone(),
            fault: self.fault,
        }))
    }
    fn stored_ids(&self) -> Listing<'_, String> {
        let ids: Vec<_> = self.inner.open_admin().stored_ids().collect();
        Box::new(ids.into_iter())
    }
}

struct FaultyPeerExporter {
    inner: Box<dyn PeerExporter>,
    store: Rc<MemoryStore>,
    fault: Fault,
}

impl PeerExporter for FaultyPeerExporter {
    fn ids(&self) -> Listing<'_, String> {
        if self.fault == Fault::ListsOtherPeers {
            let ids: Vec<_> = self.store.open_admin().stored_ids().collect();
            return Box::new(ids.into_iter());
        }
        self.inner.ids()
    }
    fn deltas(&self) -> Listing<'_, Delta> {
        self.inner.deltas()
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

fn run(fault: Fault) -> Result<usize, StoreConformanceError> {
    run_store_conformance(
        &|| Ok(Box::new(Faulty::new(fault)) as Box<dyn Store>),
        &vectors(),
    )
    .map(|report| report.passed.len())
}

/// The failed names, and a check that every failure message carries one of the intended reasons.
fn failed(fault: Fault, reasons: &[&str]) -> Vec<String> {
    let error = run(fault).expect_err("a broken store must fail conformance");
    for failure in &error.failures {
        assert!(
            reasons
                .iter()
                .any(|reason| failure.message.contains(reason)),
            "{fault:?} failed {} for another reason: {}",
            failure.name,
            failure.message
        );
    }
    error.failures.into_iter().map(|f| f.name).collect()
}

#[test]
fn a_faithful_store_that_is_not_the_reference_passes() {
    assert_eq!(run(Fault::None).unwrap(), 25 + 15);
}

#[test]
fn a_store_that_drops_a_negator_from_scope_fails_the_lower_bound() {
    let names = failed(
        Fault::DropsNegators,
        &["lower bound: the scope answer lacks"],
    );
    assert_eq!(
        names,
        [
            "scripts/negation-chains",
            "scripts/negation-before-its-target",
            "scripts/two-peers-share-bytes",
            "scripts/snapshots",
            "scripts/scope-pushdown-and-exclude",
            "scope/no-selection",
            "scope/two-anchors",
            "scope/through-a-second-handle",
            "scope/signed-time-cuts-a-chain",
            "scope/arrival-cuts-a-chain",
            "scope/excluded-ids-cut-a-chain",
            "scope/a-negator-without-its-target",
            "scope/every-field",
            "scope/a-negation-signed-before-its-target",
            "scope/the-selection-admits-nothing",
            "scope/held-middle-of-a-chain",
            "scope/held-ids-that-fail-the-selection",
        ]
    );
}

#[test]
fn a_store_that_returns_ids_outside_the_scope_fails_the_upper_bound() {
    let names = failed(
        Fault::ReturnsOutsideTheScope,
        &["upper bound: the scope answer holds"],
    );
    assert!(names.contains(&"scripts/negation-chains".to_string()));
    assert!(names.contains(&"scope/no-anchors".to_string()));
    assert!(names.contains(&"scope/no-selection".to_string()));
}

#[test]
fn a_store_that_claims_a_pushdown_it_did_not_apply_fails_the_exact_upper_bound() {
    // The scripts check only the loose bound S(A over H), so they cannot see this fault. The
    // scope cases can: an answer member fails a field the store reported applied.
    let names = failed(Fault::ClaimsPushdown, &["fails a field reported applied"]);
    assert_eq!(
        names,
        [
            "scope/through-a-second-handle",
            "scope/signed-time-cuts-a-chain",
            "scope/arrival-cuts-a-chain",
            "scope/excluded-ids-cut-a-chain",
            "scope/a-negator-without-its-target",
            "scope/every-field",
            "scope/a-negation-signed-before-its-target",
            "scope/the-selection-admits-nothing",
            "scope/held-ids-that-fail-the-selection",
        ]
    );
}

#[test]
fn a_store_that_selects_after_the_walk_fails_the_exact_upper_bound() {
    // Every member it returns passes the selection, and still the answer is too large: it keeps
    // a negation whose target the selection dropped.
    let names = failed(
        Fault::FiltersAfterTheWalk,
        &["fails a field reported applied"],
    );
    for case in [
        "scope/a-negator-without-its-target",
        "scope/a-negation-signed-before-its-target",
    ] {
        assert!(names.contains(&case.to_string()), "{names:?}");
    }
    assert!(
        names.iter().all(|name| name.starts_with("scope/")),
        "{names:?}"
    );
}

#[test]
fn a_store_that_lists_another_peers_ids_fails_export() {
    let names = failed(Fault::ListsOtherPeers, &["export ids: expected ids"]);
    assert_eq!(names, ["scripts/two-peers-share-bytes", "scripts/purge"]);
}

#[test]
fn a_store_that_ignores_the_head_fails_the_compare_and_set() {
    // A stale head must answer `conflict` whatever the batch holds. This store commits a good
    // batch and refuses a bad one; both are wrong.
    let reasons = [
        "expected status `conflict`, the store answered",
        "append refused `invalid-admission`",
    ];
    let names = failed(Fault::IgnoresHead, &reasons);
    assert_eq!(
        names,
        [
            "scripts/head-compare-and-set",
            "scripts/an-older-handle-stays-valid",
            "scripts/append-checks-before-and-after-the-head",
            "scripts/feed-appends-and-head-only-commits",
        ]
    );
}

#[test]
fn a_store_that_replaces_an_arrival_record_fails_idempotence() {
    let names = failed(Fault::KeepsLastArrival, &["first admitted"]);
    assert_eq!(
        names,
        [
            "scripts/duplicates-add-nothing",
            "scripts/a-skipped-entry-spends-no-sequence",
            "scripts/the-first-appearance-is-kept",
            "scripts/append-checks-before-and-after-the-head",
        ]
    );
}

#[test]
fn a_store_that_reports_held_ids_as_added_fails_idempotence() {
    let names = failed(Fault::ReportsHeldAsAdded, &["append added: expected ids"]);
    assert_eq!(
        names,
        [
            "scripts/duplicates-add-nothing",
            "scripts/a-skipped-entry-spends-no-sequence",
            "scripts/the-first-appearance-is-kept",
            "scripts/append-checks-before-and-after-the-head",
            "scripts/feed-appends-and-head-only-commits",
        ]
    );
}

#[test]
fn a_store_that_claims_proof_it_cannot_give_fails_every_purge() {
    // The first purge of each purge script fails, whether it removed a target (`unproven`
    // expected) or not (`nothing-removed` expected). A store may claim less, never more.
    let names = failed(
        Fault::ClaimsProven,
        &[
            "expected claim `unproven`, the store claimed `proven`",
            "expected claim `nothing-removed`, the store claimed `proven`",
        ],
    );
    assert_eq!(
        names,
        [
            "scripts/purge",
            "scripts/purge-clears-a-debt-on-append",
            "scripts/a-snapshot-across-a-purge",
            "scripts/the-last-sequence-survives-a-purge",
            "scripts/the-last-sequence-survives-an-empty-peer",
            "scripts/feed-purge-and-debts",
            "scripts/feed-a-debt-ends-on-append",
        ]
    );
}
