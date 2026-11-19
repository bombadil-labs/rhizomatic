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
#[allow(deprecated)] // the deprecated whole-set reactor methods are this test's oracle or subject
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

/// One wire offer, served once from 127.0.0.1 on a free port. Mirrors the fixed-offer server of
/// ../ts/test/http.test.ts. Returns the base URL and the thread that answers the one request.
fn serve_offer(body: serde_json::Value) -> (String, std::thread::JoinHandle<()>) {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let url = format!("http://{}", server.server_addr().to_ip().unwrap());
    let handle = std::thread::spawn(move || {
        let request = server.recv().unwrap();
        let _ = request.respond(tiny_http::Response::from_string(body.to_string()));
    });
    (url, handle)
}

fn note_claims(author: &str, timestamp: f64, value: &str) -> rhizomatic::types::Claims {
    rhizomatic::types::Claims {
        timestamp,
        valid_from: timestamp,
        valid_until: None,
        author: author.to_string(),
        pointers: vec![Pointer {
            role: "note".to_string(),
            target: Target::Primitive(Primitive::Str(value.to_string())),
        }],
    }
}

fn signed_entry(value: &str, timestamp: f64) -> serde_json::Value {
    let author = rhizomatic::sign::author_for_seed(SEED_A).unwrap();
    let delta =
        rhizomatic::sign::sign_claims(&note_claims(&author, timestamp, value), SEED_A).unwrap();
    serde_json::json!({
        "claims": rhizomatic::json_profile::claims_to_json(&delta.claims),
        "sig": delta.sig.unwrap(),
    })
}

fn pull_offer(body: serde_json::Value) -> (usize, usize) {
    let (url, handle) = serve_offer(body);
    let mut b = Peer::new(SEED_B);
    let counts = pull_from_url(&mut b, &url).unwrap();
    handle.join().unwrap();
    counts
}

#[test]
fn a_malformed_wire_entry_between_two_good_ones_is_one_rejection_and_the_pull_goes_on() {
    let (one, two) = (signed_entry("one", 1.0), signed_entry("two", 2.0));
    let three = signed_entry("three", 3.0);
    let bad = [
        serde_json::json!({ "claims": three["claims"], "sig": null }),
        serde_json::json!({ "claims": three["claims"], "sig": 5 }),
        serde_json::json!({ "claims": three["claims"], "sig": three["sig"], "extra": 1 }),
        serde_json::json!({ "claims": {}, "sig": three["sig"] }),
        serde_json::json!("not an entry"),
    ];
    let counts: Vec<(usize, usize)> = bad
        .iter()
        .map(|entry| pull_offer(serde_json::json!({ "bundles": [], "loose": [one, entry, two] })))
        .collect();
    assert_eq!(counts, vec![(2, 1); 5]);
}

#[test]
fn a_bundle_member_whose_wire_sig_is_null_is_one_rejection_not_an_unsigned_member() {
    let author = rhizomatic::sign::author_for_seed(SEED_A).unwrap();
    let member = rhizomatic::set::make_delta(note_claims(&author, 4.0, "member"), None).unwrap();
    let manifest = rhizomatic::sign::sign_claims(
        &rhizomatic::reactor::make_manifest_claims(
            &author,
            5.0,
            std::slice::from_ref(&member.id),
            None,
            None,
        ),
        SEED_A,
    )
    .unwrap();
    let wire_manifest = serde_json::json!({
        "claims": rhizomatic::json_profile::claims_to_json(&manifest.claims),
        "sig": manifest.sig.unwrap(),
    });
    let member_claims = rhizomatic::json_profile::claims_to_json(&member.claims);
    let offer = |member: serde_json::Value| {
        serde_json::json!({
            "bundles": [{ "manifest": wire_manifest, "members": [member] }],
            "loose": [signed_entry("one", 1.0), signed_entry("two", 2.0)],
        })
    };
    assert_eq!(
        pull_offer(offer(
            serde_json::json!({ "claims": member_claims, "sig": null })
        )),
        (2, 1)
    );
    assert_eq!(
        pull_offer(offer(serde_json::json!({ "claims": member_claims }))),
        (3, 0)
    );
}
