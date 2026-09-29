//! Shared canonical mixed journal and permanent erasure rail.

use rhizomatic::durable_state::{encode_durable_peer_state, PermanentErasure};
use rhizomatic::json_profile::parse_claims;
use rhizomatic::permanent_journal::{
    apply_permanent_peer_frame, decode_permanent_peer_frame, encode_permanent_peer_frame,
    replay_permanent_peer_frames, PermanentPeerFrame,
};
use rhizomatic::Delta;
use serde_json::Value;

fn vector() -> Value {
    let path = format!(
        "{}/../../vectors/peer/permanent-journal.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn signed_erasure_and_purge_replay_matches_shared_bytes() {
    let vector = vector();
    let peer = vector["peerId"].as_str().unwrap();
    let frames: Vec<Vec<u8>> = vector["frames"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| hex::decode(row["hex"].as_str().unwrap()).unwrap())
        .collect();
    for (i, bytes) in frames.iter().enumerate() {
        assert_eq!(
            rhizomatic::hash::content_address(bytes),
            vector["frames"][i]["head"]
        );
    }
    for i in [1, 2] {
        let decoded = decode_permanent_peer_frame(&frames[i]).unwrap();
        assert_eq!(encode_permanent_peer_frame(&decoded).unwrap(), frames[i]);
    }
    let pending = replay_permanent_peer_frames(
        peer,
        &frames[..2],
        vector["frames"][1]["head"].as_str().unwrap(),
        None,
    )
    .unwrap();
    assert_eq!(
        hex::encode(encode_durable_peer_state(&pending).unwrap()),
        vector["pendingImageHex"]
    );
    let target = vector["expected"]["refusedTarget"].as_str().unwrap();
    assert!(pending.base.refused_ids.contains(target));
    assert!(!pending.base.admitted.contains(target));
    assert!(pending
        .base
        .admitted
        .contains(vector["expected"]["orderId"].as_str().unwrap()));
    assert_eq!(pending.events[0].prior_epoch, Some(1));
    assert_eq!(pending.obligations[0].status, "pending");
    let removed = replay_permanent_peer_frames(
        peer,
        &frames,
        vector["frames"][2]["head"].as_str().unwrap(),
        None,
    )
    .unwrap();
    assert_eq!(
        hex::encode(encode_durable_peer_state(&removed).unwrap()),
        vector["removedImageHex"]
    );
    assert_eq!(removed.obligations[0].status, "removed");
    let purge = decode_permanent_peer_frame(&frames[2]).unwrap();
    assert!(apply_permanent_peer_frame(&removed, &purge)
        .unwrap_err()
        .contains(vector["missingObligationError"].as_str().unwrap()));
}

#[test]
fn broken_chain_and_wrong_signed_target_fail_closed() {
    let vector = vector();
    let peer = vector["peerId"].as_str().unwrap();
    let frames: Vec<Vec<u8>> = vector["frames"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| hex::decode(row["hex"].as_str().unwrap()).unwrap())
        .collect();
    assert!(replay_permanent_peer_frames(
        peer,
        &frames[1..2],
        vector["frames"][1]["head"].as_str().unwrap(),
        None,
    )
    .unwrap_err()
    .contains(vector["brokenChainError"].as_str().unwrap()));
    let order = Delta {
        id: vector["order"]["id"].as_str().unwrap().into(),
        sig: Some(vector["order"]["sig"].as_str().unwrap().into()),
        claims: parse_claims(&vector["order"]["claims"]).unwrap(),
    };
    let mut frame = decode_permanent_peer_frame(&frames[1]).unwrap();
    if let PermanentPeerFrame::Admission { input, .. } = &mut frame {
        input.additions = vec![order.clone()];
        input.erasures = vec![PermanentErasure {
            target_id: order.id,
            order_ids: vec![vector["order"]["id"].as_str().unwrap().into()],
            surface_holds_bytes: true,
        }];
    } else {
        panic!("expected admission frame");
    }
    assert!(encode_permanent_peer_frame(&frame)
        .unwrap_err()
        .contains(vector["signedTargetError"].as_str().unwrap()));
}

#[test]
fn held_target_false_absence_fails_replay() {
    let vector = vector();
    let peer = vector["peerId"].as_str().unwrap();
    let first = hex::decode(vector["frames"][0]["hex"].as_str().unwrap()).unwrap();
    let forged = hex::decode(vector["falseHeld"]["hex"].as_str().unwrap()).unwrap();
    let error = replay_permanent_peer_frames(
        peer,
        &[first, forged],
        vector["falseHeld"]["head"].as_str().unwrap(),
        None,
    )
    .unwrap_err();
    assert!(error.contains(vector["falseHeld"]["error"].as_str().unwrap()));
}

#[test]
fn rebase_omits_erased_payload_from_anchor() {
    let vector = vector();
    let peer = vector["peerId"].as_str().unwrap();
    let probe = &vector["payloadProbe"];
    let marker = probe["marker"].as_str().unwrap().as_bytes();
    let ordinary = hex::decode(probe["ordinaryHex"].as_str().unwrap()).unwrap();
    let rebase = hex::decode(probe["rebaseHex"].as_str().unwrap()).unwrap();
    assert!(ordinary
        .windows(marker.len())
        .any(|window| window == marker));
    assert!(!rebase.windows(marker.len()).any(|window| window == marker));
    let state = replay_permanent_peer_frames(
        peer,
        &[],
        probe["rebaseHead"].as_str().unwrap(),
        Some(&rebase),
    )
    .unwrap();
    let target = probe["targetId"].as_str().unwrap();
    assert!(state.base.refused_ids.contains(target));
    assert!(!state.base.admitted.contains(target));
}
