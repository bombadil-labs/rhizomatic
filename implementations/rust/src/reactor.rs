//! The reactor core (SPEC-4 §2-3, ERRATA-4). Mirrors ../ts/src/reactor.ts.
//! ingest -> validate -> persist -> index; the log is the truth, indexes are derived.

use std::collections::{BTreeMap, BTreeSet};

use crate::eval::{eval_term, EvalResult, Term};
use crate::policy::{view_canonical_hex, View};
use crate::pred::compare_primitives;
use crate::schema::SchemaRegistry;
use crate::set::DeltaSet;
use crate::sign::{verify_delta, Verification};
use crate::types::{Delta, Primitive, Target};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IngestResult {
    Accepted,
    Duplicate,
    Rejected(String),
}

#[derive(Debug, Default)]
pub struct Reactor {
    /// The append-only log in arrival order (v0: in-memory; the log is still the truth — V2).
    log: Vec<Delta>,
    set: DeltaSet,
    /// target index: EntityId -> delta ids whose pointers target that entity (SPEC-4 §3)
    target_index: BTreeMap<String, BTreeSet<String>>,
    /// negation index: delta id -> ids of negations targeting it (SPEC-4 §3)
    negation_index: BTreeMap<String, BTreeSet<String>>,
    /// value index: role -> canonical primitive key -> (value, ids) (V1: keyed by role)
    value_index: BTreeMap<String, BTreeMap<String, (Primitive, BTreeSet<String>)>>,
}

impl Reactor {
    pub fn new() -> Self {
        Self::default()
    }

    /// Validate -> persist -> index. Idempotent by id; rejected deltas leave no trace (V3).
    pub fn ingest(&mut self, delta: Delta) -> IngestResult {
        if self.set.contains(&delta.id) {
            return IngestResult::Duplicate;
        }
        // A present signature must verify; unsigned deltas remain legal at L1 (D9).
        if delta.sig.is_some() && verify_delta(&delta) != Verification::Verified {
            return IngestResult::Rejected("signature does not verify".to_string());
        }
        // add() recomputes the content address and runs L1 validation.
        match self.set.add(delta.clone()) {
            Ok(true) => {}
            Ok(false) => return IngestResult::Duplicate,
            Err(e) => return IngestResult::Rejected(e),
        }
        self.index(&delta);
        self.log.push(delta);
        IngestResult::Accepted
    }

    fn index(&mut self, delta: &Delta) {
        for ptr in &delta.claims.pointers {
            match &ptr.target {
                Target::Entity(er) => {
                    self.target_index
                        .entry(er.id.clone())
                        .or_default()
                        .insert(delta.id.clone());
                }
                Target::Delta(dr) => {
                    if ptr.role == "negates" {
                        self.negation_index
                            .entry(dr.delta.clone())
                            .or_default()
                            .insert(delta.id.clone());
                    }
                }
                Target::Primitive(v) => {
                    let key = view_canonical_hex(&View::Prim(v.clone()));
                    self.value_index
                        .entry(ptr.role.clone())
                        .or_default()
                        .entry(key)
                        .or_insert_with(|| (v.clone(), BTreeSet::new()))
                        .1
                        .insert(delta.id.clone());
                }
            }
        }
    }

    // --- queries over the core indexes (sorted ids — canonical enumeration order) ---

    pub fn by_target(&self, entity_id: &str) -> Vec<String> {
        self.target_index
            .get(entity_id)
            .map(|s| s.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub fn negations_of(&self, delta_id: &str) -> Vec<String> {
        self.negation_index
            .get(delta_id)
            .map(|s| s.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Range/equality queries over primitive payloads filed under a role (V1).
    pub fn by_value(&self, role: &str, matches: impl Fn(&Primitive) -> bool) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        if let Some(bucket) = self.value_index.get(role) {
            for (value, ids) in bucket.values() {
                if matches(value) {
                    out.extend(ids.iter().cloned());
                }
            }
        }
        out.sort();
        out
    }

    pub fn by_value_between(&self, role: &str, lo: &Primitive, hi: &Primitive) -> Vec<String> {
        self.by_value(role, |v| {
            compare_primitives(v, lo) != std::cmp::Ordering::Less
                && compare_primitives(v, hi) != std::cmp::Ordering::Greater
        })
    }

    // --- the log and the set ---

    pub fn len(&self) -> usize {
        self.set.len()
    }

    pub fn is_empty(&self) -> bool {
        self.set.is_empty()
    }

    pub fn contains(&self, id: &str) -> bool {
        self.set.contains(id)
    }

    pub fn get(&self, id: &str) -> Option<&Delta> {
        self.set.get(id)
    }

    /// Arrival order — a transport artifact, never consulted by evaluation (SPEC-4 §2).
    pub fn arrival_log(&self) -> &[Delta] {
        &self.log
    }

    pub fn digest(&self) -> String {
        self.set.digest()
    }

    pub fn snapshot(&self) -> DeltaSet {
        self.set.clone()
    }

    /// Batch evaluation over the current set — the oracle hookup (SPEC-4 §1). Read-your-writes
    /// holds trivially: ingest is synchronous (§6).
    pub fn eval(
        &self,
        term: &Term,
        root: Option<&str>,
        registry: Option<&SchemaRegistry>,
    ) -> Result<EvalResult, String> {
        eval_term(term, &self.set, root, registry)
    }
}
