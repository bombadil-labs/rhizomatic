//! Term evaluation: select/union/mask over DSet (SPEC-2 §4.1-4.3), group into HView (§4.4),
//! expand (§4.5), prune (§4.6), fix (§4.8). Mirrors ../ts/src/eval.ts.
//! Sorts are checked at evaluation time (E9); the schema registry is an explicit input (E10).

use std::collections::{BTreeMap, BTreeSet, HashMap};

use crate::cbor::{encode, CborValue};
use crate::hview::{hview_canonical_hex, HVEntry, HView};
use crate::pred::{eval_pred, str_match, Pred, StrMatch};
use crate::schema::SchemaRegistry;
use crate::set::{fork, merge, DeltaSet};
use crate::types::{Delta, Target};

#[derive(Debug, Clone, PartialEq)]
pub enum MaskPolicy {
    Drop,
    Annotate,
    Trust(Pred),
}

#[derive(Debug, Clone, PartialEq)]
pub enum GroupKey {
    ByTargetContext,
    ByRole,
    Const(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum PruneKeep {
    All,
    Match(StrMatch),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Term {
    Input,
    Select {
        pred: Pred,
        of: Box<Term>,
    },
    Union {
        left: Box<Term>,
        right: Box<Term>,
    },
    Mask {
        policy: MaskPolicy,
        of: Box<Term>,
    },
    Group {
        key: GroupKey,
        of: Box<Term>,
    },
    Prune {
        keep: PruneKeep,
        of: Box<Term>,
    },
    Expand {
        role: StrMatch,
        schema: String,
        of: Box<Term>,
    },
    Fix {
        schema: String,
        entity: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum EvalResult {
    DSet {
        set: DeltaSet,
        /// Negation tags from mask(annotate); consumed by group (E7) or surfaced top-level (E2).
        negated: BTreeSet<String>,
        annotated: bool,
    },
    HView(HView),
}

fn dset_result(set: DeltaSet) -> EvalResult {
    EvalResult::DSet {
        set,
        negated: BTreeSet::new(),
        annotated: false,
    }
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
fn compute_negated(d: &DeltaSet, trusted: Option<&Pred>, root: Option<&str>) -> BTreeSet<String> {
    let mut negators: HashMap<String, Vec<String>> = HashMap::new();
    for n in d.iter() {
        if let Some(p) = trusted {
            if !eval_pred(p, n, root) {
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

/// group(key, D) @ root — filing rules per ERRATA-2 E6; annotate tags thread into entries (E7).
fn eval_group(key: &GroupKey, set: &DeltaSet, negated: &BTreeSet<String>, root: &str) -> HView {
    let mut buckets: BTreeMap<String, BTreeMap<String, HVEntry>> = BTreeMap::new();
    let mut file = |prop: &str, d: &Delta| {
        buckets
            .entry(prop.to_string())
            .or_default()
            .entry(d.id.clone())
            .or_insert_with(|| HVEntry {
                delta: d.clone(),
                negated: negated.contains(&d.id),
                expanded: BTreeMap::new(),
            });
    };
    for d in set.iter() {
        if let GroupKey::Const(prop) = key {
            file(prop, d);
            continue;
        }
        for ptr in &d.claims.pointers {
            let Target::Entity(er) = &ptr.target else {
                continue;
            };
            if er.id != root {
                continue;
            }
            match key {
                GroupKey::ByTargetContext => {
                    if let Some(ctx) = &er.context {
                        file(ctx, d);
                    }
                }
                GroupKey::ByRole => file(&ptr.role, d),
                GroupKey::Const(_) => unreachable!("handled above"),
            }
        }
    }
    // BTreeMap iteration is id-sorted already (entries keyed by id).
    let props = buckets
        .into_iter()
        .map(|(prop, bucket)| (prop, bucket.into_values().collect()))
        .collect();
    HView {
        id: root.to_string(),
        props,
    }
}

/// Evaluate a named schema at a root over the SAME delta set the enclosing evaluation received
/// (SPEC-2 §4.5). Termination is the schema DAG's, enforced at registry build (SPEC-3 §3).
fn eval_schema(
    name: &str,
    input: &DeltaSet,
    root: &str,
    registry: Option<&SchemaRegistry>,
) -> Result<HView, String> {
    let registry = registry.ok_or(format!(
        "schema {name} referenced but no registry supplied (E10)"
    ))?;
    let schema = registry
        .get(name)
        .ok_or(format!("unknown schema: {name} (E10)"))?;
    match eval_term(&schema.body, input, Some(root), Some(registry))? {
        EvalResult::HView(h) => Ok(h),
        EvalResult::DSet { .. } => Err(format!(
            "schema {name} body must be an HView-sort term (E10)"
        )),
    }
}

pub fn eval_term(
    term: &Term,
    input: &DeltaSet,
    root: Option<&str>,
    registry: Option<&SchemaRegistry>,
) -> Result<EvalResult, String> {
    fn expect_dset(r: EvalResult, op: &str) -> Result<(DeltaSet, BTreeSet<String>), String> {
        match r {
            EvalResult::DSet { set, negated, .. } => Ok((set, negated)),
            EvalResult::HView(_) => Err(format!("{op} requires a DSet operand (E9)")),
        }
    }
    fn expect_hview(r: EvalResult, op: &str) -> Result<HView, String> {
        match r {
            EvalResult::HView(h) => Ok(h),
            EvalResult::DSet { .. } => Err(format!("{op} requires an HView operand (E9)")),
        }
    }
    match term {
        Term::Input => Ok(dset_result(input.clone())),
        Term::Select { pred, of } => {
            let (set, _) = expect_dset(eval_term(of, input, root, registry)?, "select")?;
            Ok(dset_result(fork(&set, |d: &Delta| {
                eval_pred(pred, d, root)
            })))
        }
        Term::Union { left, right } => {
            let (l, _) = expect_dset(eval_term(left, input, root, registry)?, "union")?;
            let (r, _) = expect_dset(eval_term(right, input, root, registry)?, "union")?;
            Ok(dset_result(merge(&l, &r)))
        }
        Term::Mask { policy, of } => {
            let (set, _) = expect_dset(eval_term(of, input, root, registry)?, "mask")?;
            Ok(match policy {
                MaskPolicy::Drop => {
                    let negated = compute_negated(&set, None, root);
                    dset_result(fork(&set, |d: &Delta| !negated.contains(&d.id)))
                }
                MaskPolicy::Annotate => {
                    let negated = compute_negated(&set, None, root);
                    EvalResult::DSet {
                        set,
                        negated,
                        annotated: true,
                    }
                }
                MaskPolicy::Trust(pred) => {
                    let negated = compute_negated(&set, Some(pred), root);
                    dset_result(fork(&set, |d: &Delta| !negated.contains(&d.id)))
                }
            })
        }
        Term::Group { key, of } => {
            let root = root.ok_or("group requires an ambient root entity (E9)")?;
            let (set, negated) = expect_dset(eval_term(of, input, Some(root), registry)?, "group")?;
            Ok(EvalResult::HView(eval_group(key, &set, &negated, root)))
        }
        Term::Prune { keep, of } => {
            let h = expect_hview(eval_term(of, input, root, registry)?, "prune")?;
            Ok(EvalResult::HView(match keep {
                PruneKeep::All => h,
                PruneKeep::Match(m) => HView {
                    id: h.id,
                    props: h
                        .props
                        .into_iter()
                        .filter(|(prop, _)| str_match(m, prop))
                        .collect(),
                },
            }))
        }
        Term::Expand { role, schema, of } => {
            let h = expect_hview(eval_term(of, input, root, registry)?, "expand")?;
            let mut props: BTreeMap<String, Vec<HVEntry>> = BTreeMap::new();
            for (prop, entries) in h.props {
                let mut out = Vec::with_capacity(entries.len());
                for mut e in entries {
                    for (i, ptr) in e.delta.claims.pointers.iter().enumerate() {
                        // Only role-matching EntityRef pointers expand; everything else passes
                        // through as written (E11, SPEC-3 §7 graceful degradation).
                        let Target::Entity(er) = &ptr.target else {
                            continue;
                        };
                        if !str_match(role, &ptr.role) {
                            continue;
                        }
                        let nested = eval_schema(schema, input, &er.id, registry)?;
                        e.expanded.insert(i, nested);
                    }
                    out.push(e);
                }
                props.insert(prop, out);
            }
            Ok(EvalResult::HView(HView { id: h.id, props }))
        }
        Term::Fix { schema, entity } => {
            // The invocation instruction: ambient root is set to the entity explicitly (E10).
            Ok(EvalResult::HView(eval_schema(
                schema, input, entity, registry,
            )?))
        }
    }
}

/// Canonical serialization of an evaluation result (ERRATA-2 E2, E7).
pub fn result_canonical_hex(result: &EvalResult) -> String {
    match result {
        EvalResult::HView(h) => hview_canonical_hex(h),
        EvalResult::DSet {
            set,
            negated,
            annotated,
        } => {
            let ids: Vec<CborValue> = set
                .ids()
                .into_iter()
                .map(|id| CborValue::Tstr(id.to_string()))
                .collect();
            let bytes = if !annotated {
                encode(&CborValue::Array(ids))
            } else {
                let negated: Vec<CborValue> = negated
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
    }
}
