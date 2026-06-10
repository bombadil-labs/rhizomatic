//! The delta set and its algebra (SPEC-1 §8). Mirrors ../ts/src/set.ts.
//! merge is union (grow-only set CRDT), fork is filter, federate is merge of a filtered fork.

use std::collections::BTreeMap;

use crate::cbor::{encode, CborValue};
use crate::delta::compute_id;
use crate::hash::content_address;
use crate::types::{Claims, Delta, DeltaRef, Pointer, Primitive, Target};

/// Build a complete delta from claims (id computed, optional detached sig attached).
pub fn make_delta(claims: Claims, sig: Option<String>) -> Result<Delta, String> {
    let id = compute_id(&claims)?;
    Ok(Delta { id, claims, sig })
}

/// The negation vocabulary convention (SPEC-1 §7): an ordinary delta whose pointer targets the
/// negated delta by content address under role "negates". Meaning is given at evaluation (mask).
pub fn make_negation_claims(
    author: &str,
    timestamp: f64,
    target_delta_id: &str,
    reason: Option<&str>,
) -> Claims {
    let mut pointers = vec![Pointer {
        role: "negates".to_string(),
        target: Target::Delta(DeltaRef {
            delta: target_delta_id.to_string(),
            context: None,
        }),
    }];
    if let Some(r) = reason {
        pointers.push(Pointer {
            role: "reason".to_string(),
            target: Target::Primitive(Primitive::Str(r.to_string())),
        });
    }
    Claims {
        timestamp,
        author: author.to_string(),
        pointers,
    }
}

/// A mathematical set of deltas, deduplicated by id. BTreeMap keeps enumeration canonically
/// sorted by id, which is exactly the order `digest` is defined over.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DeltaSet {
    by_id: BTreeMap<String, Delta>,
}

impl DeltaSet {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_deltas(deltas: impl IntoIterator<Item = Delta>) -> Result<Self, String> {
        let mut s = Self::new();
        for d in deltas {
            s.add(d)?;
        }
        Ok(s)
    }

    /// Idempotent insert; Ok(false) when the id was already present. Verifies content addressing
    /// on the way in (P6): a delta whose id does not recompute is rejected, never repaired
    /// (SPEC-4 §2) — set semantics depend on true ids.
    pub fn add(&mut self, delta: Delta) -> Result<bool, String> {
        if self.by_id.contains_key(&delta.id) {
            return Ok(false);
        }
        let recomputed = compute_id(&delta.claims)?;
        if recomputed != delta.id {
            return Err(format!(
                "delta id {} does not match its claims (content addressing, P6)",
                delta.id
            ));
        }
        self.by_id.insert(delta.id.clone(), delta);
        Ok(true)
    }

    pub fn contains(&self, id: &str) -> bool {
        self.by_id.contains_key(id)
    }

    pub fn get(&self, id: &str) -> Option<&Delta> {
        self.by_id.get(id)
    }

    pub fn len(&self) -> usize {
        self.by_id.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_id.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = &Delta> {
        self.by_id.values()
    }

    /// Sorted lexicographically — the canonical enumeration order (BTreeMap key order).
    pub fn ids(&self) -> Vec<&str> {
        self.by_id.keys().map(String::as_str).collect()
    }

    /// Canonical membership fingerprint (ERRATA D10, provisional helper — not the SPEC-6 digest).
    pub fn digest(&self) -> String {
        let items = self
            .by_id
            .keys()
            .map(|id| CborValue::Tstr(id.clone()))
            .collect();
        content_address(&encode(&CborValue::Array(items)))
    }
}

/// merge(A, B) = A ∪ B — commutative, associative, idempotent (SPEC-1 §8).
pub fn merge(a: &DeltaSet, b: &DeltaSet) -> DeltaSet {
    let mut s = a.clone();
    for d in b.iter() {
        // Members of a DeltaSet already passed the content-address check.
        let _ = s.add(d.clone());
    }
    s
}

/// fork(A, p) = { d ∈ A : p(d) } — any filter yields a valid delta set (SPEC-1 §8).
pub fn fork(a: &DeltaSet, p: impl Fn(&Delta) -> bool) -> DeltaSet {
    let mut s = DeltaSet::new();
    for d in a.iter() {
        if p(d) {
            let _ = s.add(d.clone());
        }
    }
    s
}

/// federate(A, B, p) = A ∪ fork(B, p) — merge of a filtered fork (SPEC-1 §8).
pub fn federate(a: &DeltaSet, b: &DeltaSet, p: impl Fn(&Delta) -> bool) -> DeltaSet {
    merge(a, &fork(b, p))
}
