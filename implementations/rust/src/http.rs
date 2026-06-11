//! The blessed HTTP federation binding (ERRATA-6 F5). Mirrors ../ts/src/http.ts and speaks the
//! identical wire shape — a Rust peer and a TypeScript peer converge over this protocol.

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::json_profile::{claims_to_json, parse_claims};
use crate::peer::Peer;
use crate::reactor::{manifest_member_ids, IngestResult};
use crate::set::make_delta;
use crate::sign::{verify_delta, Verification};
use crate::types::Delta;

fn to_wire(d: &Delta) -> Value {
    // No id on the wire: the receiver recomputes content addresses (F5; never trust the wire).
    match &d.sig {
        Some(sig) => json!({ "claims": claims_to_json(&d.claims), "sig": sig }),
        None => json!({ "claims": claims_to_json(&d.claims) }),
    }
}

fn from_wire(w: &Value) -> Result<Delta, String> {
    let claims = parse_claims(&w["claims"])?;
    let sig = w.get("sig").and_then(Value::as_str).map(str::to_string);
    make_delta(claims, sig)
}

/// Compute the OFFER for a WANT, partitioned per the signature boundary (F3).
pub fn offer_for(peer: &Peer, have: &BTreeSet<String>) -> Value {
    let offered: Vec<Delta> = peer
        .offered_set()
        .into_iter()
        .filter(|d| !have.contains(&d.id))
        .collect();
    let offered_ids: BTreeSet<&str> = offered.iter().map(|d| d.id.as_str()).collect();
    let is_signed_manifest = |d: &Delta| {
        d.sig.is_some()
            && verify_delta(d) == Verification::Verified
            && !manifest_member_ids(d).is_empty()
    };
    let mut covered: BTreeSet<String> = BTreeSet::new();
    let mut bundles: Vec<Value> = Vec::new();
    for m in offered.iter().filter(|d| is_signed_manifest(d)) {
        let members: Vec<&Delta> = manifest_member_ids(m)
            .iter()
            .filter(|id| offered_ids.contains(id.as_str()))
            .filter_map(|id| offered.iter().find(|d| &d.id == id))
            .filter(|d| !is_signed_manifest(d))
            .collect();
        for mem in &members {
            covered.insert(mem.id.clone());
        }
        covered.insert(m.id.clone());
        bundles.push(json!({
            "manifest": to_wire(m),
            "members": members.iter().map(|d| to_wire(d)).collect::<Vec<_>>(),
        }));
    }
    let loose: Vec<Value> = offered
        .iter()
        .filter(|d| {
            !covered.contains(&d.id) && d.sig.is_some() && verify_delta(d) == Verification::Verified
        })
        .map(to_wire)
        .collect();
    json!({ "bundles": bundles, "loose": loose })
}

/// Serve a peer's offered lens over HTTP on 127.0.0.1:port. Returns a shutdown handle.
pub fn serve_peer(peer: Arc<Mutex<Peer>>, port: u16) -> Result<ServerHandle, String> {
    let server = tiny_http::Server::http(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    let server = Arc::new(server);
    let srv = Arc::clone(&server);
    let handle = std::thread::spawn(move || {
        for mut request in srv.incoming_requests() {
            if request.method() != &tiny_http::Method::Post || request.url() != "/rhz/v0/sync" {
                let _ = request.respond(tiny_http::Response::empty(404));
                continue;
            }
            let mut body = String::new();
            let _ = request.as_reader().read_to_string(&mut body);
            let response = (|| -> Result<Value, String> {
                let want: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
                let have: BTreeSet<String> = want["have"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
                let peer = peer.lock().map_err(|_| "peer lock poisoned".to_string())?;
                Ok(offer_for(&peer, &have))
            })();
            let _ = match response {
                Ok(v) => {
                    request.respond(tiny_http::Response::from_string(v.to_string()).with_header(
                        tiny_http::Header::from_bytes("content-type", "application/json").unwrap(),
                    ))
                }
                Err(e) => request.respond(
                    tiny_http::Response::from_string(json!({ "error": e }).to_string())
                        .with_status_code(400),
                ),
            };
        }
    });
    Ok(ServerHandle {
        server,
        thread: Some(handle),
    })
}

pub struct ServerHandle {
    server: Arc<tiny_http::Server>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for ServerHandle {
    fn drop(&mut self) {
        self.server.unblock();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Pull from a remote peer over HTTP: WANT(my ids) -> verify -> admission -> ingest (§5).
pub fn pull_from_url(peer: &mut Peer, base_url: &str) -> Result<(usize, usize), String> {
    let have: Vec<String> = peer
        .reactor
        .arrival_log()
        .iter()
        .map(|d| d.id.clone())
        .collect();
    let body = ureq::post(&format!("{base_url}/rhz/v0/sync"))
        .set("content-type", "application/json")
        .send_string(&json!({ "have": have }).to_string())
        .map_err(|e| format!("sync failed: {e}"))?
        .into_string()
        .map_err(|e| format!("bad response body: {e}"))?;
    let response: Value = serde_json::from_str(&body).map_err(|e| format!("bad response: {e}"))?;

    let (mut accepted, mut rejected) = (0usize, 0usize);
    let empty = Vec::new();
    for b in response["bundles"].as_array().unwrap_or(&empty) {
        let manifest = match from_wire(&b["manifest"]) {
            Ok(m) => m,
            Err(_) => {
                rejected += 1;
                continue;
            }
        };
        if verify_delta(&manifest) != Verification::Verified {
            rejected += 1;
            continue;
        }
        let members: Result<Vec<Delta>, String> = b["members"]
            .as_array()
            .unwrap_or(&empty)
            .iter()
            .map(from_wire)
            .collect();
        let Ok(members) = members else {
            rejected += 1;
            continue;
        };
        if !peer.admits(&manifest) || !members.iter().all(|m| peer.admits(m)) {
            rejected += 1 + members.len();
            continue;
        }
        match peer.reactor.ingest_bundle(manifest, &members) {
            IngestResult::Accepted => accepted += 1,
            IngestResult::Rejected(_) => rejected += 1,
            IngestResult::Duplicate => {}
        }
    }
    for w in response["loose"].as_array().unwrap_or(&empty) {
        let Ok(d) = from_wire(w) else {
            rejected += 1;
            continue;
        };
        if verify_delta(&d) != Verification::Verified || !peer.admits(&d) {
            rejected += 1;
            continue;
        }
        match peer.reactor.ingest(d) {
            IngestResult::Accepted => accepted += 1,
            IngestResult::Rejected(_) => rejected += 1,
            IngestResult::Duplicate => {}
        }
    }
    Ok((accepted, rejected))
}
