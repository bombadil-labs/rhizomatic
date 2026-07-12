//! The reactor core (SPEC-4 §2-3, ERRATA-4). Mirrors ../ts/src/reactor.ts.
//! ingest -> validate -> persist -> index; the log is the truth, indexes are derived.

use std::collections::{BTreeMap, BTreeSet};

use crate::eval::{eval_term, EvalResult, Term};
use crate::hview::HView;
use crate::materialize::{Materialization, MaterializationChange};
use crate::pred::compare_primitives;
use crate::resolution::{view_canonical_hex, View};
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
    materializations: BTreeMap<String, Materialization>,
    last_changes: Vec<MaterializationChange>,
}

fn mat_affects(mat: &Materialization, delta: &Delta, root: &str, set: &DeltaSet) -> bool {
    mat.affects(delta, root, set)
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
        self.last_changes = self.dispatch_and_update(std::slice::from_ref(&delta));
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
        eval_term(term, &self.set, root, registry, None)
    }

    // --- materializations (SPEC-4 §4, ERRATA-4 V5) ---

    /// Register a live materialization: an HView-sort term kept incrementally equal to batch
    /// evaluation at each root (SPEC-4 §1).
    pub fn register(
        &mut self,
        name: &str,
        term: Term,
        roots: &[String],
        registry: Option<SchemaRegistry>,
    ) -> Result<(), String> {
        if self.materializations.contains_key(name) {
            return Err(format!("duplicate materialization: {name}"));
        }
        let mut mat = Materialization::new(name, term, roots, registry);
        for root in mat.roots.clone() {
            mat.refresh(&self.set, &root)?;
        }
        self.materializations.insert(name.to_string(), mat);
        Ok(())
    }

    pub fn materialized_hex(&self, name: &str, root: &str) -> Option<&str> {
        self.materializations
            .get(name)
            .and_then(|m| m.hexes.get(root).map(String::as_str))
    }

    pub fn materialized_view(&self, name: &str, root: &str) -> Option<&HView> {
        self.materializations
            .get(name)
            .and_then(|m| m.views.get(root))
    }

    pub fn eval_count_of(&self, name: &str) -> u64 {
        self.materializations
            .get(name)
            .map(|m| m.eval_count)
            .unwrap_or(0)
    }

    pub fn changes_from_last_ingest(&self) -> &[MaterializationChange] {
        &self.last_changes
    }

    fn dispatch_and_update(&mut self, deltas: &[Delta]) -> Vec<MaterializationChange> {
        // Split borrows: materializations is mutated while the set is read.
        let Self {
            set,
            materializations,
            ..
        } = self;
        let responsible: Vec<String> = deltas.iter().map(|d| d.id.clone()).collect();
        let mut changes = Vec::new();
        for mat in materializations.values_mut() {
            let affected: Vec<String> = mat
                .roots
                .iter()
                .filter(|root| deltas.iter().any(|d| mat_affects(mat, d, root, set)))
                .cloned()
                .collect();
            for root in affected {
                if let Some(changed_props) = mat
                    .refresh(set, &root)
                    .expect("registered terms stay evaluable")
                {
                    changes.push(MaterializationChange {
                        materialization: mat.name.clone(),
                        root: root.clone(),
                        changed_props,
                        responsible_delta_ids: responsible.clone(),
                        new_hex: mat.hexes.get(&root).unwrap().clone(),
                    });
                }
            }
        }
        changes
    }

    // --- atomic batch ingestion (SPEC-1 §9, SPEC-4 §6) ---

    /// Manifest-keyed atomic ingestion: validate everything first; all members become visible to
    /// dispatch in one step, or none do.
    pub fn ingest_bundle(&mut self, manifest: Delta, members: &[Delta]) -> IngestResult {
        let mut fresh: Vec<Delta> = Vec::new();
        for d in members.iter().chain(std::iter::once(&manifest)) {
            if self.set.contains(&d.id) {
                continue;
            }
            if d.sig.is_some() && verify_delta(d) != Verification::Verified {
                return IngestResult::Rejected(format!(
                    "bundle member {}: signature does not verify",
                    d.id
                ));
            }
            let mut probe = DeltaSet::new();
            if let Err(e) = probe.add(d.clone()) {
                return IngestResult::Rejected(format!("bundle member {}: {e}", d.id));
            }
            fresh.push(d.clone());
        }
        // The manifest must commit to every supplied member by content address (SPEC-1 §9).
        let committed = manifest_member_ids(&manifest);
        for m in members {
            if !committed.contains(&m.id) {
                return IngestResult::Rejected(format!(
                    "member {} is not claimed by the manifest",
                    m.id
                ));
            }
        }
        if fresh.is_empty() {
            return IngestResult::Duplicate;
        }
        for d in &fresh {
            self.set.add(d.clone()).expect("validated above");
            self.index(d);
            self.log.push(d.clone());
        }
        self.last_changes = self.dispatch_and_update(&fresh);
        IngestResult::Accepted
    }

    /// Completeness is verifiable, not enforced (SPEC-1 §9): a hash check.
    pub fn holds_all_members(&self, manifest_id: &str) -> bool {
        let Some(manifest) = self.set.get(manifest_id) else {
            return false;
        };
        manifest_member_ids(manifest)
            .iter()
            .all(|id| self.set.contains(id))
    }
}

// --- the rdb.txn vocabulary (SPEC-1 §9) ---

use crate::schema_deltas::VOCAB_PREFIX;
use crate::types::{Claims, DeltaRef, Pointer};

pub fn make_manifest_claims(
    author: &str,
    timestamp: f64,
    member_ids: &[String],
    prior: Option<&str>,
    intent: Option<&str>,
) -> Claims {
    let mut pointers: Vec<Pointer> = member_ids
        .iter()
        .map(|id| Pointer {
            role: format!("{VOCAB_PREFIX}.txn.member"),
            target: Target::Delta(DeltaRef {
                delta: id.clone(),
                context: None,
            }),
        })
        .collect();
    if let Some(p) = prior {
        pointers.push(Pointer {
            role: format!("{VOCAB_PREFIX}.txn.prior"),
            target: Target::Delta(DeltaRef {
                delta: p.to_string(),
                context: None,
            }),
        });
    }
    if let Some(i) = intent {
        pointers.push(Pointer {
            role: format!("{VOCAB_PREFIX}.txn.intent"),
            target: Target::Primitive(crate::types::Primitive::Str(i.to_string())),
        });
    }
    Claims {
        timestamp,
        author: author.to_string(),
        pointers,
    }
}

pub fn manifest_member_ids(manifest: &Delta) -> Vec<String> {
    let member_role = format!("{VOCAB_PREFIX}.txn.member");
    manifest
        .claims
        .pointers
        .iter()
        .filter_map(|p| {
            if p.role != member_role {
                return None;
            }
            match &p.target {
                Target::Delta(dr) => Some(dr.delta.clone()),
                _ => None,
            }
        })
        .collect()
}
