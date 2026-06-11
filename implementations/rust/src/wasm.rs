//! The WASM surface of the Rust witness: JSON request in, JSON response out, over a
//! hand-rolled (ptr, len) ABI — no wasm-bindgen, no generated glue. This module exists so
//! the interactive tour (docs/) can run the conformance vectors through BOTH witnesses in
//! one browser tab and diff their bytes live.
//!
//! This is the one place in the crate where `unsafe` is permitted: the raw-pointer
//! marshaling at the WASM boundary. The core stays unsafe-free.

use serde_json::{json, Value};

use crate::delta::{canonical_hex, compute_id};
use crate::eval::eval_term;
use crate::eval::result_canonical_hex;
use crate::json_profile::parse_claims;
use crate::schema::{HyperSchema, SchemaRegistry};
use crate::set::{make_delta, DeltaSet};
use crate::sign::{sign_claims, verify_delta, Verification};
use crate::term_json::parse_term;
use crate::types::Delta;

fn set_from(v: &Value) -> Result<DeltaSet, String> {
    let arr = v.as_array().ok_or("expected an array of claims")?;
    let mut deltas = Vec::with_capacity(arr.len());
    for c in arr {
        deltas.push(make_delta(parse_claims(c)?, None)?);
    }
    DeltaSet::from_deltas(deltas)
}

fn handle(req: &Value) -> Result<Value, String> {
    let op = req["op"].as_str().ok_or("missing op")?;
    match op {
        // canonical bytes + content address of one claims object (JSON profile)
        "canonical" => {
            let claims = parse_claims(&req["claims"])?;
            Ok(json!({ "hex": canonical_hex(&claims)?, "id": compute_id(&claims)? }))
        }
        // sorted ids + digest of a delta set built from an array of claims
        "setDigest" => {
            let set = set_from(&req["deltas"])?;
            let ids: Vec<String> = set.ids().iter().map(|s| s.to_string()).collect();
            Ok(json!({ "ids": ids, "digest": set.digest() }))
        }
        // deterministic RFC 8032 signature + verification + tamper-rejection
        "sign" => {
            let claims = parse_claims(&req["claims"])?;
            let seed = req["seedHex"].as_str().ok_or("missing seedHex")?;
            let delta = sign_claims(&claims, seed)?;
            let verified = matches!(verify_delta(&delta), Verification::Verified);
            let mut tampered_claims = delta.claims.clone();
            tampered_claims.timestamp += 1.0;
            let tampered = Delta {
                id: delta.id.clone(),
                claims: tampered_claims,
                sig: delta.sig.clone(),
            };
            let tamper_rejected = matches!(verify_delta(&tampered), Verification::Invalid);
            Ok(json!({
                "sig": delta.sig,
                "verified": verified,
                "tamperRejected": tamper_rejected,
            }))
        }
        // full evaluation: fixture claims + term (+ root, + schema registry) -> canonical hex
        "eval" => {
            let set = set_from(&req["fixture"])?;
            let term = parse_term(&req["term"])?;
            let root = req["root"].as_str();
            let registry = match req.get("schemas") {
                Some(Value::Array(arr)) => {
                    let mut schemas = Vec::with_capacity(arr.len());
                    for s in arr {
                        schemas.push(HyperSchema {
                            name: s["name"].as_str().ok_or("schema name")?.to_string(),
                            alg: s["alg"].as_u64().ok_or("schema alg")? as u32,
                            body: parse_term(&s["body"])?,
                        });
                    }
                    Some(SchemaRegistry::build(schemas)?)
                }
                _ => None,
            };
            let result = eval_term(&term, &set, root, registry.as_ref())?;
            Ok(json!({ "hex": result_canonical_hex(&result) }))
        }
        other => Err(format!("unknown op: {other}")),
    }
}

/// The pure core of the ABI, separated for testability: JSON string in, JSON string out.
/// Responses are `{"ok": ...}` or `{"err": "..."}`.
pub fn call_json(input: &str) -> String {
    let response = serde_json::from_str::<Value>(input)
        .map_err(|e| e.to_string())
        .and_then(|req| handle(&req));
    match response {
        Ok(v) => json!({ "ok": v }).to_string(),
        Err(e) => json!({ "err": e }).to_string(),
    }
}

// --- the boundary: raw exports the tour's loader calls -------------------------------------------

/// Allocate `len` bytes the host may write a request into.
#[no_mangle]
pub extern "C" fn rhz_alloc(len: usize) -> *mut u8 {
    let mut buf = vec![0u8; len];
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// Free a buffer previously returned by `rhz_alloc` (or by `rhz_call`'s response).
///
/// # Safety
/// `ptr`/`len` must be exactly a pair previously handed out by this module.
#[no_mangle]
pub unsafe extern "C" fn rhz_dealloc(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, len, len));
}

/// Handle one JSON request; returns `(ptr << 32) | len` of a freshly allocated UTF-8
/// JSON response the host must read and then `rhz_dealloc`.
///
/// # Safety
/// `ptr`/`len` must describe a valid, initialized byte range in linear memory.
#[no_mangle]
pub unsafe extern "C" fn rhz_call(ptr: *const u8, len: usize) -> u64 {
    let input = std::slice::from_raw_parts(ptr, len);
    let out = match std::str::from_utf8(input) {
        Ok(s) => call_json(s),
        Err(e) => json!({ "err": e.to_string() }).to_string(),
    };
    let bytes = out.into_bytes();
    let out_len = bytes.len();
    let out_ptr = rhz_alloc(out_len);
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), out_ptr, out_len);
    ((out_ptr as u64) << 32) | (out_len as u64)
}
