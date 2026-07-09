//! Term evaluation: select/union/mask over DSet (SPEC-2 §4.1-4.3), group into HView (§4.4),
//! expand (§4.5), prune (§4.6), fix (§4.8). Mirrors ../ts/src/eval.ts.
//! Sorts are checked at evaluation time (E9); the schema registry is an explicit input (E10).

use std::collections::{BTreeMap, BTreeSet, HashMap};

use crate::cbor::{encode, CborValue};
use crate::hview::{hview_canonical_hex, HVEntry, HView};
use crate::policy::{resolve_view, view_canonical_hex, Policy, View};
use crate::pred::{
    eval_pred, pred_contains_in_view, str_match, substitute_holes, Bindings, Cmp, InViewExtract,
    MatchConst, Pred, StrMatch,
};
use crate::schema::SchemaRegistry;
use crate::schema_deltas::VOCAB_PREFIX;
use crate::set::{fork, merge, DeltaSet};
use crate::types::{Delta, Primitive, Target};

#[derive(Debug, Clone, PartialEq)]
pub enum MaskPolicy {
    Drop,
    Annotate,
    Trust(Pred),
}

#[derive(Debug, Clone, PartialEq)]
pub enum SchemaRef {
    Name(String),
    Pinned(String),
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
        schema: SchemaRef,
        of: Box<Term>,
    },
    Fix {
        schema: SchemaRef,
        entity: String,
        bindings: Option<Bindings>,
    },
    Resolve {
        policy: Policy,
        of: Box<Term>,
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
    /// The terminal sort: no operator consumes a View (SPEC-2 §4.7, ERRATA-5 R7).
    View(View),
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

/// closure(A, D) per SPEC-9 §4.1: name → slots → fragments, one hop, computed against the
/// AMBIENT evaluation input. The trust predicate restricts every participant — mappings, slot
/// declarations, and the negations of both — and negation chains are walked within the trusted
/// set only (mask(trust) semantics). The returned closure is sorted by the canonical string
/// order; the name is always a member, so an aliased with no surviving mappings degrades to
/// exact(name).
pub fn alias_closure(
    input: &DeltaSet,
    name: &str,
    via: Option<&str>,
    trust: Option<&Pred>,
    root: Option<&str>,
) -> Vec<String> {
    let negated = compute_negated(input, trust, root);
    let fragment_role = format!("{VOCAB_PREFIX}.alias.fragment");
    let slot_role = format!("{VOCAB_PREFIX}.alias.slot");
    let concept_role = format!("{VOCAB_PREFIX}.alias.concept");
    let mut mappings: Vec<(String, String)> = Vec::new();
    let mut slot_concepts: HashMap<String, BTreeSet<String>> = HashMap::new();
    for d in input.iter() {
        if let Some(p) = trust {
            if !eval_pred(p, d, root) {
                continue;
            }
        }
        if negated.contains(&d.id) {
            continue;
        }
        let mut fragments: Vec<&str> = Vec::new();
        let mut slots: Vec<&str> = Vec::new();
        let mut concepts: Vec<&str> = Vec::new();
        for ptr in &d.claims.pointers {
            if ptr.role == fragment_role {
                if let Target::Primitive(Primitive::Str(s)) = &ptr.target {
                    fragments.push(s);
                }
            } else if ptr.role == slot_role {
                if let Target::Entity(er) = &ptr.target {
                    slots.push(&er.id);
                }
            } else if ptr.role == concept_role {
                if let Target::Entity(er) = &ptr.target {
                    concepts.push(&er.id);
                }
            }
        }
        // Mapping claim: ≥1 fragment × ≥1 slot, cross product (SPEC-9 §3). Anything else with
        // the alias roles is not a mapping and is ignored here (graceful degradation).
        for f in &fragments {
            for s in &slots {
                mappings.push((f.to_string(), s.to_string()));
            }
        }
        // Slot declaration: ≥1 slot × ≥1 concept (SPEC-9 §2).
        for s in &slots {
            for c in &concepts {
                slot_concepts
                    .entry(s.to_string())
                    .or_default()
                    .insert(c.to_string());
            }
        }
    }
    let eligible: Vec<&(String, String)> = mappings
        .iter()
        .filter(|(_, slot)| match via {
            None => true,
            Some(concept) => slot_concepts
                .get(slot)
                .is_some_and(|set| set.contains(concept)),
        })
        .collect();
    let slots_of_name: BTreeSet<&String> = eligible
        .iter()
        .filter(|(fragment, _)| fragment == name)
        .map(|(_, slot)| slot)
        .collect();
    let mut closure: BTreeSet<String> = BTreeSet::new();
    closure.insert(name.to_string());
    for (fragment, slot) in &eligible {
        if slots_of_name.contains(slot) {
            closure.insert(fragment.clone());
        }
    }
    // BTreeSet iteration is bytewise UTF-8 order — the canonical string order (E3).
    closure.into_iter().collect()
}

/// Expand an aliased StrMatch to its InSet form against the ambient input; other forms pass.
fn expand_str_match(m: &StrMatch, input: &DeltaSet, root: Option<&str>) -> StrMatch {
    match m {
        StrMatch::Aliased(a) => StrMatch::InSet(alias_closure(
            input,
            &a.name,
            a.via.as_deref(),
            a.trust.as_ref(),
            root,
        )),
        _ => m.clone(),
    }
}

/// Expand every aliased StrMatch in a predicate (ppred role/context) against the ambient input.
/// Applied where predicates meet data (select / mask-trust), after hole substitution (SPEC-9
/// §4.1).
pub fn expand_aliased(pred: &Pred, input: &DeltaSet, root: Option<&str>) -> Pred {
    match pred {
        Pred::True | Pred::False | Pred::Match { .. } => pred.clone(),
        Pred::HasPointer(pp) => {
            let mut out = pp.clone();
            if let Some(m) = &pp.role {
                out.role = Some(expand_str_match(m, input, root));
            }
            if let Some(m) = &pp.context {
                out.context = Some(expand_str_match(m, input, root));
            }
            Pred::HasPointer(out)
        }
        Pred::And(l, r) => Pred::And(
            Box::new(expand_aliased(l, input, root)),
            Box::new(expand_aliased(r, input, root)),
        ),
        Pred::Or(l, r) => Pred::Or(
            Box::new(expand_aliased(l, input, root)),
            Box::new(expand_aliased(r, input, root)),
        ),
        Pred::Not(p) => Pred::Not(Box::new(expand_aliased(p, input, root))),
        // Aliased matches inside the sub-term expand during its own evaluation.
        Pred::InView { .. } => pred.clone(),
    }
}

// --- reflective predicates (SPEC-2 §3.1) ----------------------------------------------------------

/// The reflected string set: extract a facet from every delta of the sub-view.
fn extract_reflected(extract: &InViewExtract, set: &DeltaSet) -> Vec<Primitive> {
    let mut out: BTreeSet<String> = BTreeSet::new();
    for d in set.iter() {
        match extract {
            InViewExtract::Author => {
                out.insert(d.claims.author.clone());
            }
            InViewExtract::Id => {
                out.insert(d.id.clone());
            }
            InViewExtract::Role(role) => {
                for ptr in &d.claims.pointers {
                    if &ptr.role != role {
                        continue;
                    }
                    match &ptr.target {
                        Target::Entity(er) => {
                            out.insert(er.id.clone());
                        }
                        Target::Delta(dr) => {
                            out.insert(dr.delta.clone());
                        }
                        Target::Primitive(Primitive::Str(s)) => {
                            out.insert(s.clone());
                        }
                        Target::Primitive(_) => {}
                    }
                }
            }
        }
    }
    // BTreeSet<String> iterates in bytewise UTF-8 order — the canonical string order (E3).
    out.into_iter().map(Primitive::Str).collect()
}

/// Lower every inView to its InSet form: evaluate the sub-term against the AMBIENT input (not the
/// enclosing operator's operand — a grant landing anywhere may flip a negation's standing), once
/// per operator application. Applied where predicates meet data (select / mask-trust), beside hole
/// substitution and alias expansion. The lowered predicate is inside the SPEC-2 §3 fragment.
fn resolve_reflective(
    pred: &Pred,
    input: &DeltaSet,
    root: Option<&str>,
    registry: Option<&SchemaRegistry>,
    bindings: Option<&Bindings>,
) -> Result<Pred, String> {
    Ok(match pred {
        Pred::InView {
            term,
            field,
            extract,
        } => {
            let set = match eval_term(term, input, root, registry, bindings)? {
                EvalResult::DSet { set, .. } => set,
                _ => return Err("inView.term must evaluate to a DSet (E9)".to_string()),
            };
            Pred::Match {
                field: *field,
                cmp: Cmp::InSet,
                constant: MatchConst::Many(extract_reflected(extract, &set)),
            }
        }
        Pred::And(l, r) => Pred::And(
            Box::new(resolve_reflective(l, input, root, registry, bindings)?),
            Box::new(resolve_reflective(r, input, root, registry, bindings)?),
        ),
        Pred::Or(l, r) => Pred::Or(
            Box::new(resolve_reflective(l, input, root, registry, bindings)?),
            Box::new(resolve_reflective(r, input, root, registry, bindings)?),
        ),
        Pred::Not(p) => Pred::Not(Box::new(resolve_reflective(
            p, input, root, registry, bindings,
        )?)),
        _ => pred.clone(),
    })
}

/// Any inView anywhere in the term? Parse-time stratification and the reactor's conservative
/// dispatch (SPEC-4 §4.1) both hang off this walk. Schema bodies referenced by expand/fix are
/// the caller's concern (the reactor walks its registry; the parser rejects per-body).
pub fn term_contains_in_view(t: &Term) -> bool {
    match t {
        Term::Input | Term::Fix { .. } => false,
        Term::Select { pred, of } => pred_contains_in_view(pred) || term_contains_in_view(of),
        Term::Union { left, right } => term_contains_in_view(left) || term_contains_in_view(right),
        Term::Mask { policy, of } => {
            let trust_reflective = match policy {
                MaskPolicy::Trust(p) => pred_contains_in_view(p),
                _ => false,
            };
            trust_reflective || term_contains_in_view(of)
        }
        Term::Group { of, .. }
        | Term::Prune { of, .. }
        | Term::Expand { of, .. }
        | Term::Resolve { of, .. } => term_contains_in_view(of),
    }
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
    schema_ref: &SchemaRef,
    input: &DeltaSet,
    root: &str,
    registry: Option<&SchemaRegistry>,
    bindings: Option<&Bindings>,
) -> Result<HView, String> {
    let label = match schema_ref {
        SchemaRef::Name(n) => n.clone(),
        SchemaRef::Pinned(h) => format!("pinned:{}", &h[..h.len().min(16)]),
    };
    let registry = registry.ok_or(format!(
        "schema {label} referenced but no registry supplied (E10)"
    ))?;
    let schema = registry
        .resolve(schema_ref)
        .ok_or(format!("unknown schema: {label} (E10/E13)"))?;
    match eval_term(&schema.body, input, Some(root), Some(registry), bindings)? {
        EvalResult::HView(h) => Ok(h),
        _ => Err(format!(
            "schema {label} body must be an HView-sort term (E10)"
        )),
    }
}

pub fn eval_term(
    term: &Term,
    input: &DeltaSet,
    root: Option<&str>,
    registry: Option<&SchemaRegistry>,
    bindings: Option<&Bindings>,
) -> Result<EvalResult, String> {
    fn expect_dset(r: EvalResult, op: &str) -> Result<(DeltaSet, BTreeSet<String>), String> {
        match r {
            EvalResult::DSet { set, negated, .. } => Ok((set, negated)),
            _ => Err(format!("{op} requires a DSet operand (E9)")),
        }
    }
    fn expect_hview(r: EvalResult, op: &str) -> Result<HView, String> {
        match r {
            EvalResult::HView(h) => Ok(h),
            _ => Err(format!("{op} requires an HView operand (E9)")),
        }
    }
    match term {
        Term::Input => Ok(dset_result(input.clone())),
        Term::Select { pred, of } => {
            let (set, _) = expect_dset(eval_term(of, input, root, registry, bindings)?, "select")?;
            let pred = resolve_reflective(
                &expand_aliased(&substitute_holes(pred, bindings)?, input, root),
                input,
                root,
                registry,
                bindings,
            )?;
            Ok(dset_result(fork(&set, |d: &Delta| {
                eval_pred(&pred, d, root)
            })))
        }
        Term::Union { left, right } => {
            let (l, _) = expect_dset(eval_term(left, input, root, registry, bindings)?, "union")?;
            let (r, _) = expect_dset(eval_term(right, input, root, registry, bindings)?, "union")?;
            Ok(dset_result(merge(&l, &r)))
        }
        Term::Mask { policy, of } => {
            let (set, _) = expect_dset(eval_term(of, input, root, registry, bindings)?, "mask")?;
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
                    let pred = resolve_reflective(
                        &expand_aliased(&substitute_holes(pred, bindings)?, input, root),
                        input,
                        root,
                        registry,
                        bindings,
                    )?;
                    let negated = compute_negated(&set, Some(&pred), root);
                    dset_result(fork(&set, |d: &Delta| !negated.contains(&d.id)))
                }
            })
        }
        Term::Group { key, of } => {
            let root = root.ok_or("group requires an ambient root entity (E9)")?;
            let (set, negated) = expect_dset(
                eval_term(of, input, Some(root), registry, bindings)?,
                "group",
            )?;
            Ok(EvalResult::HView(eval_group(key, &set, &negated, root)))
        }
        Term::Prune { keep, of } => {
            let h = expect_hview(eval_term(of, input, root, registry, bindings)?, "prune")?;
            Ok(EvalResult::HView(match keep {
                PruneKeep::All => h,
                PruneKeep::Match(m) => {
                    let m = expand_str_match(m, input, root);
                    HView {
                        id: h.id,
                        props: h
                            .props
                            .into_iter()
                            .filter(|(prop, _)| str_match(&m, prop))
                            .collect(),
                    }
                }
            }))
        }
        Term::Expand { role, schema, of } => {
            let h = expect_hview(eval_term(of, input, root, registry, bindings)?, "expand")?;
            let role = expand_str_match(role, input, root);
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
                        if !str_match(&role, &ptr.role) {
                            continue;
                        }
                        let nested = eval_schema(schema, input, &er.id, registry, bindings)?;
                        e.expanded.insert(i, nested);
                    }
                    out.push(e);
                }
                props.insert(prop, out);
            }
            Ok(EvalResult::HView(HView { id: h.id, props }))
        }
        Term::Fix {
            schema,
            entity,
            bindings: fix_bindings,
        } => {
            // The invocation instruction: ambient root is set explicitly (E10); bindings, when
            // present, become the ambient hole environment for the invoked body (E15).
            Ok(EvalResult::HView(eval_schema(
                schema,
                input,
                entity,
                registry,
                fix_bindings.as_ref().or(bindings),
            )?))
        }
        Term::Resolve { policy, of } => {
            let h = expect_hview(eval_term(of, input, root, registry, bindings)?, "resolve")?;
            Ok(EvalResult::View(resolve_view(policy, &h)))
        }
    }
}

/// Canonical serialization of an evaluation result (ERRATA-2 E2, E7).
pub fn result_canonical_hex(result: &EvalResult) -> String {
    match result {
        EvalResult::View(v) => view_canonical_hex(v),
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
