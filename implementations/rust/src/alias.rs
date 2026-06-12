//! Relation signatures (SPEC-9 §5). Mirrors ../ts/src/alias.ts — the deterministic answer to
//! "what relation shape does this delta instantiate?": the librarian's input, never part of
//! evaluation semantics.

use crate::cbor::{encode, CborValue};
use crate::types::{Delta, Target};

/// The [role, context] pairs ([role] when the pointer has no context) of the delta's EntityRef
/// pointers, sorted bytewise by their canonical CBOR encoding. Primitive and DeltaRef pointers
/// contribute nothing: primitives are not vertices (SPEC-1 §2.3); delta references are plumbing.
pub fn relation_signature(delta: &Delta) -> Vec<Vec<String>> {
    let mut pairs: Vec<(Vec<u8>, Vec<String>)> = delta
        .claims
        .pointers
        .iter()
        .filter_map(|ptr| {
            let Target::Entity(er) = &ptr.target else {
                return None;
            };
            let mut pair = vec![ptr.role.clone()];
            if let Some(c) = &er.context {
                pair.push(c.clone());
            }
            let bytes = encode(&CborValue::Array(
                pair.iter().map(|s| CborValue::Tstr(s.clone())).collect(),
            ));
            Some((bytes, pair))
        })
        .collect();
    pairs.sort_by(|a, b| a.0.cmp(&b.0));
    pairs.into_iter().map(|(_, pair)| pair).collect()
}

/// The signature's canonical form: the canonical CBOR of the sorted array of pairs.
pub fn relation_signature_canonical_hex(delta: &Delta) -> String {
    let arrays: Vec<CborValue> = relation_signature(delta)
        .into_iter()
        .map(|pair| CborValue::Array(pair.into_iter().map(CborValue::Tstr).collect()))
        .collect();
    hex::encode(encode(&CborValue::Array(arrays)))
}
