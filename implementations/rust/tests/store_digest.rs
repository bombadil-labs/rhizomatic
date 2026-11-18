//! The holdings digest on the memory store (SPEC-18 proposal §4.7.6; §4.13 readings 139 to 142;
//! `vectors/store/README.md` §12): the shared vectors `digest.json`; the root after every append
//! and purge of the shared store scripts; the root and every node against the reference
//! `digest_of` at every size from 0 to 40 and back; one root for one set in any order; and the
//! strict call. The memory tests of TypeScript's `store-digest.test.ts`. The damage tests of
//! `fsck` are in `src/memory_store.rs`, beside the state they damage.

use std::cell::Cell;
use std::collections::BTreeSet;

use rhizomatic::json_profile::parse_claims;
use rhizomatic::memory_store::MemoryStore;
use rhizomatic::set::make_delta;
use rhizomatic::store::{
    Admission, AppendResult, ChangePage, CreatePeerOptions, ErasurePosture, Exporter, PeerErasure,
    PeerStore, PurgeReport, Revision, Snapshot, Store, StoreError, StoreErrorCode, StoreFailure,
    StoreProfile,
};
use rhizomatic::store_admission::{admission_of, AdmissionOptions};
use rhizomatic::store_conformance::{run_digest_conformance, run_store_conformance, StoreVectors};
use rhizomatic::store_digest::{digest_of, empty_digest, DigestNode};
use rhizomatic::types::{Claims, Delta, EntityRef, Pointer, Target};
use serde_json::Value;

