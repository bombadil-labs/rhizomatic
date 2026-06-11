//! The blessed HTTP binding, Rust<->Rust over real localhost (ERRATA-6 F5).
//! Mirrors ../ts/test/http.test.ts. Cross-impl interop is proven by examples/http_sync.rs
//! against the TS server.

use std::sync::{Arc, Mutex};

use rhizomatic::http::{pull_from_url, serve_peer};
use rhizomatic::peer::Peer;
use rhizomatic::types::{EntityRef, Pointer, Primitive, Target};

const SEED_A: &str = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const SEED_B: &str = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";

fn ptrs(entity: &str, context: &str, value: &str) -> Vec<Pointer> {
    vec![
        Pointer {
            role: "subject".to_string(),
            target: Target::Entity(EntityRef {
                id: entity.to_string(),
                context: Some(context.to_string()),
            }),
        },
        Pointer {
            role: "value".to_string(),
            target: Target::Primitive(Primitive::Str(value.to_string())),
        },
    ]
}

#[test]
fn two_rust_peers_converge_over_localhost_http() {
    let mut alice = Peer::new(SEED_A);
    alice.author_claims(1.0, ptrs("doc:x", "title", "from Alice"));
    alice.author_claims(2.0, ptrs("doc:x", "tag", "alpha"));
    let alice_digest_pre = alice.reactor.digest();
    let alice = Arc::new(Mutex::new(alice));
    let _server = serve_peer(Arc::clone(&alice), 47371).unwrap();

    let mut bob = Peer::new(SEED_B);
    bob.author_claims(3.0, ptrs("doc:x", "tag", "beta"));
    let (accepted, rejected) = pull_from_url(&mut bob, "http://127.0.0.1:47371").unwrap();
    assert_eq!(accepted, 2);
    assert_eq!(rejected, 0);
    assert_eq!(bob.reactor.len(), 3);
    assert_ne!(bob.reactor.digest(), alice_digest_pre); // bob = union, alice unchanged

    // pulling again is a no-op (idempotent by id)
    let (again, _) = pull_from_url(&mut bob, "http://127.0.0.1:47371").unwrap();
    assert_eq!(again, 0);
}

#[test]
fn lens_applies_on_the_wire() {
    let mut a = Peer::new(SEED_A);
    a.offered_lens = Some(
        rhizomatic::term_json::parse_term(&serde_json::json!({
            "op": "select",
            "pred": { "hasPointer": { "targetEntity": "public:doc" } },
            "in": "input"
        }))
        .unwrap(),
    );
    a.author_claims(1.0, ptrs("public:doc", "title", "shared"));
    a.author_claims(2.0, ptrs("secret:doc", "title", "private"));
    let a = Arc::new(Mutex::new(a));
    let _server = serve_peer(Arc::clone(&a), 47372).unwrap();

    let mut b = Peer::new(SEED_B);
    pull_from_url(&mut b, "http://127.0.0.1:47372").unwrap();
    assert_eq!(b.reactor.len(), 1);
    assert!(b.reactor.by_target("secret:doc").is_empty());
}
