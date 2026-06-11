//! Materializations + incremental maintenance (SPEC-4 §4, ERRATA-4 V5).
//! Mirrors the materialization half of ../ts/src/reactor.ts: root-localized recomputation with
//! sound (over-matching, never under-matching) dispatch.

use std::collections::{BTreeMap, BTreeSet};

use crate::cbor::{encode, CborValue};
use crate::eval::{eval_term, EvalResult, SchemaRef, Term};
use crate::hview::{hv_entry_to_cbor, hview_canonical_hex, HView};
use crate::pred::Pred;
use crate::schema::{collect_refs, SchemaRegistry};
use crate::set::DeltaSet;
use crate::types::{Delta, Target};

/// A change event carries: root, affected property paths, responsible delta ids, new content
/// hash (SPEC-4 §5). Rust exposes events pull-based (the reactor's change log); TS exposes the
/// same content push-based — transport is out of scope (SPEC-4 §5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaterializationChange {
    pub materialization: String,
    pub root: String,
    pub changed_props: Vec<String>,
    pub responsible_delta_ids: Vec<String>,
    pub new_hex: String,
}

#[derive(Debug)]
pub(crate) struct Materialization {
    pub name: String,
    pub term: Term,
    pub roots: Vec<String>,
    pub root_anchored: bool,
    pub views: BTreeMap<String, HView>,
    pub hexes: BTreeMap<String, String>,
    pub prop_hexes: BTreeMap<String, BTreeMap<String, String>>,
    pub support_entities: BTreeMap<String, BTreeSet<String>>,
    pub eval_count: u64,
    pub registry: Option<SchemaRegistry>,
}

impl Materialization {
    pub fn new(name: &str, term: Term, roots: &[String], registry: Option<SchemaRegistry>) -> Self {
        Self {
            name: name.to_string(),
            root_anchored: is_root_anchored(&term, registry.as_ref()),
            term,
            roots: roots.to_vec(),
            views: BTreeMap::new(),
            hexes: BTreeMap::new(),
            prop_hexes: BTreeMap::new(),
            support_entities: BTreeMap::new(),
            eval_count: 0,
            registry,
        }
    }

    /// Re-evaluate one root with the batch evaluator; Some(changed property paths) on change.
    pub fn refresh(&mut self, set: &DeltaSet, root: &str) -> Result<Option<Vec<String>>, String> {
        let result = eval_term(&self.term, set, Some(root), self.registry.as_ref(), None)?;
        let EvalResult::HView(h) = result else {
            return Err("materialized terms must be HView-sort".to_string());
        };
        self.eval_count += 1;
        let hex = hview_canonical_hex(&h);
        let changed = self.hexes.get(root) != Some(&hex);
        let new_prop_hexes = prop_hexes_of(&h);
        let changed_props = if changed {
            let empty = BTreeMap::new();
            let before = self.prop_hexes.get(root).unwrap_or(&empty);
            Some(diff_props(before, &new_prop_hexes))
        } else {
            None
        };
        let mut entities = BTreeSet::new();
        entities.insert(root.to_string());
        collect_nested_ids(&h, &mut entities);
        self.support_entities.insert(root.to_string(), entities);
        self.views.insert(root.to_string(), h);
        self.hexes.insert(root.to_string(), hex);
        self.prop_hexes.insert(root.to_string(), new_prop_hexes);
        Ok(changed_props)
    }

    /// Sound dispatch (V5): over-match allowed, under-match forbidden.
    pub fn affects(&self, delta: &Delta, root: &str, set: &DeltaSet) -> bool {
        if !self.root_anchored {
            return true; // broad dispatch for non-anchored terms
        }
        let fallback = BTreeSet::from([root.to_string()]);
        let support = self.support_entities.get(root).unwrap_or(&fallback);
        if targets_support(delta, support) {
            return true;
        }
        for ptr in &delta.claims.pointers {
            if ptr.role != "negates" {
                continue;
            }
            if let Target::Delta(dr) = &ptr.target {
                if chain_touches_support(&dr.delta, support, set, 0) {
                    return true;
                }
            }
        }
        false
    }
}

fn targets_support(delta: &Delta, support: &BTreeSet<String>) -> bool {
    delta
        .claims
        .pointers
        .iter()
        .any(|p| matches!(&p.target, Target::Entity(er) if support.contains(&er.id)))
}