fn load(file: &str) -> Value {
    let path = format!("{}/../../vectors/store/{file}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).expect("read store vectors")).unwrap()
}

/// The 38 deltas of the vectors (20 share `1e20c0d`, 12 more `1e20c0`), and 2 more of `1e20c0`,
/// made as TypeScript makes them.
fn forty() -> Vec<Delta> {
    let doc = load("digest.json");
    let mut deltas: Vec<Delta> = doc["deltas"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| Delta {
            id: d["id"].as_str().unwrap().to_string(),
            claims: parse_claims(&d["claims"]).unwrap(),
            sig: None,
        })
        .collect();
    assert_eq!(deltas.len(), 38);
    let mut t = 5_000_000u64;
    while deltas.len() < 40 {
        let claims = Claims {
            timestamp: t as f64,
            valid_from: 0.0,
            valid_until: None,
            author: "did:key:zDigestExtra".into(),
            pointers: vec![Pointer {
                role: "about".into(),
                target: Target::Entity(EntityRef {
                    id: format!("x:{t}"),
                    context: None,
                }),
            }],
        };
        let delta = make_delta(claims, None).unwrap();
        if delta.id.starts_with("1e20c0") && !delta.id.starts_with("1e20c0d") {
            deltas.push(delta);
        }
        t += 1;
    }
    deltas
}

thread_local! {
    static HEADS: Cell<u64> = const { Cell::new(0) };
}

fn add(peer: &dyn PeerStore, deltas: &[Delta]) {
    let mut now = peer.read().unwrap();
    now.release();
    let head = HEADS.with(|h| {
        h.set(h.get() + 1);
        h.get()
    });
    let options = AdmissionOptions {
        at: 1.0,
        sender: "digest".into(),
        next_head: format!("h-{head}"),
    };
    let batch = admission_of(now.as_ref(), deltas, options).unwrap();
    assert!(matches!(
        peer.append(&batch).unwrap(),
        AppendResult::Committed { .. }
    ));
}

fn ids(deltas: &[Delta]) -> Vec<String> {
    deltas.iter().map(|d| d.id.clone()).collect()
}

fn unproven() -> CreatePeerOptions {
    CreatePeerOptions::new(ErasurePosture::Unproven)
}

fn code<T: std::fmt::Debug>(answer: Result<T, StoreFailure>) -> StoreErrorCode {
    match answer {
        Err(StoreFailure::Refused(e)) => e.code,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

/// The root, and the node of every prefix of every held id up to 12 digits, of each whole id,
/// and of two prefixes no held id starts with, on a new snapshot, against the reference over
/// `held`. The prefixes cover every node the store keeps, and prefixes below each leaf.
fn agrees(peer: &dyn PeerStore, held: &BTreeSet<String>) {
    let mut snapshot = peer.read().unwrap();
    let held: Vec<String> = held.iter().cloned().collect();
    let want = digest_of(&held, "").unwrap();
    assert_eq!(
        (snapshot.root(), snapshot.count()),
        (Some(want.hash.as_str()), held.len() as u64)
    );
    let mut prefixes: BTreeSet<String> = ["", "1e20c0d0", "ff"].map(String::from).into();
    for id in &held {
        prefixes.extend((0..=12).map(|k| id[..k].to_string()));
        prefixes.insert(id.clone());
    }
    for prefix in &prefixes {
        assert_eq!(
            (prefix, snapshot.digest(prefix).unwrap()),
            (prefix, digest_of(&held, prefix).unwrap())
        );
    }
    snapshot.release();
}

#[test]
fn every_tree_and_every_case_of_digest_json_passes_on_the_memory_store_and_none_is_skipped() {
    let doc = load("digest.json");
    let report =
        run_digest_conformance(&|| Ok(Box::new(MemoryStore::new()) as Box<dyn Store>), &doc)
            .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(report.skipped, vec![]);
    let names = |list: &str, part: &str| -> Vec<String> {
        doc[list]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| format!("{part}/{}", x["name"].as_str().unwrap()))
            .collect()
    };
    let mut want = names("trees", "trees");
    want.extend(names("cases", "digest"));
    assert_eq!(report.passed, want);
    assert_eq!(want.len(), 12 + 6);
    assert_eq!(doc["hash"]["empty"].as_str().unwrap(), empty_digest().hash);
}

/// The memory store, with the root and the node of the root checked against the reference over
/// the peer's holdings after every append and every purge that answers.
struct Rooted(MemoryStore);

struct RootedPeer {
    inner: Box<dyn PeerStore>,
    admin: Box<dyn Exporter>,
}

impl RootedPeer {
    fn check(&self) {
        let held: Vec<String> = self
            .admin
            .peer(self.inner.id())
            .unwrap()
            .ids()
            .map(Result::unwrap)
            .collect();
        let want = digest_of(&held, "").unwrap();
        let mut snapshot = self.inner.read().unwrap();
        let top = snapshot.digest("").unwrap();
        assert_eq!(
            (snapshot.root(), &top),
            (Some(want.hash.as_str()), &want),
            "peer {}: the root is not the reference's over its {} ids",
            self.inner.id(),
            held.len()
        );
        snapshot.release();
    }
}

impl PeerStore for RootedPeer {
    fn id(&self) -> &str {
        self.inner.id()
    }
    fn erasure(&self) -> PeerErasure {
        self.inner.erasure()
    }
    fn history(&self) -> Result<&str, StoreError> {
        self.inner.history()
    }
    fn app_format(&self) -> Result<Option<&str>, StoreError> {
        self.inner.app_format()
    }
    fn read(&self) -> Result<Box<dyn Snapshot>, StoreError> {
        self.inner.read()
    }
    fn append(&self, batch: &Admission) -> Result<AppendResult, StoreError> {
        let result = self.inner.append(batch);
        if result.is_ok() {
            self.check();
        }
        result
    }
    fn purge(&self, ids: &[String]) -> Result<PurgeReport, StoreFailure> {
        let report = self.inner.purge(ids);
        if report.is_ok() {
            self.check();
        }
        report
    }
    fn changes(&self, from: Revision, to: Option<Revision>) -> Result<ChangePage, StoreFailure> {
        self.inner.changes(from, to)
    }
}

impl Store for Rooted {
    fn profile(&self) -> &StoreProfile {
        self.0.profile()
    }
    fn create_peer(
        &self,
        id: &str,
        options: &CreatePeerOptions,
    ) -> Result<Box<dyn PeerStore>, StoreError> {
        Ok(Box::new(RootedPeer {
            inner: self.0.create_peer(id, options)?,
            admin: self.0.open_admin(),
        }))
    }
    fn peer(&self, id: &str) -> Result<Box<dyn PeerStore>, StoreError> {
        Ok(Box::new(RootedPeer {
            inner: self.0.peer(id)?,
            admin: self.0.open_admin(),
        }))
    }
    fn open_admin(&self) -> Box<dyn Exporter> {
        self.0.open_admin()
    }
    fn close(&self) {
        self.0.close()
    }
}

#[test]
fn the_root_is_the_references_after_every_append_and_purge_of_the_shared_store_scripts() {
    let vectors = StoreVectors {
        scripts: load("scripts.json"),
        scope: load("scope.json"),
    };
    let report = run_store_conformance(
        &|| Ok(Box::new(Rooted(MemoryStore::new())) as Box<dyn Store>),
        &vectors,
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!((report.passed.len(), report.skipped.len()), (27 + 15, 0));
}

#[test]
fn the_root_and_every_node_equal_the_references_at_every_size_from_0_to_40_and_back_to_0_one_id_at_a_time_while_another_peer_holds_every_id(
) {
    let forty = forty();
    let store = MemoryStore::new();
    add(
        store.create_peer("peer:b", &unproven()).unwrap().as_ref(),
        &forty,
    );
    let peer = store.create_peer("peer:a", &unproven()).unwrap();
    let mut held = BTreeSet::new();
    // `fsck` also finds a row the update left below a merged node.
    let sound = |store: &MemoryStore| {
        assert_eq!(store.open_admin().fsck().unwrap().faults, vec![]);
    };
    agrees(peer.as_ref(), &held);
    for delta in &forty {
        add(peer.as_ref(), std::slice::from_ref(delta));
        held.insert(delta.id.clone());
        sound(&store);
        agrees(peer.as_ref(), &held);
    }
    for delta in forty.iter().rev() {
        peer.purge(std::slice::from_ref(&delta.id)).unwrap();
        held.remove(&delta.id);
        sound(&store);
        agrees(peer.as_ref(), &held);
    }
    assert_eq!(
        peer.read().unwrap().root(),
        Some(empty_digest().hash.as_str())
    );
}

#[test]
fn one_set_gives_one_root_in_any_order_of_arrival_and_after_a_purge_and_an_append_of_the_same_ids()
{
    let forty = forty();
    let store = MemoryStore::new();
    let want = digest_of(&ids(&forty), "").unwrap().hash;
    let mut seed: u64 = 7;
    let mut roots = Vec::new();
    for n in 0..4 {
        let peer = store
            .create_peer(&format!("peer:{n}"), &unproven())
            .unwrap();
        let mut order: Vec<(u64, Delta)> = forty
            .iter()
            .map(|d| {
                seed = (seed * 48271) % 2147483647;
                (seed, d.clone())
            })
            .collect();
        order.sort_by_key(|(k, _)| *k);
        let order: Vec<Delta> = order.into_iter().map(|(_, d)| d).collect();
        for chunk in order.chunks(7) {
            add(peer.as_ref(), chunk);
        }
        roots.push(peer.read().unwrap().root().unwrap().to_string());
    }
    assert_eq!(roots, vec![want.clone(); 4]);
    let peer = store.peer("peer:0").unwrap();
    let some = [forty[2].clone(), forty[19].clone(), forty[30].clone()];
    peer.purge(&ids(&some)).unwrap();
    let rest: Vec<String> = forty
        .iter()
        .filter(|d| !some.contains(d))
        .map(|d| d.id.clone())
        .collect();
    assert_eq!(
        peer.read().unwrap().root(),
        Some(digest_of(&rest, "").unwrap().hash.as_str())
    );
    let reversed: Vec<Delta> = some.iter().rev().cloned().collect();
    add(peer.as_ref(), &reversed);
    assert_eq!(peer.read().unwrap().root(), Some(want.as_str()));
}

#[test]
fn root_is_fixed_at_read_digest_answers_after_a_head_only_append_and_a_purge_that_releases_nothing_and_refuses_snapshot_moved_after_an_append_or_a_purge_that_changes_the_held_set(
) {
    let forty = forty();
    let store = MemoryStore::new();
    let peer = store.create_peer("peer:a", &unproven()).unwrap();
    let first = &forty[..18];
    add(peer.as_ref(), first);
    let old = peer.read().unwrap();
    let before = digest_of(&ids(first), "").unwrap();
    assert_eq!(old.root(), Some(before.hash.as_str()));
    add(peer.as_ref(), &[]);
    peer.purge(std::slice::from_ref(&forty[39].id)).unwrap();
    assert_eq!(old.digest("").unwrap(), before);
    add(peer.as_ref(), std::slice::from_ref(&forty[39]));
    assert_eq!(old.root(), Some(before.hash.as_str()));
    assert_eq!(code(old.digest("")), StoreErrorCode::SnapshotMoved);
    assert_eq!(code(old.digest("1e2011")), StoreErrorCode::SnapshotMoved);
    // The other calls of the snapshot still answer as at its revision.
    assert_eq!(
        old.get(std::slice::from_ref(&forty[39].id)).unwrap(),
        vec![]
    );
    let now = peer.read().unwrap();
    peer.purge(std::slice::from_ref(&forty[0].id)).unwrap();
    let mut held = ids(first);
    held.push(forty[39].id.clone());
    assert_eq!(
        now.root(),
        Some(digest_of(&held, "").unwrap().hash.as_str())
    );
    assert_eq!(code(now.digest("")), StoreErrorCode::SnapshotMoved);
    assert_eq!(code(now.digest("1E20")), StoreErrorCode::InvalidRequest);
    assert_eq!(
        code(peer.read().unwrap().digest("1e20 ")),
        StoreErrorCode::InvalidRequest
    );
}

#[test]
fn a_released_snapshot_and_a_closed_store_refuse_a_digest_call_and_keep_their_root() {
    let forty = forty();
    let store = MemoryStore::new();
    let peer = store.create_peer("peer:a", &unproven()).unwrap();
    add(peer.as_ref(), &forty[..3]);
    let root = digest_of(&ids(&forty[..3]), "").unwrap().hash;
    let mut released = peer.read().unwrap();
    released.release();
    assert_eq!(code(released.digest("")), StoreErrorCode::SnapshotReleased);
    assert_eq!(released.root(), Some(root.as_str()));
    let open = peer.read().unwrap();
    store.close();
    assert_eq!(code(open.digest("")), StoreErrorCode::StoreClosed);
    assert_eq!(open.root(), Some(root.as_str()));
}

#[test]
fn the_reference_refuses_a_prefix_that_is_not_lowercase_hex_and_an_id_that_is_not_a_content_address(
) {
    let id = "1e20".to_string() + &"ab".repeat(32);
    let one = std::slice::from_ref(&id);
    assert_eq!(
        digest_of(one, "1e2").unwrap(),
        DigestNode {
            count: 1,
            hash: digest_of(one, "").unwrap().hash
        }
    );
    for prefix in ["1E20", "1e20 ", "g"] {
        let e = digest_of(one, prefix).unwrap_err();
        assert_eq!(e.code, StoreErrorCode::InvalidRequest, "{prefix:?}");
    }
    for bad in [
        "1e21".to_string() + &"ab".repeat(32),
        id.to_uppercase(),
        id[..67].to_string(),
    ] {
        let e = digest_of(std::slice::from_ref(&bad), "").unwrap_err();
        assert_eq!(e.code, StoreErrorCode::InvalidRequest, "{bad}");
    }
}
