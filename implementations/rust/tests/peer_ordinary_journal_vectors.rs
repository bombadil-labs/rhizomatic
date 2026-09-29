//! Shared canonical ordinary journal frames and fail-closed replay.

use std::collections::BTreeMap;

use rhizomatic::durable_state::encode_durable_peer_state;
use rhizomatic::json_profile::parse_claims;
use rhizomatic::ordinary_journal::{
    decode_ordinary_journal_checkpoint, decode_ordinary_peer_frame,
    encode_ordinary_journal_checkpoint, encode_ordinary_peer_frame, ordinary_peer_frame_id,
    replay_ordinary_peer_frames, replay_ordinary_peer_frames_from_checkpoint,
    OrdinaryJournalCheckpoint, OrdinaryPeerFrame,
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

#[test]
fn canonical_frames_and_replay_match_shared_vectors() {
    let vector = read("peer/ordinary-journal.json");
    let named = fixtures();
    let peer = vector["peerId"].as_str().unwrap();
    let names = [
        vector["firstName"].as_str().unwrap(),
        vector["secondName"].as_str().unwrap(),
    ];
    let mut bytes = Vec::new();
    for (i, row) in vector["frames"].as_array().unwrap().iter().enumerate() {
        let frame = OrdinaryPeerFrame {
            peer_id: peer.into(),
            prior: row["prior"].as_str().unwrap().into(),
            at: row["at"].as_f64().unwrap(),
            sender: row["sender"].as_str().unwrap().into(),
            additions: vec![named[names[i]].clone()],
        };
        let encoded = encode_ordinary_peer_frame(&frame).unwrap();
        assert_eq!(hex::encode(&encoded), row["hex"].as_str().unwrap());
        assert_eq!(ordinary_peer_frame_id(&encoded).unwrap(), row["head"]);
        assert_eq!(
            decode_ordinary_peer_frame(&encoded).unwrap().prior,
            frame.prior
        );
        bytes.push(encoded);
    }
    let head = vector["frames"][1]["head"].as_str().unwrap();
    let state = replay_ordinary_peer_frames(peer, &bytes, head).unwrap();
    assert_eq!(
        hex::encode(encode_durable_peer_state(&state).unwrap()),
        vector["expectedImageHex"]
    );
    let arrivals = vector["expectedArrivals"].as_array().unwrap();
    for (actual, expected) in state.base.arrivals.iter().zip(arrivals) {
        assert_eq!(actual.id, expected["id"]);
        assert_eq!(actual.transfer, expected["transfer"].as_u64().unwrap());
        assert_eq!(actual.sequence, expected["sequence"].as_u64().unwrap());
        assert_eq!(actual.sender, expected["sender"]);
    }
}

#[test]
fn malformed_history_fails_closed() {
    let vector = read("peer/ordinary-journal.json");
    let named = fixtures();
    let peer = vector["peerId"].as_str().unwrap();
    let bytes: Vec<Vec<u8>> = vector["frames"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| hex::decode(row["hex"].as_str().unwrap()).unwrap())
        .collect();
    let first_head = vector["frames"][0]["head"].as_str().unwrap();
    let second_head = vector["frames"][1]["head"].as_str().unwrap();
    assert!(replay_ordinary_peer_frames(peer, &bytes[1..], second_head)
        .unwrap_err()
        .contains(vector["brokenChainError"].as_str().unwrap()));
    assert!(replay_ordinary_peer_frames(peer, &bytes, first_head)
        .unwrap_err()
        .contains(vector["headMismatchError"].as_str().unwrap()));
    let repeated = encode_ordinary_peer_frame(&OrdinaryPeerFrame {
        peer_id: peer.into(),
        prior: first_head.into(),
        at: 100.0,
        sender: "local".into(),
        additions: vec![named[vector["firstName"].as_str().unwrap()].clone()],
    })
    .unwrap();
    let repeated_head = ordinary_peer_frame_id(&repeated).unwrap();
    assert!(
        replay_ordinary_peer_frames(peer, &[bytes[0].clone(), repeated], &repeated_head)
            .unwrap_err()
            .contains(vector["repeatedIdError"].as_str().unwrap())
    );
    assert!(encode_ordinary_peer_frame(&OrdinaryPeerFrame {
        peer_id: peer.into(),
        prior: "".into(),
        at: 100.0,
        sender: "local".into(),
        additions: vec![],
    })
    .unwrap_err()
    .contains(vector["emptyFrameError"].as_str().unwrap()));
    let mut corrupt = bytes[0].clone();
    *corrupt.last_mut().unwrap() ^= 1;
    assert!(decode_ordinary_peer_frame(&corrupt).is_err());
}

#[test]
fn canonical_checkpoint_and_retained_suffix_match_shared_vectors() {
    let vector = read("peer/ordinary-journal.json");
    let peer = vector["peerId"].as_str().unwrap();
    let first = hex::decode(vector["frames"][0]["hex"].as_str().unwrap()).unwrap();
    let second = hex::decode(vector["frames"][1]["hex"].as_str().unwrap()).unwrap();
    let first_head = vector["checkpoint"]["head"].as_str().unwrap();
    let second_head = vector["frames"][1]["head"].as_str().unwrap();
    let first_state =
        replay_ordinary_peer_frames(peer, std::slice::from_ref(&first), first_head).unwrap();
    let checkpoint = encode_ordinary_journal_checkpoint(&OrdinaryJournalCheckpoint {
        peer_id: peer.into(),
        head: first_head.into(),
        state: first_state,
    })
    .unwrap();
    assert_eq!(hex::encode(&checkpoint), vector["checkpoint"]["hex"]);
    assert_eq!(
        decode_ordinary_journal_checkpoint(&checkpoint)
            .unwrap()
            .head,
        first_head
    );
    assert_eq!(
        hex::encode(&second),
        vector["checkpoint"]["retainedFrameHex"]
    );
    let state = replay_ordinary_peer_frames_from_checkpoint(
        peer,
        std::slice::from_ref(&second),
        second_head,
        Some(&checkpoint),
    )
    .unwrap();
    assert_eq!(
        hex::encode(encode_durable_peer_state(&state).unwrap()),
        vector["checkpoint"]["expectedImageHex"]
    );
    let forged = hex::decode(vector["checkpoint"]["forgedSenderHex"].as_str().unwrap()).unwrap();
    let error = vector["checkpoint"]["forgedHeadError"].as_str().unwrap();
    assert!(decode_ordinary_journal_checkpoint(&forged)
        .unwrap_err()
        .contains(error));
    assert!(replay_ordinary_peer_frames_from_checkpoint(
        peer,
        std::slice::from_ref(&second),
        second_head,
        Some(&forged)
    )
    .unwrap_err()
    .contains(error));
    assert!(replay_ordinary_peer_frames_from_checkpoint(
        peer,
        &[first, second],
        second_head,
        Some(&checkpoint)
    )
    .unwrap_err()
    .contains(
        vector["checkpoint"]["brokenBoundaryError"]
            .as_str()
            .unwrap()
    ));
    assert!(
        replay_ordinary_peer_frames_from_checkpoint(peer, &[], second_head, Some(&checkpoint))
            .unwrap_err()
            .contains(vector["headMismatchError"].as_str().unwrap())
    );
}
