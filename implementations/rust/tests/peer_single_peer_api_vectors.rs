//! Shared typed single-peer API over an atomic image-plus-row store.

use std::collections::BTreeMap;

use rhizomatic::durable_state::{empty_durable_peer_state, encode_durable_peer_state};
use rhizomatic::json_profile::parse_claims;
use rhizomatic::preflight::{CandidateGuard, GuardDecision};
use rhizomatic::single_peer::{
    admit_single_peer_transfer, open_single_peer, ArrivalOrigin, DurablePeerStore,
    FileDurablePeerStore, OpenSinglePeerResult, PeerImageRead, PeerImageWrite,
    SinglePeerTransferInput, SinglePeerTransferResult, TransferMode,
};
use rhizomatic::Delta;
use serde_json::Value;

fn read(name: &str) -> Value {
    let path = format!("{}/../../vectors/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn fixtures() -> BTreeMap<String, Delta> {
    read("principal/evidence.json")["deltas"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            (
                row["name"].as_str().unwrap().into(),
                Delta {
                    id: row["id"].as_str().unwrap().into(),
                    claims: parse_claims(&row["claims"]).unwrap(),
                    sig: row["sig"].as_str().map(str::to_string),
                },
            )
        })
        .collect()
}

#[derive(Default)]
struct MemoryStore {
    image: Option<Vec<u8>>,
    rows: BTreeMap<String, Delta>,
    next_write: Option<PeerImageWrite>,
    writes: usize,
}

impl DurablePeerStore for MemoryStore {
    fn read_image(&self, _peer_id: &str) -> Result<PeerImageRead, String> {
        Ok(match &self.image {
            Some(image) => PeerImageRead::Image(image.clone()),
            None if self.rows.is_empty() => PeerImageRead::Empty,
            None => PeerImageRead::RowsWithoutImage,
        })
    }

    fn compare_and_set(
        &mut self,
        _peer_id: &str,
        expected_prior: Option<&[u8]>,
        next_image: &[u8],
        newly_admitted: &[Delta],
    ) -> Result<PeerImageWrite, String> {
        self.writes += 1;
        if self.image.as_deref() != expected_prior
            || (expected_prior.is_none() && !self.rows.is_empty())
            || self.next_write == Some(PeerImageWrite::Conflict)
        {
            return Ok(PeerImageWrite::Conflict);
        }
        self.image = Some(next_image.to_vec());
        for delta in newly_admitted {
            self.rows.insert(delta.id.clone(), delta.clone());
        }
        Ok(self.next_write.clone().unwrap_or(PeerImageWrite::Durable))
    }
}

