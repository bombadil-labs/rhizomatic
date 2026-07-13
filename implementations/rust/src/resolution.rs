//! Resolution (SPEC-5, ERRATA-5): a Schema — per-property Policies + a default — resolves a
//! HyperView into a View. Mirrors ../ts/src/resolution.ts.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

use crate::cbor::{encode, CborValue};
use crate::hview::{HVEntry, HView};
use crate::pred::{compare_primitives, eval_pred, Pred};
use crate::types::{Primitive, Target};

#[derive(Debug, Clone, PartialEq)]
pub enum View {
    Prim(Primitive),
    /// a bytes leaf, shaped identically to the target (SPEC-5 §5, SPEC-1 §2). Non-primitive:
    /// transparent to merge folds, a full participant in pick/all/conflicts.
    Bytes {
        mime: String,
        value: Vec<u8>,
    },
    Arr(Vec<View>),
    Obj(BTreeMap<String, View>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeFn {
    Max,
    Min,
    Sum,
    Count,
    And,
    Or,
    ConcatSorted,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Order {
    ByTimestamp { desc: bool },
    ByAuthorRank(Vec<String>),
    ByPred { pred: Pred, then: Box<Order> },
    Chain(Vec<Order>),
    LexById,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Policy {
    Pick(Order),
    All(Order),
    Merge(MergeFn),
    Conflicts(Order),
    AbsentAs {
        constant: Primitive,
        then: Box<Policy>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Schema {
    pub props: BTreeMap<String, Policy>,
    pub default: Policy,
}

// --- ordering (R3: every chain ends in an implicit lexById tiebreak) ------------------------------

fn cmp_by_order(order: &Order, a: &HVEntry, b: &HVEntry) -> Ordering {
    match order {
        Order::ByTimestamp { desc } => {
            let o = a
                .delta
                .claims
                .timestamp
                .partial_cmp(&b.delta.claims.timestamp)
                .expect("timestamps are finite");
            if *desc {
                o.reverse()
            } else {
                o
            }
        }
        Order::ByAuthorRank(authors) => {
            let rank = |author: &str| {
                authors
                    .iter()
                    .position(|a| a == author)
                    .unwrap_or(authors.len())
            };
            rank(&a.delta.claims.author).cmp(&rank(&b.delta.claims.author))
        }
        Order::ByPred { pred, then } => {
            let am = !eval_pred(pred, &a.delta, None);
            let bm = !eval_pred(pred, &b.delta, None);
            match am.cmp(&bm) {
                Ordering::Equal => cmp_by_order(then, a, b),
                o => o, // matches (false < true after negation) first
            }
        }
        Order::Chain(orders) => orders
            .iter()
            .map(|o| cmp_by_order(o, a, b))
            .find(|c| *c != Ordering::Equal)
            .unwrap_or(Ordering::Equal),
        Order::LexById => a.delta.id.cmp(&b.delta.id),
    }
}

fn sort_entries<'a>(order: &Order, entries: &'a [HVEntry]) -> Vec<&'a HVEntry> {
    let mut out: Vec<&HVEntry> = entries.iter().collect();
    out.sort_by(|a, b| cmp_by_order(order, a, b).then_with(|| a.delta.id.cmp(&b.delta.id)));
    out
}

// --- candidate value extraction (R1) ---------------------------------------------------------------

fn render_target(t: &Target, expansion: Option<&HView>, schema: &Schema) -> View {
    if let Some(h) = expansion {
        return resolve_view(schema, h);
    }
    match t {
        Target::Primitive(p) => View::Prim(p.clone()),
        Target::Entity(e) => View::Prim(Primitive::Str(e.id.clone())),
        Target::Delta(d) => View::Prim(Primitive::Str(d.delta.clone())),
        Target::Bytes { mime, value } => View::Bytes {
            mime: mime.clone(),
            value: value.clone(),
        },
    }
}

fn candidate_value(e: &HVEntry, root: &str, schema: &Schema) -> View {
    let mut non_filing: Vec<(String, View)> = Vec::new();
    for (i, p) in e.delta.claims.pointers.iter().enumerate() {
        let filing = matches!(&p.target, Target::Entity(er) if er.id == root);
        if filing {
            continue;
        }
        non_filing.push((
            p.role.clone(),
            render_target(&p.target, e.expanded.get(&i), schema),
        ));
    }
    if non_filing.is_empty() {
        return View::Prim(Primitive::Bool(true)); // the bare fact of the edge
    }
    if non_filing.len() == 1 {
        return non_filing.into_iter().next().unwrap().1;
    }
    let mut obj: BTreeMap<String, View> = BTreeMap::new();
    for (role, v) in non_filing {
        match obj.remove(&role) {
            None => {
                obj.insert(role, v);
            }
            Some(View::Arr(mut xs)) => {
                xs.push(v);
                obj.insert(role, View::Arr(xs));
            }
            Some(existing) => {
                obj.insert(role, View::Arr(vec![existing, v]));
            }
        }
    }
    View::Obj(obj)
}

// --- View canonical form (R4) ----------------------------------------------------------------------

pub fn view_to_cbor(v: &View) -> CborValue {
    match v {
        View::Prim(Primitive::Str(s)) => CborValue::Tstr(s.clone()),
        View::Prim(Primitive::Num(n)) => CborValue::Float(*n),
        View::Prim(Primitive::Bool(b)) => CborValue::Bool(*b),
        // the bytes leaf's canonical CBOR IS the target's — defined once, reused (SPEC-5 §5).
        View::Bytes { mime, value } => CborValue::Map(vec![
            ("mime".to_string(), CborValue::Tstr(mime.clone())),
            ("value".to_string(), CborValue::Bstr(value.clone())),
        ]),
        View::Arr(xs) => CborValue::Array(xs.iter().map(view_to_cbor).collect()),
        View::Obj(m) => CborValue::Map(
            m.iter()
                .map(|(k, x)| (k.clone(), view_to_cbor(x)))
                .collect(),
        ),
    }
}

pub fn view_canonical_hex(v: &View) -> String {
    hex::encode(encode(&view_to_cbor(v)))
}

// --- resolution ------------------------------------------------------------------------------------

fn is_primitive(v: &View) -> Option<&Primitive> {
    match v {
        View::Prim(p) => Some(p),
        _ => None,
    }
}

fn apply_merge(fn_: MergeFn, entries: &[HVEntry], root: &str, schema: &Schema) -> Option<View> {
    // Fold in ascending delta-id order — float addition is order-dependent (R2).
    let sorted = sort_entries(&Order::LexById, entries);
    if fn_ == MergeFn::Count {
        return if sorted.is_empty() {
            None
        } else {
            Some(View::Prim(Primitive::Num(sorted.len() as f64)))
        };
    }
    let prims: Vec<Primitive> = sorted
        .iter()
        .map(|e| candidate_value(e, root, schema))
        .filter_map(|v| is_primitive(&v).cloned())
        .collect();
    match fn_ {
        MergeFn::Max | MergeFn::Min => prims
            .into_iter()
            .reduce(|acc, v| {
                let c = compare_primitives(&v, &acc);
                let take = if fn_ == MergeFn::Max {
                    c == Ordering::Greater
                } else {
                    c == Ordering::Less
                };
                if take {
                    v
                } else {
                    acc
                }
            })
            .map(View::Prim),
        MergeFn::Sum => {
            let nums: Vec<f64> = prims
                .iter()
                .filter_map(|p| match p {
                    Primitive::Num(n) => Some(*n),
                    _ => None,
                })
                .collect();
            if nums.is_empty() {
                None
            } else {
                Some(View::Prim(Primitive::Num(
                    nums.iter().fold(0.0, |a, b| a + b),
                )))
            }
        }
        MergeFn::And | MergeFn::Or => {
            let bools: Vec<bool> = prims
                .iter()
                .filter_map(|p| match p {
                    Primitive::Bool(b) => Some(*b),
                    _ => None,
                })
                .collect();
            if bools.is_empty() {
                None
            } else if fn_ == MergeFn::And {
                Some(View::Prim(Primitive::Bool(bools.iter().all(|b| *b))))
            } else {
                Some(View::Prim(Primitive::Bool(bools.iter().any(|b| *b))))
            }
        }
        MergeFn::ConcatSorted => {
            if prims.is_empty() {
                None
            } else {
                let mut sorted_prims = prims;
                sorted_prims.sort_by(compare_primitives);
                Some(View::Arr(
                    sorted_prims.into_iter().map(View::Prim).collect(),
                ))
            }
        }
        MergeFn::Count => unreachable!("handled above"),
    }
}

fn apply_policy(policy: &Policy, entries: &[HVEntry], root: &str, schema: &Schema) -> Option<View> {
    match policy {
        Policy::Pick(order) => {
            if entries.is_empty() {
                return None;
            }
            let sorted = sort_entries(order, entries);
            Some(candidate_value(sorted[0], root, schema))
        }
        Policy::All(order) => {
            if entries.is_empty() {
                return None;
            }
            Some(View::Arr(
                sort_entries(order, entries)
                    .iter()
                    .map(|e| candidate_value(e, root, schema))
                    .collect(),
            ))
        }
        Policy::Merge(fn_) => apply_merge(*fn_, entries, root, schema),
        Policy::Conflicts(order) => {
            let sorted = sort_entries(order, entries);
            let mut seen: BTreeSet<String> = BTreeSet::new();
            let mut distinct: Vec<View> = Vec::new();
            for e in sorted {
                let v = candidate_value(e, root, schema);
                if seen.insert(view_canonical_hex(&v)) {
                    distinct.push(v);
                }
            }
            if distinct.len() >= 2 {
                Some(View::Arr(distinct))
            } else {
                None
            }
        }
        Policy::AbsentAs { constant, then } => {
            apply_policy(then, entries, root, schema).or_else(|| Some(View::Prim(constant.clone())))
        }
    }
}

/// resolve(schema, HView) -> View. Deterministic; total; provenance-optional (SPEC-5 §2).
/// The View covers every property named in the schema plus every HView property (R3).
pub fn resolve_view(schema: &Schema, hview: &HView) -> View {
    let mut keys: BTreeSet<&String> = schema.props.keys().collect();
    keys.extend(hview.props.keys());
    let empty: Vec<HVEntry> = Vec::new();
    let mut obj: BTreeMap<String, View> = BTreeMap::new();
    for key in keys {
        let entries = hview.props.get(key).unwrap_or(&empty);
        let policy = schema.props.get(key).unwrap_or(&schema.default);
        if let Some(v) = apply_policy(policy, entries, &hview.id, schema) {
            obj.insert(key.clone(), v);
        }
    }
    View::Obj(obj)
}
