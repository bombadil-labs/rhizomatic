//! Term evaluation for the DSet fragment: select, union, mask (SPEC-2 §4.1-4.3).
//! Mirrors ../ts/src/eval.ts. eval is pure, order-blind, deterministic (SPEC-2 §5).

use std::collections::{BTreeSet, HashMap};

use crate::cbor::{encode, CborValue};
use crate::pred::{eval_pred, Pred};
use crate::set::{fork, merge, DeltaSet};
use crate::types::{Delta, Target};

#[derive(Debug, Clone, PartialEq)]
pub enum MaskPolicy {
    Drop,
    Annotate,
    Trust(Pred),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Term {
    Input,
    Select { pred: Pred, of: Box<Term> },
    Union { left: Box<Term>, right: Box<Term> },
    Mask { policy: MaskPolicy, of: Box<Term> },
}

#[derive(Debug, Clone, PartialEq)]
pub struct EvalResult {
    pub set: DeltaSet,
    /// Negation tags; populated only by a top-level mask(annotate) (ERRATA-2 E2).
    pub negated: BTreeSet<String>,
    pub annotated: bool,
}

fn is_negated(
    id: &str,
    negators: &HashMap<String, Vec<String>>,
    memo: &mut HashMap<String, bool>,
) -> bool {
    if let Some(&v) = memo.get(id) {
        return v;
    }
    // Guard: cycles are impossible with verified ids, but degrade safely (E5).
    memo.insert(id.to_string(), false);
    let result = negators
        .get(id)
        .is_some_and(|ns| ns.iter().any(|nid| !is_negated(nid, negators, memo)));
    memo.insert(id.to_string(), result);
    result
}

/// negated(d, D) per SPEC-2 §4.3, over candidate negations restricted by `trusted` (E4).
fn compute_negated(d: &DeltaSet, trusted: Option<&Pred>) -> BTreeSet<String> {
    let mut negators: HashMap<String, Vec<String>> = HashMap::new();
    for n in d.iter() {
        if let Some(p) = trusted {
            if !eval_pred(p, n) {
                continue;
            }
        }
        for ptr in &n.claims.pointers {
            if ptr.role == "negates" {
                if let Target::Delta(dr) = &ptr.target {
                    negators
                        .entry(dr.delta.clone())
                        .or_default()
                        .push(n.id.clone());
                }
            }
        }
    }
    let mut memo: HashMap<String, bool> = HashMap::new();
    d.iter()
        .filter(|delta| is_negated(&delta.id, &negators, &mut memo))
        .map(|delta| delta.id.clone())
        .collect()
}

pub fn eval_term(term: &Term, input: &DeltaSet) -> EvalResult {
    match term {
        Term::Input => EvalResult {
            set: input.clone(),
            negated: BTreeSet::new(),
            annotated: false,
        },
        Term::Select { pred, of } => {
            let of = eval_term(of, input);
            EvalResult {
                set: fork(&of.set, |d: &Delta| eval_pred(pred, d)),
                negated: BTreeSet::new(),
                annotated: false,
            }
        }
        Term::Union { left, right } => {
            let l = eval_term(left, input);
            let r = eval_term(right, input);
            EvalResult {
                set: merge(&l.set, &r.set),
                negated: BTreeSet::new(),
                annotated: false,
            }
        }
        Term::Mask { policy, of } => {
            let of = eval_term(of, input);
            match policy {
                MaskPolicy::Drop => {
                    let negated = compute_negated(&of.set, None);
                    EvalResult {
                        set: fork(&of.set, |d: &Delta| !negated.contains(&d.id)),
                        negated: BTreeSet::new(),
                        annotated: false,
                    }
                }
                MaskPolicy::Annotate => {
                    let negated = compute_negated(&of.set, None);
                    EvalResult {
                        set: of.set,
                        negated,
                        annotated: true,
                    }
                }
                MaskPolicy::Trust(pred) => {
                    let negated = compute_negated(&of.set, Some(pred));
                    EvalResult {
                        set: fork(&of.set, |d: &Delta| !negated.contains(&d.id)),
                        negated: BTreeSet::new(),
                        annotated: false,
                    }
                }
            }
        }
    }
}

/// Canonical serialization of a DSet-sort result (ERRATA-2 E2): sorted id array, or for a
/// top-level annotate, the map {"ids": [...], "negated": [...]}.
pub fn result_canonical_hex(result: &EvalResult) -> String {
    let ids: Vec<CborValue> = result
        .set
        .ids()
        .into_iter()
        .map(|id| CborValue::Tstr(id.to_string()))
        .collect();
    let bytes = if !result.annotated {
        encode(&CborValue::Array(ids))
    } else {
        let negated: Vec<CborValue> = result
            .negated
            .iter()
            .map(|id| CborValue::Tstr(id.clone()))
            .collect();
        encode(&CborValue::Map(vec![
            ("ids".to_string(), CborValue::Array(ids)),
            ("negated".to_string(), CborValue::Array(negated)),
        ]))
    };
    hex::encode(bytes)
}