#[test]
fn empty_local_and_individual_images_match_shared_vectors() {
    let vector = read("peer/single-peer-api.json");
    let named = fixtures();
    let peer_id = vector["peerId"].as_str().unwrap();
    let first = named[vector["firstName"].as_str().unwrap()].clone();
    let second = named[vector["secondName"].as_str().unwrap()].clone();
    assert_eq!(
        hex::encode(
            encode_durable_peer_state(&empty_durable_peer_state(peer_id).unwrap()).unwrap()
        ),
        vector["emptyHex"]
    );
    assert!(empty_durable_peer_state("peer-A").is_err());

    let mut legacy = MemoryStore::default();
    legacy.rows.insert(first.id.clone(), first.clone());
    assert!(matches!(
        open_single_peer(&mut legacy, peer_id).unwrap(),
        OpenSinglePeerResult::RowsWithoutImage
    ));

    let mut local_store = MemoryStore::default();
    assert!(matches!(
        open_single_peer(&mut local_store, peer_id).unwrap(),
        OpenSinglePeerResult::Open { .. }
    ));
    assert_eq!(
        hex::encode(local_store.image.as_ref().unwrap()),
        vector["emptyHex"]
    );
    let local_origin = ArrivalOrigin::Local;
    let allow = |_: &Delta, _: &str, _: &str, _: &rhizomatic::DeltaSet, _: f64, _: &()| {
        GuardDecision::Allow
    };
    let guards: [&CandidateGuard<()>; 1] = [&allow];
    let classifier = |_: &Delta| false;
    let local_offered = [first.clone()];
    let local = admit_single_peer_transfer(
        &mut local_store,
        peer_id,
        &SinglePeerTransferInput {
            offered: &local_offered,
            origin: &local_origin,
            arrived_at: vector["local"]["at"].as_f64().unwrap(),
            policy_state: &(),
            guards: &guards,
            is_erasure_candidate: &classifier,
            mode: TransferMode::Atomic,
            capacity: None,
        },
    )
    .unwrap();
    let SinglePeerTransferResult::Committed {
        state,
        image,
        outcomes,
    } = local
    else {
        panic!("local transfer should commit");
    };
    assert_eq!(hex::encode(&image), vector["local"]["expectedHex"]);
    assert_eq!(
        outcomes[0].status.as_str(),
        vector["local"]["outcomes"][0]["status"]
    );
    assert_eq!(state.base.arrivals[0].sender, "local");
    assert!(local_store.rows.contains_key(&first.id));

    let mut received_store = MemoryStore::default();
    open_single_peer(&mut received_store, peer_id).unwrap();
    let unattributed = ArrivalOrigin::Unattributed;
    let reason = vector["individual"]["reason"].as_str().unwrap().to_string();
    let second_id = second.id.clone();
    let guard =
        move |candidate: &Delta, _: &str, _: &str, _: &rhizomatic::DeltaSet, _: f64, _: &()| {
            if candidate.id == second_id {
                GuardDecision::Reject {
                    reason: reason.clone(),
                }
            } else {
                GuardDecision::Allow
            }
        };
    let reason_guards: [&CandidateGuard<()>; 1] = [&guard];
    let offered = [first.clone(), second.clone()];
    let input = |mode| SinglePeerTransferInput {
        offered: &offered,
        origin: &unattributed,
        arrived_at: vector["individual"]["at"].as_f64().unwrap(),
        policy_state: &(),
        guards: &reason_guards,
        is_erasure_candidate: &classifier,
        mode,
        capacity: None,
    };
    let rejected =
        admit_single_peer_transfer(&mut received_store, peer_id, &input(TransferMode::Atomic))
            .unwrap();
    assert!(
        matches!(rejected, SinglePeerTransferResult::Rejected { reason, .. } if reason == vector["individual"]["reason"])
    );
    assert_eq!(
        hex::encode(received_store.image.as_ref().unwrap()),
        vector["emptyHex"]
    );
    assert!(received_store.rows.is_empty());
    let admitted = admit_single_peer_transfer(
        &mut received_store,
        peer_id,
        &input(TransferMode::Individual),
    )
    .unwrap();
    let SinglePeerTransferResult::Committed {
        state,
        image,
        outcomes,
    } = admitted
    else {
        panic!("individual transfer should commit");
    };
    assert_eq!(hex::encode(&image), vector["individual"]["expectedHex"]);
    assert_eq!(
        outcomes[0].status.as_str(),
        vector["individual"]["outcomes"][0]["status"]
    );
    assert_eq!(
        outcomes[1].status.as_str(),
        vector["individual"]["outcomes"][1]["status"]
    );
    assert_eq!(
        outcomes[1].reason.as_deref(),
        vector["individual"]["outcomes"][1]["reason"].as_str()
    );
    assert_eq!(state.base.arrivals[0].sender, "unattributed");
    assert!(received_store.rows.contains_key(&first.id));
    assert!(!received_store.rows.contains_key(&second.id));
}

