//! Shared typed ordinary journal store behavior.

use std::collections::BTreeMap;

use rhizomatic::durable_state::encode_durable_peer_state;
use rhizomatic::json_profile::parse_claims;
use rhizomatic::ordinary_journal_peer::{
    open_ordinary_journal_peer, DurableOrdinaryJournalStore, OrdinaryJournalAdmissionResult,
    OrdinaryJournalHead, OrdinaryJournalOpenResult, OrdinaryJournalRead,
};
use rhizomatic::single_peer::{
    ArrivalOrigin, PeerImageWrite, SinglePeerTransferInput, TransferMode,
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
struct MemoryJournal {
    head: Option<String>,
    frames: Vec<Vec<u8>>,
    rows: BTreeMap<String, Delta>,
    writes: usize,
    next: Option<PeerImageWrite>,
}
impl DurableOrdinaryJournalStore for MemoryJournal {
    fn read_journal(&self, _peer_id: &str) -> Result<OrdinaryJournalRead, String> {
        Ok(match &self.head {
            Some(head) => OrdinaryJournalRead::Journal {
                head: head.clone(),
                frames: self.frames.clone(),
            },
            None if self.rows.is_empty() => OrdinaryJournalRead::Empty,
            None => OrdinaryJournalRead::RowsWithoutJournal,
        })
    }
    fn read_head(&self, _peer_id: &str) -> Result<OrdinaryJournalHead, String> {
        Ok(match &self.head {
            Some(head) => OrdinaryJournalHead::Head(head.clone()),
            None => OrdinaryJournalHead::Missing,
        })
    }
    fn compare_and_append(
        &mut self,
        _peer_id: &str,
        expected: Option<&str>,
        next: &str,
        frame: Option<&[u8]>,
        rows: &[Delta],
    ) -> Result<PeerImageWrite, String> {
        self.writes += 1;
        if self.head.as_deref() != expected
            || (expected.is_none() && !self.rows.is_empty())
            || self.next == Some(PeerImageWrite::Conflict)
        {
            return Ok(PeerImageWrite::Conflict);
        }
        self.head = Some(next.into());
        if let Some(frame) = frame {
            self.frames.push(frame.to_vec());
        }
        for row in rows {
            self.rows.insert(row.id.clone(), row.clone());
        }
        Ok(self.next.clone().unwrap_or(PeerImageWrite::Durable))
    }
}

#[test]
fn journal_api_matches_shared_frames_and_reopen() {
    let vector = read("peer/ordinary-journal.json");
    let named = fixtures();
    let peer_id = vector["peerId"].as_str().unwrap();
    let first = named[vector["firstName"].as_str().unwrap()].clone();
    let second = named[vector["secondName"].as_str().unwrap()].clone();
    let mut store = MemoryJournal::default();
    let OrdinaryJournalOpenResult::Open(mut peer) =
        open_ordinary_journal_peer(&mut store, peer_id).unwrap()
    else {
        panic!("expected open")
    };
    assert_eq!(
        peer.current_head().unwrap(),
        vector["api"]["emptyHead"].as_str().unwrap()
    );
    let classifier = |_: &Delta| false;
    let first_offered = [first.clone()];
    let local = ArrivalOrigin::Local;
    let first_result = peer
        .admit(
            &mut store,
            &SinglePeerTransferInput {
                offered: &first_offered,
                origin: &local,
                arrived_at: 100.0,
                policy_state: &(),
                guards: &[],
                is_erasure_candidate: &classifier,
                mode: TransferMode::Atomic,
                capacity: None,
            },
        )
        .unwrap();
    let OrdinaryJournalAdmissionResult::Committed { head, .. } = first_result else {
        panic!("expected commit")
    };
    assert_eq!(head, vector["frames"][0]["head"]);
    assert_eq!(hex::encode(&store.frames[0]), vector["frames"][0]["hex"]);
    let writes = store.writes;
    assert!(matches!(
        peer.admit(
            &mut store,
            &SinglePeerTransferInput {
                offered: &first_offered,
                origin: &local,
                arrived_at: 100.0,
                policy_state: &(),
                guards: &[],
                is_erasure_candidate: &classifier,
                mode: TransferMode::Atomic,
                capacity: None,
            }
        )
        .unwrap(),
        OrdinaryJournalAdmissionResult::Committed { .. }
    ));
    assert_eq!(
        store.writes - writes,
        vector["api"]["noOpWrites"].as_u64().unwrap() as usize
    );
    let second_offered = [second];
    let unattributed = ArrivalOrigin::Unattributed;
    let second_result = peer
        .admit(
            &mut store,
            &SinglePeerTransferInput {
                offered: &second_offered,
                origin: &unattributed,
                arrived_at: 100.0,
                policy_state: &(),
                guards: &[],
                is_erasure_candidate: &classifier,
                mode: TransferMode::Atomic,
                capacity: None,
            },
        )
        .unwrap();
    let OrdinaryJournalAdmissionResult::Committed { head, arrivals, .. } = second_result else {
        panic!("expected commit")
    };
    assert_eq!(head, vector["frames"][1]["head"]);
    assert_eq!(arrivals[0].transfer, 2);
    assert_eq!(hex::encode(&store.frames[1]), vector["frames"][1]["hex"]);
    assert_eq!(
        hex::encode(encode_durable_peer_state(&peer.snapshot().unwrap()).unwrap()),
        vector["expectedImageHex"]
    );
    let OrdinaryJournalOpenResult::Open(reopened) =
        open_ordinary_journal_peer(&mut store, peer_id).unwrap()
    else {
        panic!("expected reopen")
    };
    assert_eq!(
        hex::encode(encode_durable_peer_state(&reopened.snapshot().unwrap()).unwrap()),
        vector["expectedImageHex"]
    );
    assert_eq!(store.rows.len(), 2);
}

#[test]
fn journal_api_fails_closed_on_legacy_conflict_and_uncertain_write() {
    let vector = read("peer/ordinary-journal.json");
    let named = fixtures();
    let peer_id = vector["peerId"].as_str().unwrap();
    let first = named[vector["firstName"].as_str().unwrap()].clone();
    let mut legacy = MemoryJournal::default();
    legacy.rows.insert(first.id.clone(), first.clone());
    assert!(matches!(
        open_ordinary_journal_peer(&mut legacy, peer_id).unwrap(),
        OrdinaryJournalOpenResult::RowsWithoutJournal
    ));
    let mut store = MemoryJournal::default();
    let OrdinaryJournalOpenResult::Open(mut peer) =
        open_ordinary_journal_peer(&mut store, peer_id).unwrap()
    else {
        panic!("expected open")
    };
    store.head = Some(vector["frames"][0]["head"].as_str().unwrap().into());
    let classifier = |_: &Delta| false;
    let offered = [first.clone()];
    let local = ArrivalOrigin::Local;
    let input = SinglePeerTransferInput {
        offered: &offered,
        origin: &local,
        arrived_at: 100.0,
        policy_state: &(),
        guards: &[],
        is_erasure_candidate: &classifier,
        mode: TransferMode::Atomic,
        capacity: None,
    };
    assert!(matches!(
        peer.admit(&mut store, &input).unwrap(),
        OrdinaryJournalAdmissionResult::Conflict
    ));
    assert!(peer.snapshot().unwrap_err().contains("reopen required"));
    let mut uncertain = MemoryJournal::default();
    let OrdinaryJournalOpenResult::Open(mut active) =
        open_ordinary_journal_peer(&mut uncertain, peer_id).unwrap()
    else {
        panic!("expected open")
    };
    uncertain.next = Some(PeerImageWrite::CommittedUnconfirmed {
        fault: "sync uncertain".into(),
    });
    assert!(matches!(
        active.admit(&mut uncertain, &input).unwrap(),
        OrdinaryJournalAdmissionResult::CommittedUnconfirmed { .. }
    ));
    assert!(active
        .current_head()
        .unwrap_err()
        .contains("reopen required"));
    let OrdinaryJournalOpenResult::Open(recovered) =
        open_ordinary_journal_peer(&mut uncertain, peer_id).unwrap()
    else {
        panic!("expected recovery")
    };
    assert!(recovered
        .snapshot()
        .unwrap()
        .base
        .admitted
        .contains(&first.id));
}

#[test]
fn atomic_rejection_and_individual_reason_do_not_write_refused_row() {
    use rhizomatic::preflight::{CandidateGuard, GuardDecision};
    let vector = read("peer/ordinary-journal.json");
    let named = fixtures();
    let peer_id = vector["peerId"].as_str().unwrap();
    let first = named[vector["firstName"].as_str().unwrap()].clone();
    let second = named[vector["secondName"].as_str().unwrap()].clone();
    let second_id = second.id.clone();
    let reason = vector["api"]["guardReason"].as_str().unwrap().to_string();
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
    let guards: [&CandidateGuard<()>; 1] = [&guard];
    let offered = [first, second];
    let classifier = |_: &Delta| false;
    let local = ArrivalOrigin::Local;
    let mut store = MemoryJournal::default();
    let OrdinaryJournalOpenResult::Open(mut peer) =
        open_ordinary_journal_peer(&mut store, peer_id).unwrap()
    else {
        panic!("expected open")
    };
    let writes = store.writes;
    let atomic = peer
        .admit(
            &mut store,
            &SinglePeerTransferInput {
                offered: &offered,
                origin: &local,
                arrived_at: 100.0,
                policy_state: &(),
                guards: &guards,
                is_erasure_candidate: &classifier,
                mode: TransferMode::Atomic,
                capacity: None,
            },
        )
        .unwrap();
    let OrdinaryJournalAdmissionResult::Rejected { reason, .. } = atomic else {
        panic!("expected rejection")
    };
    assert_eq!(reason, vector["api"]["guardReason"]);
    assert_eq!(store.writes, writes);
    let individual = peer
        .admit(
            &mut store,
            &SinglePeerTransferInput {
                offered: &offered,
                origin: &local,
                arrived_at: 100.0,
                policy_state: &(),
                guards: &guards,
                is_erasure_candidate: &classifier,
                mode: TransferMode::Individual,
                capacity: None,
            },
        )
        .unwrap();
    let OrdinaryJournalAdmissionResult::Committed { outcomes, .. } = individual else {
        panic!("expected commit")
    };
    assert_eq!(outcomes[0].status.as_str(), "admitted");
    assert_eq!(outcomes[1].status.as_str(), "guard-rejected");
    assert_eq!(
        outcomes[1].reason.as_deref(),
        vector["api"]["guardReason"].as_str()
    );
    assert_eq!(store.frames.len(), 1);
    assert_eq!(store.rows.len(), 1);
}
