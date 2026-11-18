//! The application format string on the memory store (SPEC-18 §4.13 reading 134). It is a string
//! of 1 to 256 UTF-8 bytes, given at `create_peer` and fixed there. Any other value is refused
//! `invalid-request` before `posture-refused` and `peer-exists`, and creates nothing. Absent, the
//! peer has none. After `close`, `history` and `app_format` refuse `store-closed`. The cases
//! follow the memory-store tests of the TypeScript `test/store-admission-of.test.ts`. A Rust
//! `String` is well-formed UTF-8 and never null or a number, so those cases need no test here.

use rhizomatic::memory_store::MemoryStore;
use rhizomatic::store::{
    CreatePeerOptions, ErasurePosture, Store, StoreErrorCode, APP_FORMAT_MAX_BYTES,
};

fn with_format(format: &str) -> CreatePeerOptions {
    CreatePeerOptions {
        app_format: Some(format.to_string()),
        ..CreatePeerOptions::new(ErasurePosture::Unproven)
    }
}

fn refusal(store: &MemoryStore, id: &str, options: &CreatePeerOptions) -> Option<StoreErrorCode> {
    store.create_peer(id, options).err().map(|e| e.code)
}

#[test]
fn app_format_is_read_back_from_every_handle_is_none_when_absent_and_cannot_change_after_create() {
    let store = MemoryStore::new();
    let peer = store.create_peer("peer:p", &with_format("loam/7")).unwrap();
    let none = store
        .create_peer("peer:q", &CreatePeerOptions::new(ErasurePosture::Unproven))
        .unwrap();
    assert_eq!(
        (peer.app_format().unwrap(), none.app_format().unwrap()),
        (Some("loam/7"), None)
    );
    for id in ["peer:p", "peer:q"] {
        assert_eq!(
            refusal(&store, id, &with_format("loam/8")),
            Some(StoreErrorCode::PeerExists),
            "{id}"
        );
    }
    assert_eq!(
        store.peer("peer:p").unwrap().app_format().unwrap(),
        Some("loam/7")
    );
    assert_eq!(store.peer("peer:q").unwrap().app_format().unwrap(), None);
    assert_eq!(peer.app_format().unwrap(), Some("loam/7"));
}

#[test]
fn a_bad_app_format_is_refused_invalid_request_before_peer_exists_and_creates_nothing_and_256_utf8_bytes_is_the_bound(
) {
    let store = MemoryStore::new();
    store
        .create_peer("peer:p", &CreatePeerOptions::new(ErasurePosture::Unproven))
        .unwrap();
    let bad = [
        String::new(),
        "x".repeat(APP_FORMAT_MAX_BYTES + 1),
        "é".repeat(129),
    ];
    for format in &bad {
        for id in ["peer:p", "peer:new"] {
            assert_eq!(
                refusal(&store, id, &with_format(format)),
                Some(StoreErrorCode::InvalidRequest),
                "{format} {id}"
            );
        }
    }
    assert_eq!(
        store.peer("peer:new").err().map(|e| e.code),
        Some(StoreErrorCode::PeerAbsent)
    );
    let longest = store
        .create_peer("peer:long", &with_format(&"é".repeat(128)))
        .unwrap();
    assert_eq!(
        longest.app_format().unwrap(),
        Some("é".repeat(128).as_str())
    );
    let widest = store
        .create_peer("peer:wide", &with_format(&"x".repeat(APP_FORMAT_MAX_BYTES)))
        .unwrap();
    assert_eq!(widest.app_format().unwrap().map(str::len), Some(256));
}

#[test]
fn a_bad_app_format_with_a_proven_posture_is_refused_invalid_request_on_the_memory_store_whose_class_refuses_proven(
) {
    let store = MemoryStore::new();
    let proven = CreatePeerOptions::new(ErasurePosture::Proven);
    assert_eq!(
        refusal(&store, "peer:p", &proven),
        Some(StoreErrorCode::PostureRefused)
    );
    let bad = CreatePeerOptions {
        app_format: Some(String::new()),
        ..proven
    };
    assert_eq!(
        refusal(&store, "peer:p", &bad),
        Some(StoreErrorCode::InvalidRequest)
    );
}

#[test]
fn after_close_history_and_app_format_refuse_store_closed() {
    let store = MemoryStore::new();
    let peer = store.create_peer("peer:p", &with_format("host/1")).unwrap();
    let opened = store.peer("peer:p").unwrap();
    assert!(!peer.history().unwrap().is_empty());
    assert_eq!(peer.app_format().unwrap(), Some("host/1"));
    store.close();
    for handle in [&peer, &opened] {
        assert_eq!(
            (
                handle.history().err().map(|e| e.code),
                handle.app_format().err().map(|e| e.code)
            ),
            (
                Some(StoreErrorCode::StoreClosed),
                Some(StoreErrorCode::StoreClosed)
            )
        );
    }
}