#[test]
fn conflict_uncertain_and_file_reopen_remain_distinct() {
    let vector = read("peer/single-peer-api.json");
    let named = fixtures();
    let peer_id = vector["peerId"].as_str().unwrap();
    let first = named[vector["firstName"].as_str().unwrap()].clone();
    let offered = [first.clone()];
    let origin = ArrivalOrigin::Local;
    let classifier = |_: &Delta| false;
    let guards: [&CandidateGuard<()>; 0] = [];
    let input = SinglePeerTransferInput {
        offered: &offered,
        origin: &origin,
        arrived_at: vector["local"]["at"].as_f64().unwrap(),
        policy_state: &(),
        guards: &guards,
        is_erasure_candidate: &classifier,
        mode: TransferMode::Atomic,
        capacity: None,
    };
    let mut memory = MemoryStore::default();
    open_single_peer(&mut memory, peer_id).unwrap();
    memory.next_write = Some(PeerImageWrite::Conflict);
    assert!(matches!(
        admit_single_peer_transfer(&mut memory, peer_id, &input).unwrap(),
        SinglePeerTransferResult::Conflict
    ));
    assert_eq!(
        hex::encode(memory.image.as_ref().unwrap()),
        vector["emptyHex"]
    );
    assert!(memory.rows.is_empty());
    memory.next_write = Some(PeerImageWrite::CommittedUnconfirmed {
        fault: "sync uncertain".into(),
    });
    assert!(matches!(
        admit_single_peer_transfer(&mut memory, peer_id, &input).unwrap(),
        SinglePeerTransferResult::CommittedUnconfirmed { .. }
    ));

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("peer.bin");
    let mut file = FileDurablePeerStore::new(path.clone(), peer_id.into()).unwrap();
    open_single_peer(&mut file, peer_id).unwrap();
    assert!(matches!(
        admit_single_peer_transfer(&mut file, peer_id, &input).unwrap(),
        SinglePeerTransferResult::Committed { .. }
    ));
    assert_eq!(
        hex::encode(std::fs::read(&path).unwrap()),
        vector["local"]["expectedHex"]
    );
    assert!(matches!(
        open_single_peer(
            &mut FileDurablePeerStore::new(path, peer_id.into()).unwrap(),
            peer_id
        )
        .unwrap(),
        OpenSinglePeerResult::Open { .. }
    ));
}

#[test]
fn unchanged_offers_do_not_write_and_self_sender_is_rejected() {
    let vector = read("peer/single-peer-api.json");
    let named = fixtures();
    let peer_id = vector["peerId"].as_str().unwrap();
    let first = named[vector["firstName"].as_str().unwrap()].clone();
    let origin = ArrivalOrigin::Local;
    let own_origin = ArrivalOrigin::AuthenticatedPeer(peer_id.into());
    let classifier = |_: &Delta| false;
    let guards: [&CandidateGuard<()>; 0] = [];
    let mut store = MemoryStore::default();
    open_single_peer(&mut store, peer_id).unwrap();
    let opened_writes = store.writes;
    let empty: [Delta; 0] = [];
    let input = |offered, origin| SinglePeerTransferInput {
        offered,
        origin,
        arrived_at: vector["local"]["at"].as_f64().unwrap(),
        policy_state: &(),
        guards: &guards,
        is_erasure_candidate: &classifier,
        mode: TransferMode::Atomic,
        capacity: None,
    };
    assert!(matches!(
        admit_single_peer_transfer(&mut store, peer_id, &input(&empty, &origin)).unwrap(),
        SinglePeerTransferResult::Committed { .. }
    ));
    assert_eq!(
        store.writes - opened_writes,
        vector["noOpWrites"].as_u64().unwrap() as usize
    );
    let offered = [first];
    assert_eq!(
        admit_single_peer_transfer(&mut store, peer_id, &input(&offered, &own_origin)).unwrap_err(),
        vector["selfSenderError"].as_str().unwrap()
    );
    assert_eq!(store.writes, opened_writes);
    assert!(matches!(
        admit_single_peer_transfer(&mut store, peer_id, &input(&offered, &origin)).unwrap(),
        SinglePeerTransferResult::Committed { .. }
    ));
    let after = store.writes;
    assert!(matches!(
        admit_single_peer_transfer(&mut store, peer_id, &input(&offered, &origin)).unwrap(),
        SinglePeerTransferResult::Committed { .. }
    ));
    assert_eq!(
        store.writes - after,
        vector["noOpWrites"].as_u64().unwrap() as usize
    );
}