// Walk a negation chain downward toward base data (V5): membership is checked against
// RELEVANCE (targets a support entity), not presence, so reinstatement chains dispatch.
fn chain_touches_support(id: &str, support: &BTreeSet<String>, set: &DeltaSet, depth: u32) -> bool {
    if depth > 64 {
        return true; // adversarial-depth guard: over-match rather than recurse forever
    }
    let Some(target) = set.get(id) else {
        return false; // unknown target: nothing materialized depends on it
    };
    if targets_support(target, support) {
        return true;
    }
    for ptr in &target.claims.pointers {
        if ptr.role != "negates" {
            continue;
        }
        if let Target::Delta(dr) = &ptr.target {
            if chain_touches_support(&dr.delta, support, set, depth + 1) {
                return true;
            }
        }
    }
    false
}

/// Collect every nested (expanded) HView id, recursively — the support-entity set (V5).
fn collect_nested_ids(h: &HView, out: &mut BTreeSet<String>) {
    for entries in h.props.values() {
        for e in entries {
            for nested in e.expanded.values() {
                out.insert(nested.id.clone());
                collect_nested_ids(nested, out);
            }
        }
    }
}

/// Does this predicate conjunctively REQUIRE a pointer at $root? (V5 anchoring analyzer)
fn pred_requires_root(pred: &Pred) -> bool {
    match pred {
        Pred::HasPointer(pp) => matches!(pp.target_entity, Some(crate::pred::EntityMatch::Root)),
        Pred::And(l, r) => pred_requires_root(l) || pred_requires_root(r),
        Pred::Or(l, r) => pred_requires_root(l) && pred_requires_root(r),
        _ => false,
    }
}

/// Does every group in this pipeline sit above a root-requiring select?
fn pipeline_anchored(t: &Term) -> bool {
    match t {
        Term::Input => false,
        Term::Select { pred, of } => pred_requires_root(pred) || pipeline_anchored(of),
        Term::Mask { of, .. } => pipeline_anchored(of),
        Term::Union { left, right } => pipeline_anchored(left) && pipeline_anchored(right),
        _ => false,
    }
}

fn term_anchored(t: &Term) -> bool {
    match t {
        Term::Group { of, .. } => pipeline_anchored(of),
        Term::Prune { of, .. } | Term::Expand { of, .. } | Term::Resolve { of, .. } => {
            term_anchored(of)
        }
        // anchoring of the referenced schema is checked via the registry walk below
        Term::Fix { .. } => true,
        _ => false,
    }
}

/// Root anchoring across the term and every transitively referenced schema body (V5).
pub fn is_root_anchored(term: &Term, registry: Option<&SchemaRegistry>) -> bool {
    if !term_anchored(term) {
        return false;
    }
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut queue: Vec<SchemaRef> = collect_refs(term);
    while let Some(r) = queue.pop() {
        let key = match &r {
            SchemaRef::Name(n) => format!("n:{n}"),
            SchemaRef::Pinned(h) => format!("h:{h}"),
        };
        if !seen.insert(key) {
            continue;
        }
        let Some(schema) = registry.and_then(|reg| reg.resolve(&r)) else {
            return false; // unresolvable: be conservative, dispatch broadly
        };
        if !term_anchored(&schema.body) {
            return false;
        }
        queue.extend(collect_refs(&schema.body));
    }
    true
}

/// Per-property canonical hexes, for change-path diffing (SPEC-4 §5).
fn prop_hexes_of(h: &HView) -> BTreeMap<String, String> {
    h.props
        .iter()
        .map(|(prop, entries)| {
            let arr = CborValue::Array(entries.iter().map(hv_entry_to_cbor).collect());
            (prop.clone(), hex::encode(encode(&arr)))
        })
        .collect()
}

fn diff_props(before: &BTreeMap<String, String>, after: &BTreeMap<String, String>) -> Vec<String> {
    let mut changed: BTreeSet<String> = BTreeSet::new();
    for (prop, hex) in after {
        if before.get(prop) != Some(hex) {
            changed.insert(prop.clone());
        }
    }
    for prop in before.keys() {
        if !after.contains_key(prop) {
            changed.insert(prop.clone());
        }
    }
    changed.into_iter().collect()
}
