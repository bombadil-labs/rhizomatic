//! The delta set and its algebra (SPEC-1 §8). Mirrors ../ts/src/set.ts.
//! merge is union (grow-only set CRDT), fork is filter, federate is merge of a filtered fork.

use std::collections::{BTreeMap, BTreeSet};

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
        valid_from: timestamp,
        valid_until: None,
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

    /// Internal peer-state copy: these members were verified when they entered this set.
    pub(crate) fn without_verified_ids(&self, ids: &BTreeSet<&str>) -> Self {
        let mut next = self.clone();
        next.by_id.retain(|id, _| !ids.contains(id.as_str()));
        next
    }

    /// The members with these ids, carried without re-verification; absent ids are skipped. Cost
    /// is the number of ids, not the size of this set (SPEC-17 §3).
    pub fn subset(&self, ids: &[String]) -> Self {
        let mut next = Self::new();
        for id in ids {
            if let Some(delta) = self.by_id.get(id) {
                next.by_id.insert(id.clone(), delta.clone());
            }
        }
        next
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

/// The read side of a store (SPEC-17 §3). `targets` and `negators` answer from indexes; neither
/// may scan the store. Each list holds each id once, ascending by the UTF-8 bytes of the id
/// (SPEC-18 §4.2); Rust `String` order is that order.
///
/// A source over a fetched scope answers only from what was fetched: it cannot tell an absent
/// delta from one that was not fetched. A caller fetches the anchors of everything it asks about.
pub trait DeltaSource {
    fn get(&self, id: &str) -> Option<&Delta>;
    /// Ids of every delta with a pointer whose target is the entity `entity`, any role or context.
    fn targets(&self, entity: &str) -> Vec<String>;
    /// Ids of every delta with a pointer `{role: "negates", target: DeltaRef(id)}`.
    fn negators(&self, id: &str) -> Vec<String>;
    /// The members with these ids. A source that verified its members on the way in overrides
    /// this to skip hashing them again.
    fn subset(&self, ids: &[String]) -> DeltaSet {
        DeltaSet::from_deltas(ids.iter().filter_map(|id| self.get(id).cloned()))
            .expect("a delta source holds only content-addressed deltas")
    }
}

/// A read-time negation query over any delta source. It reads only `get` and `negators`. The
/// shared borrow of the source prevents a change of membership while this reader lives, so its
/// memo needs no membership revision check.
///
/// An id the source does not hold has no witnesses, and a negation the source does not hold is
/// not counted. Over a fetched scope S(E) the answers for the members of S(E) equal the answers
/// over the whole surface, because S(E) is closed under held negators.
pub struct NegationReader<'a, S, F>
where
    S: DeltaSource + ?Sized,
    F: Fn(&Delta, &Delta) -> bool,
{
    source: &'a S,
    now: f64,
    suppression: F,
    memo: BTreeMap<String, Vec<Delta>>,
    visiting: BTreeSet<String>,
}

impl<S, F> NegationReader<'_, S, F>
where
    S: DeltaSource + ?Sized,
    F: Fn(&Delta, &Delta) -> bool,
{
    /// Effective direct negations, in ascending delta-id order. Target validity is independent.
    /// The suppression callback must not invoke this reader recursively; compute trust first.
    pub fn witnesses(&mut self, id: &str) -> Vec<Delta> {
        if let Some(cached) = self.memo.get(id) {
            return cached.clone();
        }
        let Some(target) = self.source.get(id).cloned() else {
            return Vec::new();
        };
        if !self.visiting.insert(id.to_string()) {
            return Vec::new();
        }
        let mut effective = Vec::new();
        for negation_id in self.source.negators(id) {
            let Some(negation) = self.source.get(&negation_id).cloned() else {
                continue;
            };
            if negation.claims.valid_from > self.now
                || negation
                    .claims
                    .valid_until
                    .is_some_and(|end| self.now >= end)
            {
                continue;
            }
            if !(self.suppression)(&negation, &target) || !self.witnesses(&negation_id).is_empty() {
                continue;
            }
            effective.push(negation);
        }
        self.visiting.remove(id);
        self.memo.insert(id.to_string(), effective.clone());
        effective
    }

    pub fn is_negated(&mut self, id: &str) -> bool {
        !self.witnesses(id).is_empty()
    }
}

/// Build a memoized negation query over held targets and valid negation edges at an explicit
/// time. `suppression(negation, target)` says whether that negation may suppress that target.
pub fn negation_reader<S, F>(
    source: &S,
    now: f64,
    suppression: F,
) -> Result<NegationReader<'_, S, F>, String>
where
    S: DeltaSource + ?Sized,
    F: Fn(&Delta, &Delta) -> bool,
{
    if !now.is_finite() {
        return Err("now must be a finite number".to_string());
    }
    Ok(NegationReader {
        source,
        now,
        suppression,
        memo: BTreeMap::new(),
        visiting: BTreeSet::new(),
    })
}

/// The effective direct negations of one delta, in ascending delta-id order. For several ids
/// build one [`negation_reader`], which shares its memo between them.
pub fn negation_witnesses<S, F>(
    source: &S,
    id: &str,
    now: f64,
    suppression: F,
) -> Result<Vec<Delta>, String>
where
    S: DeltaSource + ?Sized,
    F: Fn(&Delta, &Delta) -> bool,
{
    Ok(negation_reader(source, now, suppression)?.witnesses(id))
}

/// A predicate `is this id negated at now`, memoized across its calls.
pub fn negation_predicate<'a, S, F>(
    source: &'a S,
    now: f64,
    suppression: F,
) -> Result<impl FnMut(&str) -> bool + 'a, String>
where
    S: DeltaSource + ?Sized,
    F: Fn(&Delta, &Delta) -> bool + 'a,
{
    let mut reader = negation_reader(source, now, suppression)?;
    Ok(move |id: &str| reader.is_negated(id))
}
